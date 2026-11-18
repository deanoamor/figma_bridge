// Server side of figma_import_html: file reading, stylesheet inlining, image loading, dry run, errors.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const PORT = 3956;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-html-"));
const site = path.join(root, "site");
fs.mkdirSync(path.join(site, "css"), { recursive: true });
fs.mkdirSync(path.join(site, "img"), { recursive: true });
fs.writeFileSync(path.join(site, "img", "hero.png"), PNG);
fs.writeFileSync(path.join(root, "secret.png"), PNG); // outside the site folder
fs.writeFileSync(path.join(site, "css", "style.css"), `.hero{background:url(../img/hero.png)} .x{background:url("data:image/png;base64,AAAA")} .y{background:url(https://cdn.example/a.png)}`);
fs.writeFileSync(path.join(site, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="css/style.css"><link rel="stylesheet" href="../secret.css"><link rel="stylesheet" href="missing.css"><link rel="icon" href="x.ico"></head><body><div class="hero">Hi</div></body></html>`);

const transport = new StdioClientTransport({ command: "node", args: ["server/index.js"], env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT) }, stderr: "ignore" });
const client = new Client({ name: "html", version: "1.0.0" });
await client.connect(transport);

const received = [];
let converted = null;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello" }));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  received.push(m);
  if (m.command === "html_to_spec") return ws.send(JSON.stringify({ id: m.id, ok: true, result: converted(m.params) }));
  if (m.command === "create") return ws.send(JSON.stringify({ id: m.id, ok: true, result: { rootId: "9:1", created: [{ id: "9:1" }, { id: "9:2" }], fontSubstitutions: ["Poppins Semi Bold -> Inter Regular"] } }));
  ws.send(JSON.stringify({ id: m.id, ok: true, result: {} }));
});
await new Promise((r) => setTimeout(r, 200));

const call = async (args) => {
  const r = await client.callTool({ name: "figma_import_html", arguments: args });
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
};
const cmds = () => received.map((m) => m.command);
const lastOf = (c) => [...received].reverse().find((m) => m.command === c).params;

// spec as the plugin window would return it
converted = () => ({
  spec: {
    type: "FRAME", name: "page", children: [
      { type: "RECTANGLE", fills: [{ type: "IMAGE", path: "img/hero.png", scaleMode: "FILL" }] },
      { type: "RECTANGLE", fills: ["#FFFFFF", { type: "IMAGE", path: "img/missing.png" }] },
      { type: "RECTANGLE", fills: [{ type: "IMAGE", path: "../secret.png" }] },
      { type: "RECTANGLE", fills: [{ type: "IMAGE", base64: "data:image/png;base64," + PNG.toString("base64") }] },
      { type: "RECTANGLE", fills: [{ type: "IMAGE", path: path.join(root, "secret.png") }] },
    ],
  },
  warnings: ["from the plugin"], stats: { frames: 1 },
});

// 1) htmlPath: stylesheets inlined, relative urls rewritten, images loaded, placeholders for bad ones
let r = await call({ htmlPath: path.join(site, "index.html"), width: 1200, name: "Home", parentId: "1:2", index: 0, animate: false });
assert.equal(r.isError, false, r.text);
const sent = lastOf("html_to_spec");
assert.match(sent.html, /<style>\/\* css\/style\.css \*\/\n\.hero\{background:url\("img\/hero\.png"\)\}/, "css inlined, url made relative to the html folder");
assert.match(sent.html, /url\("data:image\/png;base64,AAAA"\)/, "data: urls untouched");
assert.match(sent.html, /url\(https:\/\/cdn\.example\/a\.png\)/, "http urls untouched");
assert.match(sent.html, /<link rel="stylesheet" href="\.\.\/secret\.css">/, "a stylesheet outside the folder is not read");
assert.equal(sent.width, 1200); assert.equal(sent.name, "Home");
const made = lastOf("create");
assert.equal(made.parentId, "1:2"); assert.equal(made.index, 0); assert.equal(made.animate, false); assert.equal(made.fallbackFont, "Inter");
const kids = made.spec.children;
assert.equal(kids[0].fills[0].base64, PNG.toString("base64")); assert.equal(kids[0].fills[0].path, undefined); assert.equal(kids[0].fills[0].scaleMode, "FILL");
assert.deepEqual(kids[1].fills, ["#FFFFFF", "#E5E7EB"], "a missing image becomes a grey placeholder");
assert.deepEqual(kids[2].fills, ["#E5E7EB"], "paths outside the html folder are refused");
assert.equal(kids[3].fills[0].base64, PNG.toString("base64"));
assert.equal(kids[4].fills[0].base64, PNG.toString("base64"), "absolute paths work");
assert.equal(r.json.rootId, "9:1"); assert.equal(r.json.nodesCreated, 2);
assert.deepEqual(r.json.fontSubstitutions, ["Poppins Semi Bold -> Inter Regular"]);
assert.ok(r.json.warnings.includes("from the plugin"));
assert.ok(r.json.warnings.some((w) => /missing\.css/.test(w)), "unreadable stylesheet reported");
assert.ok(r.json.warnings.some((w) => /\.\.\/secret\.css.*outside the HTML folder/.test(w)));
assert.ok(r.json.warnings.some((w) => /img\/missing\.png/.test(w) && /placeholder/.test(w)));
assert.ok(r.json.warnings.some((w) => /\.\.\/secret\.png.*outside the HTML folder/.test(w)));
console.log("ok: htmlPath, stylesheets, images, placeholders");

// 2) html string: relative image paths need a baseDir
received.length = 0;
r = await call({ html: "<div>x</div>", dryRun: false });
assert.equal(r.isError, false, r.text);
assert.ok(r.json.warnings.some((w) => /relative path and no baseDir/.test(w)));
assert.equal(lastOf("html_to_spec").html, "<div>x</div>");
r = await call({ html: "<div>x</div>", baseDir: site, fallbackFont: "", select: false });
assert.equal(lastOf("create").spec.children[0].fills[0].base64, PNG.toString("base64"), "baseDir resolves relative paths");
assert.equal(lastOf("create").fallbackFont, undefined, "empty fallbackFont turns the fallback off");
assert.equal(lastOf("create").select, false);
console.log("ok: html string with and without baseDir");

// 3) dryRun creates nothing
received.length = 0;
r = await call({ html: "<p>x</p>", baseDir: site, dryRun: true });
assert.equal(r.isError, false, r.text);
assert.ok(!cmds().includes("create"));
assert.equal(r.json.spec.type, "FRAME"); assert.deepEqual(r.json.stats, { frames: 1 });
assert.equal(r.json.spec.children[0].fills[0].base64, PNG.toString("base64"));
console.log("ok: dryRun");

// 4) errors
received.length = 0;
for (const [args, re] of [
  [{}, /exactly one of html or htmlPath/],
  [{ html: "<p>x</p>", htmlPath: "x.html" }, /exactly one/],
  [{ htmlPath: path.join(site, "nope.html") }, /HTML file not found/],
  [{ htmlPath: site }, /Not a file/],
  [{ html: "   " }, /HTML is empty/],
  [{ html: "<p>" + "x".repeat(3 * 1024 * 1024 + 10) + "</p>" }, /too large/],
]) {
  r = await call(args);
  assert.equal(r.isError, true, JSON.stringify(args).slice(0, 60)); assert.match(r.text, re);
}
assert.equal(received.length, 0, "nothing is sent to Figma for invalid input");
r = await client.callTool({ name: "figma_import_html", arguments: { html: "<p>x</p>", width: 20 } });
assert.equal(r.isError, true, "width below the minimum is rejected by the schema");
converted = () => { throw new Error("unused"); };
ws.removeAllListeners("message");
ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); ws.send(JSON.stringify({ id: m.id, ok: false, error: "selector \"#x\" matches nothing in the HTML" })); });
r = await call({ html: "<p>x</p>", selector: "#x" });
assert.equal(r.isError, true); assert.match(r.text, /matches nothing/, "converter errors reach the caller");
console.log("ok: errors");

ws.close();
await client.close();
fs.rmSync(root, { recursive: true, force: true });
console.log("\nIMPORT HTML TESTS PASSED");
process.exit(0);
