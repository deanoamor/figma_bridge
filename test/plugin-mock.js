// Runs plugin/code.js against a tiny fake of the Figma API to catch logic errors.
import vm from "node:vm";
import fs from "node:fs";
import assert from "node:assert/strict";

let idc = 0;
const mixed = Symbol("mixed");
const opacityLog = []; // every opacity write: { id, v }
class Node {
  get opacity() { return this._o; }
  set opacity(v) { this._o = v; opacityLog.push({ id: this.id, v }); }
  constructor(type) {
    this.id = `1:${++idc}`; this.type = type; this.name = type; this.parent = null;
    this.x = 0; this.y = 0; this.width = 100; this.height = 100; this._o = 1; this.rotation = 0;
    this.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; this.strokes = []; this.strokeWeight = 1;
    this.effects = []; this.cornerRadius = 0; this.visible = true; this.boundVariables = {};
    if (type === "FRAME" || type === "COMPONENT" || type === "COMPONENT_SET") {
      this.children = []; this.layoutMode = "NONE"; this.itemSpacing = 0;
      this.paddingTop = this.paddingRight = this.paddingBottom = this.paddingLeft = 0;
      this.primaryAxisAlignItems = "MIN"; this.counterAxisAlignItems = "MIN"; this.clipsContent = true;
    }
    if (type === "TEXT") { this.characters = ""; this.fontSize = 12; this.fontName = { family: "Inter", style: "Regular" }; this.textAutoResize = "WIDTH_AND_HEIGHT"; }
    if (type === "PAGE") { this.children = []; this.selection = []; }
  }
  appendChild(c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); }
  insertChild(i, c) { this.appendChild(c); this.children.splice(i, 0, this.children.pop()); }
  resize(w, h) { this.width = w; this.height = h; }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.removed = true; nodes.delete(this.id); }
  clone() {
    const c = new Node(this.type);
    Object.assign(c, this, { id: c.id, parent: null });
    nodes.set(c.id, c);
    this.parent.appendChild(c); // real Figma places the clone next to the original
    return c;
  }
  setBoundVariable(field, variable) {
    if (!["cornerRadius", "itemSpacing", "strokeWeight", "paddingLeft", "height"].includes(field)) throw new Error("invalid field " + field);
    if (variable) { this[field] = variable.value; this.boundVariables[field] = { type: "VARIABLE_ALIAS", id: variable.id }; }
    else delete this.boundVariables[field];
  }
  async exportAsync() { return new Uint8Array([1, 2, 3]); }
}
const nodes = new Map();
const reg = (n) => (nodes.set(n.id, n), n);
const page = reg(new Node("PAGE")); page.name = "Page 1";
const sent = [];
const fontsLoaded = [];
const figma = {
  mixed, currentPage: page, root: { name: "Test file", children: [page] },
  viewport: { scrollAndZoomIntoView() {} },
  createFrame: () => reg(new Node("FRAME")), createComponent: () => reg(new Node("COMPONENT")), createRectangle: () => reg(new Node("RECTANGLE")),
  createEllipse: () => reg(new Node("ELLIPSE")), createText: () => reg(new Node("TEXT")),
  createLine: () => reg(new Node("LINE")), createPolygon: () => reg(new Node("POLYGON")), createStar: () => reg(new Node("STAR")),
  getNodeByIdAsync: async (id) => nodes.get(id) || null,
  loadFontAsync: async (f) => { if (f.family === "Nope") throw new Error("x"); fontsLoaded.push(`${f.family} ${f.style}`); },
  base64Encode: (b) => Buffer.from(b).toString("base64"),
  base64Decode: (s) => new Uint8Array(Buffer.from(s, "base64")),
  createImage: (bytes) => {
    if (!bytes.length || bytes[0] !== 0x89) throw new Error("unsupported image");
    return { hash: "hash" + Buffer.from(bytes).toString("hex").slice(0, 12) };
  },
  combineAsVariants(comps, parent) {
    const set = reg(new Node("COMPONENT_SET")); parent.appendChild(set);
    comps.forEach((c) => set.appendChild(c));
    return set;
  },
  variables: {
    getLocalVariableCollectionsAsync: async () => [{ id: "VC:1", name: "core" }, { id: "VC:2", name: "light" }],
    getLocalVariablesAsync: async () => [
      { id: "V:1", name: "radius/md", resolvedType: "FLOAT", value: 12, variableCollectionId: "VC:1" },
      { id: "V:2", name: "space/2", resolvedType: "FLOAT", value: 8, variableCollectionId: "VC:1" },
      { id: "V:3", name: "primary", resolvedType: "COLOR", variableCollectionId: "VC:2" },
    ],
    setBoundVariableForPaint: (paint, field, variable) => ({ ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } } }),
  },
  showUI() {}, ui: { postMessage: (m) => sent.push(m), onmessage: null },
};
// Fake auto-layout behaviour: a child's layoutSizing* only exists inside an auto-layout parent
const origAppend = Node.prototype.appendChild;
Node.prototype.appendChild = function (c) { origAppend.call(this, c); c.layoutSizingHorizontal = "FIXED"; c.layoutSizingVertical = "FIXED"; };

const ctx = vm.createContext({ figma, __html__: "", console, setTimeout });
vm.runInContext(fs.readFileSync("plugin/code.js", "utf8"), ctx);

let mid = 0;
const call = async (command, params) => {
  const id = ++mid; sent.length = 0;
  await figma.ui.onmessage({ id, command, params });
  return sent.find((m) => m.id === id);
};

// create a nested card with auto layout, text, gradient, shadow
let r = await call("create", {
  spec: {
    type: "FRAME", name: "Card", width: 320, height: 200, fills: "#FFFFFF", cornerRadius: 16,
    layoutMode: "VERTICAL", padding: 24, itemSpacing: 12,
    effects: [{ type: "DROP_SHADOW", color: "#000000", opacity: 0.2, y: 4, blur: 12 }],
    children: [
      { type: "TEXT", characters: "Hello", fontSize: 24, fontStyle: "Bold", textColor: "#111111", layoutSizingHorizontal: "FILL" },
      { type: "RECTANGLE", width: 100, height: 40, fills: [{ type: "GRADIENT_LINEAR", angle: 90, stops: [{ position: 0, color: "#FF0000" }, { position: 1, color: "#0000FF" }] }] },
    ],
  },
});
assert.equal(r.ok, true, r.error);
assert.equal(r.result.created.length, 3);
const card = nodes.get(r.result.rootId);
assert.equal(card.layoutMode, "VERTICAL");
assert.equal(card.paddingLeft, 24);
assert.equal(card.fills[0].color.r, 1);
assert.equal(card.effects[0].type, "DROP_SHADOW");
const text = card.children[0];
assert.equal(text.characters, "Hello");
assert.equal(text.layoutSizingHorizontal, "FILL");
assert.equal(JSON.stringify(text.fills[0].color), JSON.stringify({ r: 17 / 255, g: 17 / 255, b: 17 / 255 }));
assert.ok(fontsLoaded.includes("Inter Bold"));
assert.equal(card.children[1].fills[0].type, "GRADIENT_LINEAR");
console.log("ok: create nested tree");

// default frame gets no white fill when none given
r = await call("create", { spec: { type: "FRAME", name: "Plain" }, parentId: card.id });
assert.equal(nodes.get(r.result.rootId).fills.length, 0);
console.log("ok: frame default fills cleared");

// get_node / get_selection
r = await call("get_node", { id: card.id, depth: 2 });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.children[0].characters, "Hello");
assert.equal(r.result.fills[0].color, "#FFFFFF");
r = await call("get_selection", {});
assert.equal(r.result.length, 1);
console.log("ok: get_node / get_selection");

// update (text change + move parent)
r = await call("update", { id: text.id, props: { characters: "Bye", fontSize: 18 } });
assert.equal(r.ok, true, r.error);
assert.equal(text.characters, "Bye"); assert.equal(text.fontSize, 18);
console.log("ok: update text");

// bad font -> readable error
r = await call("create", { spec: { type: "TEXT", characters: "x", fontFamily: "Nope" } });
assert.equal(r.ok, false); assert.match(r.error, /not available/);
// bad color, unknown type, unknown parent, unknown command
r = await call("create", { spec: { type: "FRAME", fills: "red" } });
assert.equal(r.ok, false); assert.match(r.error, /Invalid color/);
r = await call("create", { spec: { type: "BLOB" } });
assert.match(r.error, /Unsupported node type/);
r = await call("create", { spec: { type: "FRAME" }, parentId: "9:9" });
assert.match(r.error, /Parent not found/);
r = await call("nope", {});
assert.match(r.error, /Unknown command/);
console.log("ok: error messages");

// export, clone, delete, select, status
r = await call("export", { id: card.id, scale: 2 });
assert.equal(r.result.base64, "AQID"); assert.equal(r.result.width, 640);
r = await call("clone", { id: card.id, x: 500 });
assert.equal(r.result.x, 500);
r = await call("delete", { ids: [r.result.id, "9:9"] });
assert.equal(JSON.stringify(r.result.notFound), JSON.stringify(["9:9"]));
r = await call("select", { ids: [card.id] });
assert.equal(JSON.stringify(r.result.selected), JSON.stringify([card.id]));
r = await call("status", {});
assert.equal(r.result.file, "Test file");
console.log("ok: export / clone / delete / select / status");

// ---- build animation
const animSpec = {
  type: "FRAME", name: "Anim", width: 200, height: 100, layoutMode: "VERTICAL",
  children: [
    { type: "TEXT", characters: "A" },
    { type: "RECTANGLE", width: 50, height: 20, opacity: 0.5 },
    { type: "FRAME", name: "Inner", children: [{ type: "ELLIPSE", width: 10, height: 10 }] },
  ],
};

// default (animate on): DFS reveal order, intermediate fade steps, final opacities restored
opacityLog.length = 0;
const t0 = Date.now();
r = await call("create", { spec: animSpec, speed: "fast" });
assert.equal(r.ok, true, r.error);
const ids = r.result.created.map((c) => c.id); // creation order = DFS
const targets = { [ids[2]]: 0.5 }; // the rectangle asked for 0.5
const finalOf = (id) => (targets[id] !== undefined ? targets[id] : 1);
const firstReveal = [];
for (const e of opacityLog) {
  if (e.v === finalOf(e.id) && !firstReveal.includes(e.id)) firstReveal.push(e.id);
}
assert.equal(JSON.stringify(firstReveal), JSON.stringify(ids), "nodes must be revealed in creation (parent-first) order");
assert.ok(opacityLog.some((e) => e.v > 0 && e.v < finalOf(e.id)), "should fade through intermediate opacities");
assert.ok(Date.now() - t0 >= 100, "animation should take real time");
for (const id of ids) assert.equal(nodes.get(id).opacity, finalOf(id), "final opacity of " + id);
assert.equal(JSON.stringify(page.selection.map((n) => n.id)), JSON.stringify([ids[0]]), "root selected at the end");
console.log("ok: animation reveals in order and restores final opacity");

// animate:false -> instant, no opacity writes at all
opacityLog.length = 0;
const t1 = Date.now();
r = await call("create", { spec: animSpec, animate: false });
assert.equal(r.ok, true, r.error);
assert.equal(opacityLog.filter((e) => e.v === 0).length, 0, "no hiding when animation is off");
assert.ok(Date.now() - t1 < 80, "no animation delay");
console.log("ok: animate:false is instant");

// settings from the plugin window change the default, and bad values are ignored
await figma.ui.onmessage({ type: "settings", animate: false, speed: "slow" });
opacityLog.length = 0;
r = await call("create", { spec: animSpec });
assert.equal(opacityLog.filter((e) => e.v === 0).length, 0, "setting animate=false is respected");
await figma.ui.onmessage({ type: "settings", animate: true, speed: "bogus" });
opacityLog.length = 0;
r = await call("create", { spec: { type: "RECTANGLE", width: 5, height: 5 }, speed: "fast" });
assert.ok(opacityLog.some((e) => e.v === 0), "animate=true is respected");
console.log("ok: plugin-window settings");

// a node removed mid-animation must not crash the build, and an error never leaves things transparent
opacityLog.length = 0;
const pending = call("create", { spec: animSpec, speed: "slow" });
await new Promise((res) => setTimeout(res, 150));
const victim = [...nodes.values()].filter((n) => n.name === "Inner").pop();
victim.remove(); victim.removed = true;
r = await pending;
assert.equal(r.ok, true, r.error);
console.log("ok: node deleted during animation");

// a long list is capped (12s budget): 400 nodes at 'slow' must not take 400*180ms
const many = { type: "FRAME", name: "Many", children: Array.from({ length: 400 }, () => ({ type: "RECTANGLE", width: 4, height: 4 })) };
const t2 = Date.now();
r = await call("create", { spec: many, speed: "slow" });
assert.equal(r.ok, true, r.error);
assert.ok(Date.now() - t2 < 14000, "long animations are capped at ~12s, took " + (Date.now() - t2) + "ms");
console.log(`ok: 400-node build capped (${Date.now() - t2}ms)`);

// ---- source / target slots
const mk = async (spec) => (await call("create", { spec, animate: false })).result;
const srcMade = await mk({
  type: "FRAME", name: "Brief", width: 300, height: 300,
  children: [
    { type: "TEXT", name: "Body", characters: "Isi paragraf", y: 100 },
    { type: "TEXT", name: "Title", characters: "Judul", fontSize: 24, y: 10 },
    { type: "RECTANGLE", name: "Photo", width: 80, height: 60 },
    { type: "TEXT", name: "Right", characters: "Kanan", y: 10, x: 200 },
    { type: "TEXT", name: "Hidden", characters: "Rahasia", visible: false },
  ],
});
nodes.get(srcMade.created[3].id).fills = [{ type: "IMAGE" }]; // Photo gets an image fill
const tgtMade = await mk({
  type: "FRAME", name: "Poster", width: 200, height: 200,
  children: [{ type: "TEXT", name: "Heading", characters: "Placeholder" }],
});

// empty slots -> helpful note, not an error
r = await call("get_slots", {});
assert.equal(r.ok, true, r.error);
assert.match(r.result.note, /empty/);

r = await call("set_slot", { slot: "source", ids: [srcMade.rootId] });
assert.equal(r.ok, true, r.error); assert.equal(r.result.source[0].name, "Brief");
r = await call("set_slot", { slot: "target", ids: [tgtMade.rootId] });
assert.equal(r.result.target[0].name, "Poster");

r = await call("get_slots", {});
assert.equal(r.ok, true, r.error);
assert.equal(r.result.note, undefined);
const texts = r.result.source.content.texts;
assert.equal(JSON.stringify(texts.map((t) => t.characters)), JSON.stringify(["Judul", "Kanan", "Isi paragraf"]), "reading order, hidden skipped");
assert.equal(texts[0].path, "Brief / Title"); assert.equal(texts[0].fontSize, 24);
assert.equal(r.result.source.content.images.length, 1); assert.equal(r.result.source.content.images[0].name, "Photo");
assert.equal(r.result.target.content.texts[0].characters, "Placeholder");
assert.equal(r.result.target.tree[0].children[0].type, "TEXT");
console.log("ok: get_slots returns ordered content for source and target");

// Claude edits the target's text by id (what the workflow does)
r = await call("update", { id: r.result.target.content.texts[0].id, props: { characters: "Judul" } });
assert.equal(r.ok, true, r.error);

// slot from the user's selection (plugin window button) + bad input
page.selection = [nodes.get(srcMade.rootId)];
await figma.ui.onmessage({ type: "set-slot", slot: "target" });
r = await call("get_slots", {});
assert.equal(r.result.target.nodes[0].name, "Brief");
page.selection = [];
r = await call("set_slot", { slot: "source" });
assert.equal(r.ok, false); assert.match(r.error, /Nothing is selected/);
r = await call("set_slot", { slot: "middle" });
assert.equal(r.ok, false); assert.match(r.error, /slot must be/);
r = await call("set_slot", { slot: "target", ids: ["9:9"] });
assert.equal(r.ok, false); assert.match(r.error, /Node not found/);
console.log("ok: slot from selection and input errors");

// a deleted node drops out of its slot; clear works
await call("delete", { ids: [srcMade.rootId] });
r = await call("get_slots", {});
assert.equal(r.result.source.nodes.length, 0); assert.equal(r.result.target.nodes.length, 0);
assert.match(r.result.note, /empty/);
await call("set_slot", { slot: "source", ids: [tgtMade.rootId] });
await figma.ui.onmessage({ type: "clear-slot", slot: "source" });
r = await call("get_slots", {});
assert.equal(r.result.source.nodes.length, 0);
console.log("ok: deleted node dropped, clear");

// ---- image fills
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
r = await call("create", {
  animate: false,
  spec: {
    type: "FRAME", name: "Photo card", width: 200, height: 200,
    children: [
      { type: "RECTANGLE", name: "Cover", width: 200, height: 120, cornerRadius: 12,
        fills: [{ type: "IMAGE", base64: PNG_B64, scaleMode: "FIT" }, { type: "GRADIENT_LINEAR", stops: [{ position: 0, color: "#00000000" }, { position: 1, color: "#000000" }] }] },
      { type: "ELLIPSE", name: "Avatar", width: 40, height: 40, fills: [{ type: "IMAGE", base64: PNG_B64 }] },
    ],
  },
});
assert.equal(r.ok, true, r.error);
const cover = nodes.get(r.result.created[1].id), avatar = nodes.get(r.result.created[2].id);
assert.equal(cover.fills[0].type, "IMAGE");
assert.match(cover.fills[0].imageHash, /^hash/);
assert.equal(cover.fills[0].scaleMode, "FIT");
assert.equal(cover.fills[1].type, "GRADIENT_LINEAR");
assert.equal(avatar.fills[0].scaleMode, "FILL"); // default
console.log("ok: IMAGE fill from base64 (+ mixed with gradient, default FILL)");

// copy the image from another node (fromNodeId), inherit its scaleMode unless overridden
r = await call("create", { animate: false, spec: { type: "RECTANGLE", name: "Copy", width: 10, height: 10, fills: [{ type: "IMAGE", fromNodeId: cover.id }] } });
assert.equal(r.ok, true, r.error);
const copy = nodes.get(r.result.rootId);
assert.equal(copy.fills[0].imageHash, cover.fills[0].imageHash);
assert.equal(copy.fills[0].scaleMode, "FIT");
r = await call("update", { id: copy.id, props: { fills: [{ type: "IMAGE", imageHash: cover.fills[0].imageHash, scaleMode: "TILE", scale: 0.5 }] } });
assert.equal(r.ok, true, r.error);
assert.equal(copy.fills[0].scaleMode, "TILE"); assert.equal(copy.fills[0].scalingFactor, 0.5);
// replace the image on an existing node (figma_update) and go back to a solid color
r = await call("update", { id: avatar.id, props: { fills: "#FF0000" } });
assert.equal(avatar.fills[0].type, "SOLID");
console.log("ok: fromNodeId / imageHash / TILE / update");

// serialization exposes imageHash so Claude can reuse images
r = await call("get_node", { id: cover.id, depth: 0 });
assert.equal(r.result.fills[0].type, "IMAGE"); assert.equal(r.result.fills[0].imageHash, cover.fills[0].imageHash);
await call("set_slot", { slot: "source", ids: [r.result.id] });
r = await call("get_slots", {});
assert.equal(r.result.source.content.images[0].imageHash, cover.fills[0].imageHash);
console.log("ok: imageHash in get_node / slot images");

// errors
r = await call("create", { spec: { type: "RECTANGLE", fills: [{ type: "IMAGE" }] } });
assert.equal(r.ok, false); assert.match(r.error, /needs one of/);
r = await call("create", { spec: { type: "RECTANGLE", fills: [{ type: "IMAGE", fromNodeId: card.id }] } });
assert.equal(r.ok, false); assert.match(r.error, /no image fill/);
r = await call("create", { spec: { type: "RECTANGLE", fills: [{ type: "IMAGE", base64: "AAAA" }] } });
assert.equal(r.ok, false); assert.match(r.error, /could not read this image/);
r = await call("create", { spec: { type: "RECTANGLE", fills: [{ type: "IMAGE", base64: PNG_B64, scaleMode: "STRETCH" }] } });
assert.equal(r.ok, false); assert.match(r.error, /scaleMode must be/);
console.log("ok: image errors");

// components, variable bindings and variants
r = await call("create", { spec: {
  type: "COMPONENT", name: "variant=default, size=md", layoutMode: "HORIZONTAL", cornerRadius: 1, itemSpacing: 1,
  fills: [{ type: "SOLID", variable: "light/primary" }],
  bind: { cornerRadius: "core/radius/md", itemSpacing: "core/space/2" },
  children: [{ type: "TEXT", characters: "Deploy", textColor: "var:light/primary" }],
} });
assert.equal(r.ok, true, r.error);
const comp = r.result.created[0];
assert.equal(comp.type, "COMPONENT");
r = await call("get_node", { id: comp.id, depth: 1 });
assert.equal(r.result.fills[0].variable, "light/primary");
assert.equal(r.result.bound.cornerRadius, "core/radius/md");
assert.equal(r.result.bound.itemSpacing, "core/space/2");
assert.equal(r.result.cornerRadius, 12); // value comes from the variable
assert.equal(r.result.children[0].fills[0].variable, "light/primary");
console.log("ok: COMPONENT with variable fills and bound fields");

r = await call("update", { id: comp.id, props: { bind: { cornerRadius: null } } });
r = await call("get_node", { id: comp.id, depth: 0 });
assert.equal(r.result.bound.cornerRadius, undefined);
console.log("ok: unbind with null");

r = await call("create", { spec: { type: "RECTANGLE", fills: "var:light/primry" } });
assert.equal(r.ok, false); assert.match(r.error, /not found/); assert.match(r.error, /light\/primary/);
r = await call("create", { spec: { type: "RECTANGLE", fills: "var:core/radius/md" } });
assert.equal(r.ok, false); assert.match(r.error, /not COLOR/);
r = await call("create", { spec: { type: "RECTANGLE", bind: { bogus: "core/radius/md" } } });
assert.equal(r.ok, false); assert.match(r.error, /Cannot bind "bogus"/);
console.log("ok: variable errors");

r = await call("create", { spec: { type: "COMPONENT", name: "variant=outline, size=md" } });
const comp2 = r.result.created[0];
r = await call("create", { spec: { type: "COMPONENT", name: "Button" } });
const badName = r.result.created[0];
r = await call("combine_variants", { ids: [comp.id, badName.id] });
assert.equal(r.ok, false); assert.match(r.error, /must look like/);
r = await call("combine_variants", { ids: [card.id] });
assert.equal(r.ok, false); assert.match(r.error, /not COMPONENT/);
r = await call("combine_variants", { ids: [comp.id, comp2.id], name: "Button" });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.type, "COMPONENT_SET"); assert.equal(r.result.name, "Button"); assert.equal(r.result.children.length, 2);
assert.equal(r.result.children[0].fills[0].variable, "light/primary"); // names, not ids
console.log("ok: combine_variants");

console.log("\nPLUGIN MOCK TESTS PASSED");
