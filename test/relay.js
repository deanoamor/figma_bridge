// Two server instances on one port (as Claude Desktop does): the second must relay
// through the first, and take over the port if the first goes away.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import assert from "node:assert/strict";

const PORT = 3966;
const env = { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_TIMEOUT_MS: "3000" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startInstance(name) {
  const transport = new StdioClientTransport({ command: "node", args: ["server/index.js"], env, stderr: "pipe" });
  let logs = "";
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  transport.stderr?.on("data", (d) => (logs += d));
  return { client, transport, logs: () => logs };
}
const call = async (inst, name, args = {}) => {
  const r = await inst.client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text };
};

const A = await startInstance("A");
await sleep(600);
const B = await startInstance("B"); // loses the port race -> relay mode
await sleep(800);

// the Figma plugin connects (to whichever instance owns the port: A)
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "hello" }));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  ws.send(JSON.stringify({ id: m.id, ok: true, result: { echo: m.command, params: m.params } }));
});
await sleep(300);

// both instances can reach the plugin, including the relay one (B)
let r = await call(A, "figma_status");
assert.equal(r.isError, false); assert.equal(JSON.parse(r.text).echo, "status");
r = await call(B, "figma_status");
assert.equal(r.isError, false, r.text); assert.equal(JSON.parse(r.text).echo, "status");
r = await call(B, "figma_create", { spec: { type: "FRAME", name: "X" }, parentId: "1:1" });
assert.equal(r.isError, false, r.text);
assert.equal(JSON.parse(r.text).params.spec.name, "X");
console.log("ok: relay instance reaches the plugin");

// errors are relayed too (plugin answers with ok:false)
ws.removeAllListeners("message");
ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); ws.send(JSON.stringify({ id: m.id, ok: false, error: "boom" })); });
r = await call(B, "figma_status");
assert.equal(r.isError, true); assert.match(r.text, /boom/);
console.log("ok: relayed plugin error");

// plugin disconnects -> both report not connected
ws.close(); await sleep(300);
for (const inst of [A, B]) {
  r = await call(inst, "figma_status");
  assert.equal(r.isError, true); assert.match(r.text, /not connected/);
}
console.log("ok: both report not-connected after plugin leaves");

// primary (A) exits -> B takes over the port and works with a new plugin connection
await A.client.close();
await sleep(2500);
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((res, rej) => { ws2.on("open", res); ws2.on("error", rej); });
ws2.send(JSON.stringify({ type: "hello" }));
ws2.on("message", (raw) => { const m = JSON.parse(raw.toString()); ws2.send(JSON.stringify({ id: m.id, ok: true, result: { echo: m.command } })); });
await sleep(300);
r = await call(B, "figma_status");
assert.equal(r.isError, false, r.text); assert.equal(JSON.parse(r.text).echo, "status");
console.log("ok: relay instance took over after primary exit");

ws2.close();
await B.client.close();
console.log("\nRELAY TESTS PASSED");
process.exit(0);
