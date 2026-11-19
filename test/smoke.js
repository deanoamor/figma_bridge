// Smoke test: MCP client -> server -> fake plugin over WebSocket.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  "figma_apply_text_styles", "figma_arrange_variants", "figma_boolean", "figma_clone", "figma_combine_variants", "figma_create", "figma_create_effect_style", "figma_create_instance", "figma_create_text_style", "figma_create_variable", "figma_create_variables", "figma_delete", "figma_export", "figma_get_node", "figma_get_selection", "figma_get_slots", "figma_import_html", "figma_list_children", "figma_list_styles", "figma_list_variables", "figma_rebind_variables", "figma_select", "figma_set_slot", "figma_status", "figma_update",
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
  if (m.command === "export" && m.params.format === "SVG") {
    return ws.send(JSON.stringify({ id: m.id, ok: true, result: { svg: '<svg width="10" height="10"><path d="M0 0"/></svg>', name: "OVO", width: 10, height: 10 } }));
  }
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

r = await client.callTool({ name: "figma_list_variables", arguments: {} });
assert.equal(JSON.parse(r.content[0].text).echo, "list_variables");
console.log("ok: list_variables");

r = await client.callTool({ name: "figma_create_variable", arguments: { collection: "light", name: "success-subtle", type: "COLOR", value: { color: "light/success", opacity: 14 } } });
assert.deepEqual(JSON.parse(r.content[0].text).params.value, { color: "light/success", opacity: 14 });
console.log("ok: create_variable");

r = await client.callTool({ name: "figma_create_instance", arguments: { id: "1:3", variant: { variant: "outline" }, props: { x: 5 } } });
assert.deepEqual(JSON.parse(r.content[0].text).params.variant, { variant: "outline" });
r = await client.callTool({ name: "figma_create_effect_style", arguments: { name: "elevation/2", effects: [{ type: "DROP_SHADOW", y: 8, blur: 24 }] } });
assert.equal(JSON.parse(r.content[0].text).params.name, "elevation/2");
r = await client.callTool({ name: "figma_list_styles", arguments: {} });
assert.equal(JSON.parse(r.content[0].text).echo, "list_styles");
console.log("ok: create_instance, create_effect_style, list_styles");

r = await client.callTool({ name: "figma_create_text_style", arguments: { name: "text/sm", fontFamily: "Geist", fontSize: 14, bind: { fontSize: "core/font-size/sm" } } });
assert.equal(JSON.parse(r.content[0].text).params.name, "text/sm");
console.log("ok: create_text_style");

r = await client.callTool({ name: "figma_arrange_variants", arguments: { id: "1:3", rows: ["variant"], columns: ["size"], gapX: 16 } });
assert.deepEqual(JSON.parse(r.content[0].text).params, { id: "1:3", rows: ["variant"], columns: ["size"], gapX: 16 });
console.log("ok: arrange_variants");

r = await client.callTool({ name: "figma_export", arguments: { id: "1:3", scale: 2 } });
assert.equal(r.content[0].type, "image");
assert.equal(r.content[0].mimeType, "image/png");
console.log("ok: export returns image");

// SVG export: text comes back as text, savePath writes a file, bad combinations are rejected
r = await client.callTool({ name: "figma_export", arguments: { id: "1:3", format: "SVG" } });
assert.notEqual(r.isError, true);
assert.ok(r.content.every((c) => c.type === "text"));
assert.match(r.content.map((c) => c.text).join("\n"), /<svg width="10"/);
const svgDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-svg-"));
const svgPath = path.join(svgDir, "nested", "ovo.svg");
r = await client.callTool({ name: "figma_export", arguments: { id: "1:3", format: "SVG", savePath: svgPath } });
assert.notEqual(r.isError, true, r.content[0].text);
assert.match(fs.readFileSync(svgPath, "utf8"), /^<svg/);
assert.match(r.content[0].text, /ovo\.svg/);
r = await client.callTool({ name: "figma_export", arguments: { id: "1:3", format: "SVG", savePath: path.join(svgDir, "x.png") } });
assert.equal(r.isError, true); assert.match(r.content[0].text, /\.svg/);
r = await client.callTool({ name: "figma_export", arguments: { id: "1:3", format: "PNG", savePath: svgPath } });
assert.equal(r.isError, true);
fs.rmSync(svgDir, { recursive: true, force: true });
console.log("ok: export SVG + savePath");

// index and list_children pass through
r = await client.callTool({ name: "figma_create", arguments: { spec: { type: "TEXT", characters: "h" }, parentId: "1:2", index: 2 } });
assert.equal(JSON.parse(r.content[0].text).params.index, 2);
r = await client.callTool({ name: "figma_clone", arguments: { id: "1:3", index: 0 } });
assert.equal(JSON.parse(r.content[0].text).params.index, 0);
r = await client.callTool({ name: "figma_list_children", arguments: { pageName: "Web Flow" } });
assert.equal(JSON.parse(r.content[0].text).echo, "list_children");
assert.equal(JSON.parse(r.content[0].text).params.pageName, "Web Flow");
console.log("ok: index + list_children pass through");

// boolean + create_variables pass through; bad input is rejected by the schema before reaching Figma
r = await client.callTool({ name: "figma_boolean", arguments: { operation: "SUBTRACT", ids: ["1:3", "1:4"], flatten: true, name: "Mark" } });
assert.deepEqual(JSON.parse(r.content[0].text).params, { operation: "SUBTRACT", ids: ["1:3", "1:4"], flatten: true, name: "Mark" });
const seenBefore = seen.length;
r = await client.callTool({ name: "figma_boolean", arguments: { operation: "MERGE", ids: ["1:3", "1:4"] } });
assert.equal(r.isError, true);
r = await client.callTool({ name: "figma_boolean", arguments: { operation: "UNION", ids: ["1:3"] } });
assert.equal(r.isError, true);
assert.equal(seen.length, seenBefore, "invalid boolean calls never reach the plugin");
const tokenSpec = { collections: [{ name: "theme", modes: ["Light", "Dark"], variables: [{ name: "primary", type: "COLOR", values: { Light: { alias: "core/blue" }, Dark: "#60A5FA" } }] }] };
r = await client.callTool({ name: "figma_create_variables", arguments: tokenSpec });
assert.notEqual(r.isError, true, r.content[0].text);
assert.deepEqual(JSON.parse(r.content[0].text).params, tokenSpec); // alias objects survive the schema
r = await client.callTool({ name: "figma_create_variables", arguments: { collections: [] } });
assert.equal(r.isError, true);
console.log("ok: boolean + create_variables pass through");

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
