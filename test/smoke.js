// Smoke test: MCP client -> server -> fake plugin over WebSocket.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import assert from "node:assert/strict";

const PORT = 3977;
const transport = new StdioClientTransport({
  command: "node",
  args: ["server/index.js"],
  env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_TIMEOUT_MS: "3000" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log("tools:", tools.join(", "));
assert.deepEqual(tools, [
  "figma_clone", "figma_combine_variants", "figma_create", "figma_delete", "figma_export", "figma_get_node",
  "figma_get_selection", "figma_get_slots", "figma_rebind_variables", "figma_select", "figma_set_slot", "figma_status", "figma_update",
]);

// 1) no plugin connected -> clear error
let r = await client.callTool({ name: "figma_status", arguments: {} });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /not connected/);
console.log("ok: not-connected error");

// 2) connect a fake plugin
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((res) => ws.on("open", res));
ws.send(JSON.stringify({ type: "hello" }));
const seen = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  seen.push(m);
  if (m.command === "export") {
    return ws.send(JSON.stringify({ id: m.id, ok: true, result: { base64: "iVBORw0KGgo=", mimeType: "image/png", name: "Card", width: 10, height: 10 } }));
  }
  if (m.command === "delete") {
    return ws.send(JSON.stringify({ id: m.id, ok: false, error: "boom" }));
  }
  ws.send(JSON.stringify({ id: m.id, ok: true, result: { echo: m.command, params: m.params } }));
});
await new Promise((r) => setTimeout(r, 200));

r = await client.callTool({ name: "figma_status", arguments: {} });
assert.notEqual(r.isError, true);
assert.equal(JSON.parse(r.content[0].text).echo, "status");
console.log("ok: status");

const spec = { type: "FRAME", name: "Card", layoutMode: "VERTICAL", children: [{ type: "TEXT", characters: "Hi" }] };
r = await client.callTool({ name: "figma_create", arguments: { spec, parentId: "1:2" } });
const created = JSON.parse(r.content[0].text);
assert.equal(created.echo, "create");
assert.deepEqual(created.params.spec, spec); // nested spec passes through untouched
assert.equal(created.params.parentId, "1:2");
console.log("ok: create passes nested spec");

r = await client.callTool({ name: "figma_update", arguments: { id: "1:3", props: { fills: "#FF0000" } } });
assert.equal(JSON.parse(r.content[0].text).params.props.fills, "#FF0000");
console.log("ok: update");

r = await client.callTool({ name: "figma_combine_variants", arguments: { ids: ["1:3", "1:4"], name: "Button" } });
assert.equal(JSON.parse(r.content[0].text).echo, "combine_variants");
assert.deepEqual(JSON.parse(r.content[0].text).params.ids, ["1:3", "1:4"]);
console.log("ok: combine_variants");

r = await client.callTool({ name: "figma_rebind_variables", arguments: { id: "1:3", from: "light", to: "dark", name: "Button / dark" } });
assert.deepEqual(JSON.parse(r.content[0].text).params, { id: "1:3", from: "light", to: "dark", name: "Button / dark" });
console.log("ok: rebind_variables");

r = await client.callTool({ name: "figma_export", arguments: { id: "1:3", scale: 2 } });
assert.equal(r.content[0].type, "image");
assert.equal(r.content[0].mimeType, "image/png");
console.log("ok: export returns image");

r = await client.callTool({ name: "figma_delete", arguments: { ids: ["1:3"] } });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /boom/);
console.log("ok: plugin error propagates");

// 3) timeout when plugin never answers
ws.removeAllListeners("message");
r = await client.callTool({ name: "figma_get_node", arguments: {} });
assert.equal(r.isError, true);
assert.match(r.content[0].text, /Timed out/);
console.log("ok: timeout");

// 4) disconnect -> not connected again
ws.close();
await new Promise((r) => setTimeout(r, 200));
r = await client.callTool({ name: "figma_status", arguments: {} });
assert.equal(r.isError, true);
console.log("ok: disconnect detected");

await client.close();
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
