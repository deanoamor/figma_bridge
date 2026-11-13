// Server side of image fills: url/path -> base64, validation, caching, nested specs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORT = 3955;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

// local file server
let hits = 0;
const web = http.createServer((req, res) => {
  hits++;
  if (req.url === "/a.png") { res.setHeader("content-type", "image/png"); return res.end(PNG); }
  if (req.url === "/page.html") { res.setHeader("content-type", "text/html"); return res.end("<html>not an image</html>"); }
  res.statusCode = 404; res.end("nope");
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${web.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-img-"));
fs.writeFileSync(path.join(dir, "photo.png"), PNG);
fs.writeFileSync(path.join(dir, "photo.jpg"), JPG);
fs.writeFileSync(path.join(dir, "notes.txt"), "just text");
fs.writeFileSync(path.join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));

const transport = new StdioClientTransport({
  command: "node", args: ["server/index.js"],
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_MAX_IMAGE_MB: "1" },
  stderr: "ignore",
});
const client = new Client({ name: "img", version: "1.0.0" });
await client.connect(transport);

const received = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello" }));
ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); received.push(m); ws.send(JSON.stringify({ id: m.id, ok: true, result: { ok: true } })); });
await new Promise((r) => setTimeout(r, 200));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text };
};
const last = () => received[received.length - 1].params;

// local path (PNG + JPEG), nested inside children
let r = await call("figma_create", {
  spec: {
    type: "FRAME", name: "Card",
    children: [
      { type: "RECTANGLE", fills: [{ type: "IMAGE", path: path.join(dir, "photo.png"), scaleMode: "FIT" }] },
      { type: "RECTANGLE", fills: [{ type: "IMAGE", path: path.join(dir, "photo.jpg") }, "#00000033"] },
    ],
  },
});
assert.equal(r.isError, false, r.text);
const kids = last().spec.children;
assert.equal(kids[0].fills[0].base64, PNG.toString("base64"));
assert.equal(kids[0].fills[0].scaleMode, "FIT");
assert.equal(kids[0].fills[0].path, undefined, "path must not leak to the plugin");
assert.equal(kids[1].fills[0].base64, JPG.toString("base64"));
assert.equal(kids[1].fills[1], "#00000033", "other fills untouched");
console.log("ok: local PNG/JPEG paths, nested children");

// url + cache (same url used twice -> downloaded once)
hits = 0;
r = await call("figma_update", { id: "1:1", props: { fills: [{ type: "IMAGE", url: `${base}/a.png` }, { type: "IMAGE", url: `${base}/a.png`, opacity: 0.5 }] } });
assert.equal(r.isError, false, r.text);
assert.equal(last().props.fills[0].base64, PNG.toString("base64"));
assert.equal(last().props.fills[1].opacity, 0.5);
assert.equal(hits, 1, "same URL downloaded once per call");
console.log("ok: url download + per-call cache");

// params without images and non-image objects are passed through untouched
r = await call("figma_update", { id: "1:1", props: { fills: "#FF0000", characters: "IMAGE", name: "x" } });
assert.equal(r.isError, false, r.text);
assert.equal(last().props.fills, "#FF0000");
console.log("ok: other params unchanged");

// errors
const bad = async (fill, re, label) => {
  const before = received.length;
  const x = await call("figma_create", { spec: { type: "RECTANGLE", fills: [fill] } });
  assert.equal(x.isError, true, label + ": should fail");
  assert.match(x.text, re, label);
  assert.equal(received.length, before, label + ": nothing may reach the plugin");
};
await bad({ type: "IMAGE", path: path.join(dir, "missing.png") }, /not found/, "missing file");
await bad({ type: "IMAGE", path: path.join(dir, "notes.txt") }, /Unsupported image format/, "text file");
await bad({ type: "IMAGE", path: dir }, /Not a file/, "directory");
await bad({ type: "IMAGE", path: path.join(dir, "big.png") }, /too large/, "too big");
await bad({ type: "IMAGE", url: `${base}/page.html` }, /Unsupported image format/, "html page");
await bad({ type: "IMAGE", url: `${base}/gone.png` }, /HTTP 404/, "404");
await bad({ type: "IMAGE", url: "http://127.0.0.1:1/x.png" }, /Could not download/, "unreachable");
console.log("ok: errors are clear and nothing is sent to Figma");

ws.close();
await client.close();
web.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("\nIMAGE TESTS PASSED");
process.exit(0);
