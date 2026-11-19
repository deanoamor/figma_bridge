// Runs plugin/code.js against a tiny fake of the Figma API to catch logic errors.
import vm from "node:vm";
import fs from "node:fs";
import assert from "node:assert/strict";

let idc = 0;
const mixed = Symbol("mixed");
const opacityLog = []; // every opacity write: { id, v }
const textResizeLog = []; // every textAutoResize write: { id, v }
class Node {
  get variantGroupProperties() {
    if (this.type !== "COMPONENT_SET") return null;
    const g = {};
    this.children.forEach((c) => Object.entries(c.variantProperties || {}).forEach(([k, v]) => {
      g[k] = g[k] || { values: [] }; if (!g[k].values.includes(v)) g[k].values.push(v);
    }));
    return g;
  }
  get variantProperties() {
    if (this._vp) return this._vp;
    if (this.type !== "COMPONENT") return null;
    return Object.fromEntries(this.name.split(",").map((kv) => kv.trim().split("=")));
  }
  createInstance() {
    const i = new Node("INSTANCE"); nodes.set(i.id, i);
    i._vp = { ...this.variantProperties }; i.fills = []; i._main = this; page.appendChild(i);
    i.getMainComponentAsync = async function () { return this._main; };
    i.swapComponent = function (c) { this._main = c; this._vp = { ...c.variantProperties }; };
    i.setProperties = function (props) { Object.assign(this._vp, props); };
    return i;
  }
  async setEffectStyleIdAsync(id) { this.effectStyleId = id; }
  async setTextStyleIdAsync(id) { this.textStyleId = id; }
  get x() { return this._x; }
  set x(v) { if (this._inFlow()) return; this._x = v; }
  get y() { return this._y; }
  set y(v) { if (this._inFlow()) return; this._y = v; }
  _inFlow() { return !!(this.parent && this.parent.layoutMode && this.parent.layoutMode !== "NONE" && this.layoutPositioning !== "ABSOLUTE"); }
  get textAutoResize() { return this._tar; }
  set textAutoResize(v) { this._tar = v; textResizeLog.push({ id: this.id, v }); }
  get opacity() { return this._o; }
  set opacity(v) { this._o = v; opacityLog.push({ id: this.id, v }); }
  constructor(type) {
    this.id = `1:${++idc}`; this.type = type; this.name = type; this.parent = null;
    this.x = 0; this.y = 0; this.width = 100; this.height = 100; this._o = 1; this.rotation = 0;
    this.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; this.strokes = []; this.strokeWeight = 1;
    this.constraints = { horizontal: "MIN", vertical: "MIN" }; this.effects = []; this.cornerRadius = 0; this.visible = true; this.boundVariables = {};
    if (type === "COMPONENT" || type === "COMPONENT_SET") this.description = "";
    if (type === "VECTOR") { this.fills = []; this.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]; }
    if (type === "FRAME" || type === "COMPONENT" || type === "COMPONENT_SET" || type === "INSTANCE") {
      this.children = []; this.layoutMode = "NONE"; this.itemSpacing = 0;
      this.paddingTop = this.paddingRight = this.paddingBottom = this.paddingLeft = 0;
      this.primaryAxisAlignItems = "MIN"; this.counterAxisAlignItems = "MIN"; this.clipsContent = true;
    }
    if (type === "TEXT") { this.characters = ""; this.fontSize = 12; this.fontName = { family: "Inter", style: "Regular" }; this.textAutoResize = "WIDTH_AND_HEIGHT"; }
    if (type === "PAGE") { this.children = []; this.selection = []; }
  }
  async loadAsync() { this.loaded = true; }
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
  _chars() {
    const n = this.characters.length;
    if (!this._cs || this._cs.length !== n) {
      this._cs = Array.from({ length: n }, () => ({ fontSize: this.fontSize, fontName: this.fontName, fills: this.fills, textDecoration: "NONE", letterSpacing: { unit: "PIXELS", value: 0 }, lineHeight: { unit: "AUTO" } }));
    }
    return this._cs;
  }
  _setRange(a, b, k, v) { const cs = this._chars(); for (let i = a; i < b; i++) cs[i] = { ...cs[i], [k]: v }; }
  setRangeFontName(a, b, v) { this._setRange(a, b, "fontName", v); }
  setRangeFontSize(a, b, v) { this._setRange(a, b, "fontSize", v); }
  setRangeFills(a, b, v) { this._setRange(a, b, "fills", v); }
  setRangeTextDecoration(a, b, v) { this._setRange(a, b, "textDecoration", v); }
  setRangeLetterSpacing(a, b, v) { this._setRange(a, b, "letterSpacing", v); }
  setRangeLineHeight(a, b, v) { this._setRange(a, b, "lineHeight", v); }
  getRangeFontName(a, b) {
    const cs = this._chars().slice(a, b), f = cs[0].fontName;
    return cs.every((c) => c.fontName.family === f.family && c.fontName.style === f.style) ? f : mixed;
  }
  getStyledTextSegments(keys) {
    const cs = this._chars(), segs = [];
    cs.forEach((c, i) => {
      const pick = Object.fromEntries(keys.map((k) => [k, c[k]]));
      const last = segs[segs.length - 1];
      if (last && JSON.stringify(last.pick) === JSON.stringify(pick)) { last.end = i + 1; }
      else segs.push({ start: i, end: i + 1, pick });
    });
    return segs.map((g) => ({ characters: this.characters.slice(g.start, g.end), start: g.start, end: g.end, ...g.pick }));
  }
  async exportAsync(o) { return o && o.format === "SVG_STRING" ? `<svg xmlns="http://www.w3.org/2000/svg" data-outline="${o.svgOutlineText}" data-ids="${o.svgIdAttribute}"><path d="M0 0"/></svg>` : new Uint8Array([1, 2, 3]); }
}
const nodes = new Map();
const reg = (n) => (nodes.set(n.id, n), n);
const page = reg(new Node("PAGE")); page.name = "Page 1";
const page2 = reg(new Node("PAGE")); page2.name = "Web Flow";
const sent = [];
const fontsLoaded = [];
const effectStyles = [];
const textStyles = [];
const svgImported = [];
const mkVar = (o) => ({ description: "", scopes: [], values: {}, get valuesByMode() { return this.values; }, setValueForMode(m, val) { this.values[m] = val; }, ...o });
const varList = [
  mkVar({ id: "V:1", name: "radius/md", resolvedType: "FLOAT", value: 12, variableCollectionId: "VC:1" }),
  mkVar({ id: "V:2", name: "space/2", resolvedType: "FLOAT", value: 8, variableCollectionId: "VC:1" }),
  mkVar({ id: "V:3", name: "primary", resolvedType: "COLOR", description: "Brand color.", variableCollectionId: "VC:2" }),
  mkVar({ id: "V:4", name: "primary", resolvedType: "COLOR", variableCollectionId: "VC:3" }),
  mkVar({ id: "V:5", name: "ring", resolvedType: "COLOR", variableCollectionId: "VC:2" }), // no dark/ring on purpose
];
const figma = {
  mixed, currentPage: page, root: { name: "Test file", children: [page, page2] },
  viewport: { scrollAndZoomIntoView() {} },
  createFrame: () => reg(new Node("FRAME")), createComponent: () => reg(new Node("COMPONENT")), createRectangle: () => reg(new Node("RECTANGLE")),
  createEllipse: () => reg(new Node("ELLIPSE")), createText: () => reg(new Node("TEXT")),
  createNodeFromSvg: (svg) => { const n = reg(new Node("FRAME")); n.name = "svg"; n.svgSource = svg; return n; },
  createVector: () => reg(new Node("VECTOR")),
  _bool(op) {
    return (parts, parent, index) => {
      if (!parent) throw new Error("no parent");
      const b = reg(new Node("BOOLEAN_OPERATION")); b.children = []; b.booleanOperation = op; b.fills = [];
      parent.appendChild(b);
      parts.forEach((c) => b.appendChild(c));
      if (typeof index === "number") parent.insertChild(index, b);
      return b;
    };
  },
  union(...a) { return this._bool("UNION")(...a); }, subtract(...a) { return this._bool("SUBTRACT")(...a); },
  intersect(...a) { return this._bool("INTERSECT")(...a); }, exclude(...a) { return this._bool("EXCLUDE")(...a); },
  flatten(parts, parent) {
    const v = reg(new Node("VECTOR")); v.flattenedFrom = parts[0].type; parent.appendChild(v);
    parts.forEach((c) => c.remove());
    return v;
  },
  createLine: () => reg(new Node("LINE")), createPolygon: () => reg(new Node("POLYGON")), createStar: () => reg(new Node("STAR")),
  getNodeByIdAsync: async (id) => nodes.get(id) || null,
  loadFontAsync: async (f) => {
    // Poppins calls it "SemiBold", Inter "Semi Bold"; unknown families do not exist
    if (f.family === "Nope" || f.family === "Missing Sans" || f.family === "Also Missing" || (f.family === "Poppins" && f.style === "Semi Bold") || (f.family === "Inter" && f.style === "SemiBold")) throw new Error("x");
    fontsLoaded.push(`${f.family} ${f.style}`);
  },
  base64Encode: (b) => Buffer.from(b).toString("base64"),
  base64Decode: (s) => new Uint8Array(Buffer.from(s, "base64")),
  createImage: (bytes) => {
    if (!bytes.length || bytes[0] !== 0x89) throw new Error("unsupported image");
    return { hash: "hash" + Buffer.from(bytes).toString("hex").slice(0, 12) };
  },
  getLocalEffectStylesAsync: async () => effectStyles,
  getLocalTextStylesAsync: async () => textStyles,
  createTextStyle: () => { const s = { id: `T:${textStyles.length + 1}`, name: "", boundVars: {}, setBoundVariable(f, v) { if (!["fontSize", "lineHeight"].includes(f)) throw new Error("invalid field " + f); this.boundVars[f] = v.id; } }; textStyles.push(s); return s; },
  createNodeFromSvg: (svg) => { svgImported.push(svg); const f = reg(new Node("FRAME")); f.name = "svg"; f.appendChild(reg(new Node("VECTOR"))); return f; },
  getLocalPaintStylesAsync: async () => [],
  createEffectStyle: () => { const s = { id: `S:${effectStyles.length + 1}`, name: "", effects: [], description: "" }; effectStyles.push(s); return s; },
  combineAsVariants(comps, parent) {
    const set = reg(new Node("COMPONENT_SET")); parent.appendChild(set);
    comps.forEach((c) => set.appendChild(c));
    return set;
  },
  variables: (() => {
    let vc = 10, mm = 10;
    const mkCol = (id, name, modes, ids) => ({
      id, name, modes: modes.map((n, i) => ({ modeId: ids ? ids[i] : `M:${++mm}`, name: n })),
      renameMode(modeId, n) { this.modes.find((m) => m.modeId === modeId).name = n; },
      addMode(n) { const m = { modeId: `M:${++mm}`, name: n }; this.modes.push(m); return m.modeId; },
    });
    const collections = [mkCol("VC:1", "core", ["Mode 1"], ["m:1"]), mkCol("VC:2", "light", ["Light"], ["m:2"]), mkCol("VC:3", "dark", ["Dark"], ["m:3"])];
    return {
      getLocalVariableCollectionsAsync: async () => collections.slice(),
      getLocalVariablesAsync: async () => varList,
      createVariableCollection(name) { const c = mkCol(`VC:${++vc}`, name, ["Mode 1"]); collections.push(c); return c; },
      createVariable: (name, col, type) => {
        if (!col || !col.modes) throw new Error("createVariable needs a collection node");
        const v = mkVar({ id: `V:${varList.length + 1}`, name, resolvedType: type, variableCollectionId: col.id });
        varList.push(v);
        return v;
      },
      createVariableAlias: (v) => ({ type: "VARIABLE_ALIAS", id: v.id }),
      setBoundVariableForEffect: (effect, field, variable) => ({ ...effect, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } } }),
    setBoundVariableForPaint: (paint, field, variable) => ({ ...paint, boundVariables: { [field]: { type: "VARIABLE_ALIAS", id: variable.id } } }),
    };
  })(),
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
r = await call("combine_variants", { ids: [comp.id, comp2.id], name: "Button", depth: 1 });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.type, "COMPONENT_SET"); assert.equal(r.result.name, "Button"); assert.equal(r.result.children.length, 2);
assert.equal(r.result.children[0].fills[0].variable, "light/primary"); // names, not ids
console.log("ok: combine_variants");

// rebind light -> dark on a copy; core variables stay
r = await call("create", { spec: {
  type: "COMPONENT", name: "variant=default", cornerRadius: 1, fills: "var:light/primary", strokes: "var:light/ring",
  bind: { cornerRadius: "core/radius/md" },
  children: [{ type: "TEXT", characters: "x", textColor: "var:light/primary" }],
} });
const themed = r.result.created[0];
r = await call("rebind_variables", { id: themed.id, from: "light", to: "dark", name: "variant=default (dark)" });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.rebound, 2); // fill + the text fill
assert.deepEqual(Array.from(r.result.missing), ["dark/ring"]);
assert.equal(r.result.name, "variant=default (dark)");
r = await call("get_node", { id: themed.id, depth: 1 });
assert.equal(r.result.fills[0].variable, "dark/primary");
assert.equal(r.result.strokes[0].variable, "light/ring"); // missing target: unchanged
assert.equal(r.result.children[0].fills[0].variable, "dark/primary");
assert.equal(r.result.bound.cornerRadius, "core/radius/md");
r = await call("rebind_variables", { id: themed.id, from: "light", to: "nope" });
assert.equal(r.ok, false); assert.match(r.error, /Collection "nope" not found/);
console.log("ok: rebind_variables");

// list_variables groups variables by collection (with modes and descriptions)
r = await call("list_variables", {});
assert.equal(r.ok, true, r.error);
assert.equal(JSON.stringify(r.result.map((c) => c.name)), JSON.stringify(["core", "light", "dark"]));
const lightCol = r.result.find((c) => c.name === "light");
assert.equal(lightCol.variableCount, 2); // primary + ring; variables of the other collections are not counted
assert.equal(JSON.stringify(lightCol.modes), JSON.stringify(["Light"]));
// JSON: vm objects are cross-realm, so deepEqual would fail
assert.equal(JSON.stringify(lightCol.variables), JSON.stringify([
  { id: "V:3", name: "primary", type: "COLOR", hasDescription: true },
  { id: "V:5", name: "ring", type: "COLOR", hasDescription: false },
]));
console.log("ok: list_variables");

// opacity on a variable paint is refused (Figma cannot keep both)
r = await call("create", { spec: { type: "RECTANGLE", fills: [{ type: "SOLID", variable: "light/primary", opacity: 0.14 }] } });
assert.equal(r.ok, false); assert.match(r.error, /already has alpha/);
console.log("ok: opacity on variable paint is refused");

// create_variable: composed color, update in place, hex alpha, errors
r = await call("create_variable", { collection: "light", name: "ring-subtle", type: "COLOR", value: { color: "light/ring", opacity: 14 }, description: "tint", scopes: ["ALL_FILLS"] });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.created, true); assert.equal(r.result.name, "light/ring-subtle");
const subtle = varList.find((v) => v.name === "ring-subtle");
assert.deepEqual(JSON.parse(JSON.stringify(subtle.values["m:2"])), { color: { type: "VARIABLE_ALIAS", id: "V:5" }, opacity: 14 });
assert.equal(subtle.description, "tint"); assert.deepEqual(Array.from(subtle.scopes), ["ALL_FILLS"]);
r = await call("create_variable", { collection: "light", name: "ring-subtle", type: "COLOR", value: { color: "light/ring", opacity: 20 } });
assert.equal(r.result.created, false); assert.equal(subtle.values["m:2"].opacity, 20); // updated, not duplicated
assert.equal(varList.filter((v) => v.name === "ring-subtle").length, 1);
r = await call("create_variable", { collection: "dark", name: "flat", type: "COLOR", value: "#FF000080" });
const flat = varList.find((v) => v.name === "flat").values["m:3"];
assert.equal(flat.r, 1); assert.ok(Math.abs(flat.a - 128 / 255) < 1e-9);
r = await call("create_variable", { collection: "nope", name: "x", type: "COLOR", value: "#000000" });
assert.equal(r.ok, false); assert.match(r.error, /Collection "nope" not found/);
r = await call("create_variable", { collection: "light", name: "bad", type: "COLOR", value: { color: "light/ring", opacity: 140 } });
assert.equal(r.ok, false); assert.match(r.error, /0 to 100/);
r = await call("create_variable", { collection: "light", name: "primary", type: "FLOAT", value: 1 });
assert.equal(r.ok, false); assert.match(r.error, /exists as COLOR/);
console.log("ok: create_variable");

// instances: pick a variant, move to a parent, switch with `properties`
r = await call("create", { spec: { type: "COMPONENT", name: "variant=default, size=md" } });
const vA = r.result.created[0];
r = await call("create", { spec: { type: "COMPONENT", name: "variant=outline, size=md" } });
const vB = r.result.created[0];
r = await call("combine_variants", { ids: [vA.id, vB.id], name: "Btn" });
const btnSet = r.result;
r = await call("create", { spec: { type: "FRAME", name: "dialog row", layoutMode: "HORIZONTAL" } });
const row = r.result.created[0];
r = await call("create_instance", { id: btnSet.id, variant: { variant: "outline" }, parentId: row.id, props: { name: "Cancel" } });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.type, "INSTANCE"); assert.equal(r.result.name, "Cancel");
assert.equal(r.result.variantProperties.variant, "outline");
const inst = r.result.id;
assert.equal(nodes.get(inst).parent.id, row.id); // placed inside the parent
r = await call("update", { id: inst, props: { properties: { variant: "default" } } });
assert.equal(r.result.variantProperties.variant, "default");
r = await call("create_instance", { id: btnSet.id, variant: { variant: "ghost" } });
assert.equal(r.ok, false); assert.match(r.error, /No variant of Btn matches/);
r = await call("create_instance", { id: row.id });
assert.equal(r.ok, false); assert.match(r.error, /not COMPONENT or COMPONENT_SET/);
r = await call("update", { id: row.id, props: { properties: { a: "b" } } });
assert.equal(r.ok, false); assert.match(r.error, /only works on an INSTANCE/);
console.log("ok: create_instance and properties");

// effect styles: list, create (and update in place), apply, errors
r = await call("update", { id: row.id, props: { effectStyle: "elevation/2" } });
assert.equal(r.ok, false); assert.match(r.error, /no effect styles/);
r = await call("create_effect_style", { name: "elevation/2", effects: [{ type: "DROP_SHADOW", color: "#000000", opacity: 0.12, y: 8, blur: 24 }], description: "overlay" });
assert.equal(r.ok, true, r.error); assert.equal(r.result.created, true); assert.equal(r.result.effects, 1);
r = await call("create_effect_style", { name: "elevation/2", effects: [{ type: "DROP_SHADOW", y: 4, blur: 8 }] });
assert.equal(r.result.created, false); assert.equal(effectStyles.length, 1); // updated, not duplicated
r = await call("update", { id: row.id, props: { effectStyle: "elevation/2" } });
assert.equal(r.ok, true, r.error); assert.equal(nodes.get(row.id).effectStyleId, "S:1");
r = await call("update", { id: row.id, props: { effectStyle: "nope" } });
assert.equal(r.ok, false); assert.match(r.error, /Available: elevation\/2/);
r = await call("list_styles", {});
assert.equal(JSON.stringify(r.result.effect), JSON.stringify([{ id: "S:1", name: "elevation/2", effects: 1 }]));
assert.equal(r.result.text.length, 0);
console.log("ok: effect styles");

// rebind swaps instances to the matching variant of another set (light Button -> dark Button)
r = await call("create", { spec: { type: "COMPONENT", name: "variant=default, size=md" } });
const dA = r.result.created[0];
r = await call("create", { spec: { type: "COMPONENT", name: "variant=outline, size=md" } });
const dB = r.result.created[0];
r = await call("combine_variants", { ids: [dA.id, dB.id], name: "Btn dark" });
const darkSet = r.result;
r = await call("create", { spec: { type: "FRAME", name: "dlg" } });
const dlg = r.result.created[0];
r = await call("create_instance", { id: btnSet.id, variant: { variant: "outline" }, parentId: dlg.id, props: { name: "Cancel" } });
const cancelInst = r.result.id;
r = await call("create_instance", { id: btnSet.id, variant: { variant: "default" }, parentId: dlg.id, props: { name: "Other" } });
r = await call("rebind_variables", { id: dlg.id, from: "light", to: "dark", swap: { [btnSet.id]: darkSet.id } });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.swapped, 2); assert.equal(JSON.stringify(r.result.unswapped), "[]");
assert.equal(nodes.get(cancelInst)._main.parent.id, darkSet.id);
assert.equal(nodes.get(cancelInst)._main.variantProperties.variant, "outline"); // same variant, other set
assert.equal(nodes.get(cancelInst).name, "Cancel"); // instance name kept
r = await call("rebind_variables", { id: dlg.id, from: "light", to: "dark" });
assert.equal(JSON.stringify(r.result.unswapped.sort()), JSON.stringify(["Cancel", "Other"])); // no swap given: reported, not rebound
console.log("ok: rebind swaps instances");

// combine_variants turns off clipping; arrange_variants lays variants out in a grid
assert.equal(nodes.get(btnSet.id).clipsContent, false);
const mkComp = async (name, w, h) => (await call("create", { spec: { type: "COMPONENT", name, width: w, height: h } })).result.created[0].id;
const g1 = await mkComp("a=x, b=s", 50, 20), g2 = await mkComp("a=x, b=l", 90, 30), g3 = await mkComp("a=y, b=s", 60, 20), g4 = await mkComp("a=y, b=l", 70, 40);
r = await call("combine_variants", { ids: [g1, g2, g3, g4], name: "Grid" });
const gridSet = r.result.id;
r = await call("arrange_variants", { id: gridSet, rows: ["a"], columns: ["b"], gapX: 10, gapY: 5, padding: 2 });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.rows, 2); assert.equal(r.result.columns, 2);
// column widths: s = max(50, 60) = 60, l = max(90, 70) = 90; row heights: x = max(20, 30) = 30, y = max(20, 40) = 40
assert.deepEqual([nodes.get(g1).x, nodes.get(g1).y], [2, 2]);
assert.deepEqual([nodes.get(g2).x, nodes.get(g2).y], [72, 2]);   // 2 + 60 + 10
assert.deepEqual([nodes.get(g3).x, nodes.get(g3).y], [2, 37]);   // 2 + 30 + 5
assert.deepEqual([nodes.get(g4).x, nodes.get(g4).y], [72, 37]);
assert.equal(r.result.width, 2 + 60 + 10 + 90 + 2); assert.equal(r.result.height, 2 + 30 + 5 + 40 + 2);
r = await call("arrange_variants", { id: gridSet, rows: ["nope"] });
assert.equal(r.ok, false); assert.match(r.error, /not found. Available: a, b/);
r = await call("arrange_variants", { id: row.id });
assert.equal(r.ok, false); assert.match(r.error, /not COMPONENT_SET/);
console.log("ok: arrange_variants");

// compact results: combine_variants returns the set only unless depth is given
r = await call("combine_variants", { ids: [g1, g2], name: "Compact" });
assert.equal(r.ok, true, r.error);
assert.equal(r.result.children, undefined); assert.equal(r.result.childCount, 2);

// SVG import (icons): currentColor becomes black, `recolor` binds strokes inside to a variable
r = await call("create", { spec: { type: "COMPONENT", name: "name=check", children: [{ type: "SVG", name: "check", svg: '<svg width="20" height="20"><path stroke="currentColor"/></svg>', recolor: "light/primary" }] } });
assert.equal(r.ok, true, r.error);
assert.ok(svgImported[svgImported.length - 1].includes("#000000") && !svgImported[svgImported.length - 1].includes("currentColor"));
const iconComp = r.result.created[0].id;
r = await call("get_node", { id: iconComp, depth: 3 });
assert.equal(r.result.children[0].children[0].strokes[0].variable, "light/primary");
r = await call("create", { spec: { type: "SVG" } });
assert.equal(r.ok, false); assert.match(r.error, /needs an "svg" string/);
r = await call("create", { spec: { type: "SVG", svg: "<svg/>", recolor: "core/radius/md" } });
assert.equal(r.ok, false); assert.match(r.error, /not COLOR/);
console.log("ok: SVG import and recolor");

// description on components, text styles, effect colors bound to variables
r = await call("update", { id: iconComp, props: { description: "Level: atom" } });
assert.equal(nodes.get(iconComp).description, "Level: atom");
r = await call("create_text_style", { name: "text/sm", fontFamily: "Inter", fontStyle: "Regular", fontSize: 14, lineHeight: 20, bind: { fontSize: "core/space/2" } });
assert.equal(r.ok, true, r.error); assert.equal(r.result.created, true);
assert.equal(textStyles[0].boundVars.fontSize, "V:2");
r = await call("create_text_style", { name: "text/sm", fontFamily: "Inter", fontSize: 15 });
assert.equal(r.result.created, false); assert.equal(textStyles.length, 1); assert.equal(textStyles[0].fontSize, 15);
r = await call("create_text_style", { name: "text/bad", fontFamily: "Inter", fontSize: 12, bind: { color: "core/space/2" } });
assert.equal(r.ok, false); assert.match(r.error, /Cannot bind "color" on a text style/);
r = await call("create", { spec: { type: "TEXT", characters: "x", textStyle: "text/sm" } });
assert.equal(r.ok, true, r.error); assert.equal(nodes.get(r.result.created[0].id).textStyleId, "T:1");
r = await call("create", { spec: { type: "TEXT", characters: "x", textStyle: "nope" } });
assert.equal(r.ok, false); assert.match(r.error, /Available: text\/sm/);
r = await call("create_effect_style", { name: "focus-ring", effects: [{ type: "DROP_SHADOW", x: 0, y: 0, blur: 0, spread: 4, colorVariable: "light/ring" }] });
assert.equal(r.ok, true, r.error);
assert.equal(effectStyles.find((e) => e.name === "focus-ring").effects[0].boundVariables.color.id, "V:5");
console.log("ok: description, text styles, effect colors");
// ======================= improvements from real use (phase 1)
{
  const make = (spec, params = {}) => call("create", { spec, animate: false, ...params });
  const J = (v) => JSON.stringify(v); // vm objects are cross-realm: compare through JSON

  // SVG node, and exporting a node as SVG
  r = await make({ type: "SVG", name: "OVO", svg: '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>' });
  assert.equal(r.ok, true, r.error);
  const svgNode = nodes.get(r.result.rootId);
  assert.match(svgNode.svgSource, /<svg/);
  r = await make({ type: "SVG" });
  assert.equal(r.ok, false); assert.match(r.error, /needs spec.svg/);
  r = await call("export", { id: svgNode.id, format: "SVG" });
  assert.equal(r.ok, true, r.error);
  assert.match(r.result.svg, /^<svg/); assert.equal(r.result.base64, undefined);
  assert.match(r.result.svg, /data-outline="true"/); assert.match(r.result.svg, /data-ids="false"/);
  r = await call("export", { id: svgNode.id, format: "SVG", outlineText: false, includeIds: true });
  assert.match(r.result.svg, /data-outline="false"/); assert.match(r.result.svg, /data-ids="true"/);
  r = await call("export", { id: svgNode.id });
  assert.equal(r.result.mimeType, "image/png"); // PNG unchanged
  console.log("ok: SVG node + export SVG");

  // effects are readable, in the same format figma_create takes
  const fx = [
    { type: "DROP_SHADOW", color: "#112233", opacity: 0.3, x: 1, y: 2, blur: 8, spread: 1 },
    { type: "INNER_SHADOW", color: "#000000", opacity: 0.25, x: 0, y: 1, blur: 2, spread: 0 },
    { type: "LAYER_BLUR", blur: 4 },
  ];
  r = await make({ type: "RECTANGLE", effects: fx });
  const fxId = r.result.rootId;
  r = await call("get_node", { id: fxId, depth: 0 });
  assert.equal(J(r.result.effects), J(fx));
  r = await call("update", { id: fxId, props: { effects: [] } });
  r = await call("get_node", { id: fxId, depth: 0 });
  assert.equal(r.result.effects, undefined);
  console.log("ok: effects round trip");

  // index on create / clone / update
  r = await make({ type: "FRAME", name: "List", layoutMode: "VERTICAL", children: ["A", "B", "C"].map((n) => ({ type: "TEXT", name: n, characters: n })) });
  const list = nodes.get(r.result.rootId);
  const order = () => list.children.map((c) => c.name).join(",");
  r = await make({ type: "TEXT", name: "X", characters: "x" }, { parentId: list.id, index: 1 });
  assert.equal(order(), "A,X,B,C");
  const xId = r.result.rootId;
  r = await make({ type: "TEXT", name: "Y", characters: "y" }, { parentId: list.id, index: 0 });
  assert.equal(order(), "Y,A,X,B,C");
  const yId = r.result.rootId;
  r = await make({ type: "TEXT", name: "Z", characters: "z" }, { parentId: list.id, index: 99 });
  assert.equal(order(), "Y,A,X,B,C,Z"); // clamped to the end
  r = await call("clone", { id: xId, index: 0 });
  assert.equal(r.ok, true, r.error); assert.equal(list.children[0].id, r.result.id);
  r = await call("delete", { ids: [r.result.id] });
  r = await call("update", { id: yId, props: { index: 3 } });
  assert.equal(list.children.indexOf(nodes.get(yId)), 3);
  r = await call("update", { id: yId, props: { index: 0 } });
  assert.equal(list.children[0].id, yId);
  // Figma's insertChild may count the moved node (index before removal): the result must still be the requested index
  const realInsert = Node.prototype.insertChild;
  Node.prototype.insertChild = function (i, c) {
    const before = this.children.indexOf(c);
    this.appendChild(c); const moved = this.children.pop();
    this.children.splice(before >= 0 && before < i ? i - 1 : i, 0, moved);
  };
  r = await call("update", { id: yId, props: { index: 3 } });
  Node.prototype.insertChild = realInsert;
  assert.equal(list.children.indexOf(nodes.get(yId)), 3, "index is correct even with the other insertChild semantics");
  console.log("ok: index on create / clone / update");

  // text is re-measured after width / font changes, and the auto-resize mode is restored
  r = await make({ type: "TEXT", name: "Title", characters: "Judul yang panjang", fontSize: 20, width: 200 });
  const title = nodes.get(r.result.rootId);
  textResizeLog.length = 0;
  r = await call("update", { id: title.id, props: { width: 300 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(J(textResizeLog.filter((e) => e.id === title.id).map((e) => e.v)), J(["HEIGHT", "NONE", "HEIGHT"]));
  textResizeLog.length = 0;
  r = await call("update", { id: title.id, props: { fontSize: 18 } });
  assert.equal(J(textResizeLog.map((e) => e.v)), J(["NONE", "HEIGHT"]));
  assert.equal(title.textAutoResize, "HEIGHT");
  title.textAutoResize = "NONE"; textResizeLog.length = 0;
  r = await call("update", { id: title.id, props: { fontSize: 16 } });
  assert.equal(textResizeLog.length, 0, "fixed-size text is left alone");
  console.log("ok: text re-measured after update");

  // new auto-layout frames hug unless sized
  r = await make({ type: "FRAME", layoutMode: "HORIZONTAL", children: [{ type: "TEXT", characters: "a" }] });
  let f1 = nodes.get(r.result.rootId);
  assert.equal(f1.layoutSizingHorizontal, "HUG"); assert.equal(f1.layoutSizingVertical, "HUG");
  r = await make({ type: "FRAME", layoutMode: "VERTICAL", width: 300 });
  f1 = nodes.get(r.result.rootId);
  assert.equal(f1.layoutSizingHorizontal, "FIXED"); assert.equal(f1.layoutSizingVertical, "HUG");
  assert.equal(f1.width, 300);
  r = await make({ type: "FRAME", layoutMode: "HORIZONTAL", primaryAxisSizingMode: "FIXED" });
  f1 = nodes.get(r.result.rootId);
  assert.equal(f1.layoutSizingHorizontal, "FIXED"); assert.equal(f1.layoutSizingVertical, "HUG");
  r = await make({ type: "FRAME", layoutMode: "VERTICAL", width: 500, children: [
    { type: "FRAME", name: "row", layoutMode: "HORIZONTAL", layoutSizingHorizontal: "FILL", children: [{ type: "TEXT", characters: "x" }] },
    { type: "FRAME", name: "pill", layoutMode: "HORIZONTAL", padding: 8, children: [{ type: "TEXT", characters: "tag" }] },
  ] });
  const col = nodes.get(r.result.rootId);
  assert.equal(col.children[0].layoutSizingHorizontal, "FILL"); assert.equal(col.children[0].layoutSizingVertical, "HUG");
  assert.equal(col.children[1].layoutSizingHorizontal, "HUG"); assert.equal(col.children[1].layoutSizingVertical, "HUG");
  r = await make({ type: "FRAME", name: "plain", width: 120 });
  assert.equal(nodes.get(r.result.rootId).width, 120); // no layoutMode: untouched
  console.log("ok: auto-layout frames hug by default");

  // gradient direction: direction / cssAngle / angle, readable back
  const stops = [{ position: 0, color: "#000000CC" }, { position: 1, color: "#00000000" }];
  const gradient = async (g) => {
    const made = await make({ type: "RECTANGLE", fills: [{ type: "GRADIENT_LINEAR", stops, ...g }] });
    assert.equal(made.ok, true, made.error);
    return (await call("get_node", { id: made.result.rootId, depth: 0 })).result.fills[0];
  };
  const cases = [
    [{ direction: "to right" }, 0], [{ direction: "to bottom" }, 90], [{ direction: "to left" }, 180], [{ direction: "to top" }, 270],
    [{ direction: "to bottom right" }, 45], [{ direction: "left top" }, 225], [{ direction: "to top right" }, 315],
    [{ cssAngle: 0 }, 270], [{ cssAngle: 90 }, 0], [{ cssAngle: 180 }, 90], [{ cssAngle: 270 }, 180], [{ cssAngle: 135 }, 45],
    [{ angle: 90 }, 90], [{}, 0],
  ];
  for (const [g, expected] of cases) {
    const f = await gradient(g);
    assert.equal(f.angle, expected, J(g) + " -> " + f.angle);
  }
  const gf = await gradient({ direction: "to bottom" });
  assert.equal(gf.type, "GRADIENT_LINEAR"); assert.equal(J(gf.stops), J([{ position: 0, color: "#000000CC" }, { position: 1, color: "#00000000" }]));
  r = await make({ type: "RECTANGLE", fills: [{ type: "GRADIENT_LINEAR", stops, direction: "diagonal" }] });
  assert.equal(r.ok, false); assert.match(r.error, /Unknown gradient direction/);
  console.log("ok: gradient direction (direction / cssAngle / angle) and read back");

  // absolute positioning inside an auto-layout parent: x/y must land
  r = await make({ type: "FRAME", name: "Hero", layoutMode: "VERTICAL", width: 400, height: 300, children: [
    { type: "TEXT", name: "flow", characters: "flow" },
    { type: "RECTANGLE", name: "Laptop", width: 80, height: 50, layoutPositioning: "ABSOLUTE", x: 300, y: 220, constraints: { horizontal: "MAX", vertical: "MAX" } },
  ] });
  assert.equal(r.ok, true, r.error);
  const laptop = nodes.get(r.result.created[2].id);
  assert.equal(laptop.layoutPositioning, "ABSOLUTE");
  assert.equal(laptop.x, 300); assert.equal(laptop.y, 220);
  assert.equal(J(laptop.constraints), J({ horizontal: "MAX", vertical: "MAX" }));
  r = await call("get_node", { id: laptop.id, depth: 0 });
  assert.equal(r.result.x, 300); assert.equal(r.result.y, 220); assert.equal(r.result.layoutPositioning, "ABSOLUTE");
  const flowText = nodes.get(r.result.id) && nodes.get(laptop.parent.children[0].id);
  r = await call("update", { id: flowText.id, props: { layoutPositioning: "ABSOLUTE", x: 10, y: 20 } });
  assert.equal(r.ok, true, r.error); assert.equal(flowText.x, 10); assert.equal(flowText.y, 20);
  r = await make({ type: "FRAME", children: [{ type: "RECTANGLE", layoutPositioning: "ABSOLUTE" }] });
  assert.equal(r.ok, false); assert.match(r.error, /needs a parent with auto layout/);
  console.log("ok: ABSOLUTE positioning returns x/y");

  // get_node survives figma.mixed and an unreadable child; unknown ids explain how to find ids
  r = await make({ type: "FRAME", name: "Weird", children: [{ type: "RECTANGLE", name: "ok" }, { type: "RECTANGLE", name: "bad" }] });
  const weird = nodes.get(r.result.rootId);
  weird.children[0].strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
  weird.children[0].strokeWeight = mixed;
  Object.defineProperty(weird.children[1], "fills", { get() { throw new Error("boom"); } });
  r = await call("get_node", { id: weird.id, depth: 2 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.children[0].strokeWeight, "mixed");
  assert.match(r.result.children[1].error, /boom/); assert.equal(r.result.children[1].name, "bad");
  r = await call("get_node", { id: "9:99" });
  assert.equal(r.ok, false); assert.match(r.error, /Node not found: 9:99/); assert.match(r.error, /figma_list_children/);
  console.log("ok: get_node robust (mixed, unreadable child, helpful not-found)");

  // list_children: current page, another page by name, by id
  await make({ type: "FRAME", name: "On page 2" }, { parentId: page2.id });
  r = await call("list_children", { pageName: "web flow" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.name, "Web Flow"); assert.equal(r.result.children[0].name, "On page 2");
  assert.equal(page2.loaded, true, "the page is loaded before its children are read");
  assert.equal(r.result.children[0].type, "FRAME"); assert.equal(typeof r.result.children[0].width, "number");
  r = await call("list_children", {});
  assert.equal(r.result.name, "Page 1"); assert.ok(r.result.children.length > 3);
  assert.ok(["id", "name", "type", "x", "y", "width", "height"].every((k) => k in r.result.children[0]));
  r = await call("list_children", { id: page2.id });
  assert.equal(r.result.children.length, 1);
  r = await call("list_children", { pageName: "Nope" });
  assert.equal(r.ok, false); assert.match(r.error, /Pages in this file: "Page 1", "Web Flow"/);
  r = await call("list_children", { id: fxId });
  assert.equal(r.ok, false); assert.match(r.error, /has no children/);
  console.log("ok: list_children");
}

// ======================= improvements from real use (phase 2)
{
  const J = (v) => JSON.stringify(v);
  const make = (spec, params = {}) => call("create", { spec, animate: false, ...params });

  // VECTOR: path normalising
  r = await make({ type: "VECTOR", name: "Tri", path: "M0 0 L40 0 l-20 30 z" });
  assert.equal(r.ok, true, r.error);
  let vec = nodes.get(r.result.rootId);
  assert.equal(vec.type, "VECTOR");
  assert.equal(J(vec.vectorPaths), J([{ windingRule: "NONZERO", data: "M 0 0 L 40 0 L 20 30 Z" }]));
  assert.equal(J(vec.fills), J([{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }])); // visible by default
  r = await make({ type: "VECTOR", width: 80, height: 60, strokes: "#FF0000", vectorPaths: [{ data: "M10,10H50V40h-40Z", windingRule: "EVENODD" }, "M0 0 C 0 10, 10 10, 10 0 S 20 -10 20 0 Q 25 5 30 0 T 40 0"] });
  assert.equal(r.ok, true, r.error);
  vec = nodes.get(r.result.rootId);
  assert.equal(vec.vectorPaths[0].windingRule, "EVENODD");
  assert.equal(vec.vectorPaths[0].data, "M 10 10 L 50 10 L 50 40 L 10 40 Z"); // H / V / relative h
  assert.equal(vec.vectorPaths[1].data, "M 0 0 C 0 10 10 10 10 0 C 10 -10 20 -10 20 0 Q 25 5 30 0 Q 35 -5 40 0"); // S and T reflect the last control point
  assert.equal(vec.width, 80); assert.equal(vec.fills.length, 1, "strokes only: default fill untouched"); // the mock's own default white fill
  r = await make({ type: "VECTOR", path: "M 0 0 l 10 10 5 0 z" });
  assert.equal(nodes.get(r.result.rootId).vectorPaths[0].data, "M 0 0 L 10 10 L 15 10 Z"); // implicit repeated lineto
  for (const [bad, re] of [["M 0 0 A 5 5 0 0 1 10 10", /arc.*SVG/], ["L 1 1", /start with M/], ["M 0 0 X 3", /Unknown path command|unexpected/], ["M 0", /malformed/], ["M 0 0 L #", /unexpected characters/]]) {
    r = await make({ type: "VECTOR", path: bad });
    assert.equal(r.ok, false, bad); assert.match(r.error, re, bad);
  }
  r = await make({ type: "VECTOR" });
  assert.equal(r.ok, false); assert.match(r.error, /needs spec.vectorPaths/);
  r = await make({ type: "VECTOR", path: "M 0 0 L 1 1", vectorPaths: [{ data: "M 0 0 L 1 1", windingRule: "ODD" }] });
  assert.equal(r.ok, false); assert.match(r.error, /windingRule/);
  console.log("ok: VECTOR paths");

  // figma_boolean
  r = await make({ type: "FRAME", name: "Logo", children: [{ type: "ELLIPSE", name: "a" }, { type: "ELLIPSE", name: "b" }, { type: "RECTANGLE", name: "c" }] });
  const logo = nodes.get(r.result.rootId);
  const [ea, eb, rc] = logo.children;
  r = await call("boolean", { operation: "subtract", ids: [ea.id, eb.id], name: "Crescent" });
  assert.equal(r.ok, true, r.error);
  const crescent = nodes.get(r.result.id);
  assert.equal(crescent.type, "BOOLEAN_OPERATION"); assert.equal(crescent.booleanOperation, "SUBTRACT"); assert.equal(crescent.name, "Crescent");
  assert.equal(crescent.children.length, 2); assert.equal(crescent.parent.id, logo.id);
  assert.equal(J(page.selection.map((n) => n.id)), J([crescent.id]));
  r = await call("boolean", { operation: "UNION", ids: [crescent.id, rc.id], flatten: true, name: "Mark", props: { x: 5 }, select: false, index: 0 });
  assert.equal(r.ok, true, r.error);
  const mark = nodes.get(r.result.id);
  assert.equal(mark.type, "VECTOR"); assert.equal(mark.name, "Mark"); assert.equal(mark.x, 5);
  assert.equal(J(page.selection.map((n) => n.id)), J([crescent.id]), "select:false leaves the selection alone");
  for (const [args, re] of [[{ operation: "MERGE", ids: ["1:1", "1:2"] }, /operation must be/], [{ operation: "UNION", ids: ["1:1"] }, /at least 2/], [{ operation: "UNION", ids: [mark.id, "9:99"] }, /Node not found: 9:99/], [{ operation: "UNION", ids: [page.id, mark.id] }, /page cannot be combined/]]) {
    r = await call("boolean", args);
    assert.equal(r.ok, false); assert.match(r.error, re);
  }
  console.log("ok: figma_boolean");

  // mixed text styles
  r = await make({ type: "TEXT", name: "Promo", fontSize: 20, textColor: "#111111", runs: [
    { text: "Hemat " },
    { text: "30%", fontStyle: "Bold", color: "#E11D48", fontSize: 28, textDecoration: "UNDERLINE", letterSpacing: 0.5, lineHeight: 32 },
    { text: " hari ini" },
  ] });
  assert.equal(r.ok, true, r.error);
  const promo = nodes.get(r.result.rootId);
  assert.equal(promo.characters, "Hemat 30% hari ini");
  assert.ok(fontsLoaded.includes("Inter Bold"), "the run's font is loaded before use");
  r = await call("get_node", { id: promo.id, depth: 0 });
  assert.equal(r.result.characters, "Hemat 30% hari ini");
  assert.equal(J(r.result.runs), J([
    { text: "Hemat ", fontSize: 20, fontFamily: "Inter", fontStyle: "Regular", color: "#111111" },
    { text: "30%", fontSize: 28, fontFamily: "Inter", fontStyle: "Bold", color: "#E11D48", textDecoration: "UNDERLINE", letterSpacing: 0.5, lineHeight: 32 },
    { text: " hari ini", fontSize: 20, fontFamily: "Inter", fontStyle: "Regular", color: "#111111" },
  ]));
  // ranges on existing text (update), end exclusive
  r = await make({ type: "TEXT", name: "Plain", characters: "Hello world", fontSize: 16 });
  const plain = nodes.get(r.result.rootId);
  r = await call("get_node", { id: plain.id, depth: 0 });
  assert.equal(r.result.runs, undefined, "uniform text has no runs");
  r = await call("update", { id: plain.id, props: { ranges: [{ start: 6, end: 11, fontStyle: "Bold", color: "#00FF00" }] } });
  assert.equal(r.ok, true, r.error);
  r = await call("get_node", { id: plain.id, depth: 0 });
  assert.equal(J(r.result.runs.map((x) => [x.text, x.fontStyle])), J([["Hello ", "Regular"], ["world", "Bold"]]));
  assert.equal(r.result.runs[1].color, "#00FF00");
  // runs on update replace the content
  textResizeLog.length = 0;
  r = await call("update", { id: plain.id, props: { runs: [{ text: "A", fontSize: 10 }, { text: "B", fontSize: 30 }] } });
  assert.equal(r.ok, true, r.error); assert.equal(plain.characters, "AB");
  assert.ok(textResizeLog.length >= 2, "re-measured after runs");
  for (const [props, re] of [[{ ranges: [{ start: 0, end: 99, fontSize: 9 }] }, /Text range 0 is invalid.*2 characters/], [{ ranges: [{ start: 1, end: 1, fontSize: 9 }] }, /invalid/], [{ runs: [] }, /non-empty/], [{ runs: [{ fontSize: 9 }] }, /needs a text string/], [{ ranges: "x" }, /ranges must be an array/]]) {
    r = await call("update", { id: plain.id, props });
    assert.equal(r.ok, false, J(props)); assert.match(r.error, re);
  }
  r = await make({ type: "TEXT", characters: "x", runs: [{ text: "y", fontFamily: "Nope" }] });
  assert.equal(r.ok, false); assert.match(r.error, /Font "Nope/);
  console.log("ok: mixed text styles (runs / ranges)");

  // create_variables
  const vars = await figma.variables.getLocalVariablesAsync();
  const before = vars.length;
  r = await call("create_variables", { collections: [
    { name: "tokens", modes: ["Light", "Dark"], variables: [
      { name: "color/primary", values: { Light: { alias: "palette/blue/500" }, Dark: "#60A5FA" }, description: "Brand color", scopes: ["ALL_FILLS"] },
      { name: "color/bg", values: { Light: "#FFFFFF", Dark: "#0B1220CC" } },
      { name: "radius/md", values: { Light: 12, Dark: 12 } },
      { name: "label", type: "STRING", values: "Beli" },
      { name: "enabled", values: { Dark: true, Light: false } },
    ] },
    { name: "palette", modes: ["Default"], variables: [
      { name: "blue/500", values: "#3B82F6" },
      { name: "space/4", values: 16 },
    ] },
  ] });
  assert.equal(r.ok, true, r.error);
  assert.equal(J({ ...r.result, collections: undefined }), J({ collectionsCreated: 2, variablesCreated: 7, variablesUpdated: 0, valuesSet: 10, aliasesSet: 1 }));
  assert.equal(J(r.result.collections), J([{ name: "tokens", modes: ["Light", "Dark"], variables: 5 }, { name: "palette", modes: ["Default"], variables: 2 }]));
  const allVars = await figma.variables.getLocalVariablesAsync();
  const allCols = await figma.variables.getLocalVariableCollectionsAsync();
  assert.equal(allVars.length, before + 7);
  const tokens = allCols.find((c) => c.name === "tokens"), palette = allCols.find((c) => c.name === "palette");
  const mode = (c, n) => c.modes.find((m) => m.name === n).modeId;
  const get = (col, name) => allVars.find((v) => v.variableCollectionId === col.id && v.name === name);
  const prim = get(tokens, "color/primary");
  assert.equal(prim.resolvedType, "COLOR"); assert.equal(prim.description, "Brand color"); assert.equal(J(prim.scopes), J(["ALL_FILLS"]));
  assert.equal(J(prim.valuesByMode[mode(tokens, "Light")]), J({ type: "VARIABLE_ALIAS", id: get(palette, "blue/500").id }), "alias to a variable created later in the same call");
  assert.equal(J(prim.valuesByMode[mode(tokens, "Dark")]), J({ r: 0x60 / 255, g: 0xa5 / 255, b: 0xfa / 255, a: 1 }));
  const bg = get(tokens, "color/bg");
  assert.ok(Math.abs(bg.valuesByMode[mode(tokens, "Dark")].a - 0xcc / 255) < 1e-9);
  assert.equal(get(tokens, "radius/md").resolvedType, "FLOAT");
  assert.equal(get(tokens, "label").valuesByMode[mode(tokens, "Light")], "Beli", "single value goes to the first mode");
  assert.equal(get(tokens, "enabled").resolvedType, "BOOLEAN");
  assert.equal(get(palette, "space/4").valuesByMode[mode(palette, "Default")], 16);
  assert.equal(tokens.modes.length, 2); assert.equal(tokens.modes[0].name, "Light", "default mode renamed, not duplicated");
  // idempotent: run again updates instead of duplicating; new mode and variable are added
  r = await call("create_variables", { collections: [
    { name: "tokens", modes: ["Light", "Dark", "Brand"], variables: [{ name: "radius/md", values: { Brand: 20 } }, { name: "radius/lg", values: 24 }] },
  ] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.collectionsCreated, 0); assert.equal(r.result.variablesUpdated, 1); assert.equal(r.result.variablesCreated, 1);
  assert.equal(tokens.modes.length, 3);
  assert.equal((await figma.variables.getLocalVariablesAsync()).length, before + 8);
  assert.equal(get(tokens, "radius/md").valuesByMode[mode(tokens, "Light")], 12, "other modes untouched");
  assert.equal(get(tokens, "radius/md").valuesByMode[mode(tokens, "Brand")], 20);
  // the new variables are usable right away
  r = await make({ type: "RECTANGLE", fills: "var:tokens/color/bg" });
  assert.equal(r.ok, true, r.error);
  // errors
  for (const [cols, re] of [
    [[{ name: "tokens", variables: [{ name: "radius/md", type: "COLOR", values: "#fff" }] }], /already exists as FLOAT, not COLOR/],
    [[{ name: "tokens", variables: [{ name: "x", values: { Nope: 1 } }] }], /Mode "Nope" does not exist.*Modes: Light, Dark, Brand/],
    [[{ name: "tokens", variables: [{ name: "x", type: "FLOAT", values: "abc" }] }], /FLOAT needs a number/],
    [[{ name: "tokens", variables: [{ name: "x", type: "BOOLEAN", values: 1 }] }], /BOOLEAN needs true or false/],
    [[{ name: "tokens", variables: [{ name: "x", type: "COLOR", values: "red" }] }], /Invalid color/],
    [[{ name: "tokens", variables: [{ name: "y", type: "COLOR", values: { alias: "palette/nope" } }] }], /alias target "palette\/nope" not found/],
    [[{ name: "tokens", variables: [{ name: "z", type: "COLOR", values: { alias: "palette/space/4" } }] }], /cannot alias palette\/space\/4 \(FLOAT\)/],
    [[{ variables: [] }], /needs a name/],
    [[], /collections is required/],
  ]) {
    r = await call("create_variables", { collections: cols });
    assert.equal(r.ok, false, J(cols)); assert.match(r.error, re, J(cols));
  }
  console.log("ok: create_variables");
}

// ======================= phase 3: fonts and imported pages
{
  const J = (v) => JSON.stringify(v);
  const make = (spec, params = {}) => call("create", { spec, animate: false, ...params });

  // style names are matched across spellings
  fontsLoaded.length = 0;
  r = await make({ type: "TEXT", characters: "a", fontFamily: "Poppins", fontStyle: "Semi Bold" });
  assert.equal(r.ok, true, r.error);
  assert.equal(J(nodes.get(r.result.rootId).fontName), J({ family: "Poppins", style: "SemiBold" }));
  assert.ok(fontsLoaded.includes("Poppins SemiBold"));
  r = await make({ type: "TEXT", characters: "a", fontFamily: "Inter", fontStyle: "SemiBold" });
  assert.equal(J(nodes.get(r.result.rootId).fontName), J({ family: "Inter", style: "Semi Bold" }));
  r = await make({ type: "TEXT", runs: [{ text: "x" }, { text: "y", fontFamily: "Poppins", fontStyle: "Semi Bold" }] });
  assert.equal(r.ok, true, r.error);
  const rn = await call("get_node", { id: r.result.rootId, depth: 0 });
  assert.equal(rn.result.runs[1].fontStyle, "SemiBold");
  r = await make({ type: "TEXT", characters: "a", fontFamily: "Poppins", fontStyle: "Bold" });
  assert.equal(nodes.get(r.result.rootId).fontName.style, "Bold");
  console.log("ok: font style spelling (SemiBold / Semi Bold)");

  // a missing font: error by default, substitution with fallbackFont
  r = await make({ type: "TEXT", characters: "a", fontFamily: "Missing Sans" });
  assert.equal(r.ok, false); assert.match(r.error, /Font "Missing Sans Regular" is not available/);
  r = await make({ type: "FRAME", children: [
    { type: "TEXT", characters: "a", fontFamily: "Missing Sans", fontStyle: "Bold" },
    { type: "TEXT", characters: "b", fontFamily: "Missing Sans", fontStyle: "Bold" },
    { type: "TEXT", runs: [{ text: "c" }, { text: "d", fontFamily: "Missing Sans", fontStyle: "Semi Bold" }] },
  ] }, { fallbackFont: "Inter" });
  assert.equal(r.ok, true, r.error);
  assert.equal(J(r.result.fontSubstitutions), J(["Missing Sans Bold -> Inter Bold", "Missing Sans Semi Bold -> Inter Semi Bold"]));
  const kids = nodes.get(r.result.rootId).children;
  assert.equal(J(kids[0].fontName), J({ family: "Inter", style: "Bold" }));
  r = await make({ type: "TEXT", characters: "a", fontFamily: "Missing Sans" });
  assert.equal(r.ok, false, "the fallback does not stay on after the call");
  r = await make({ type: "TEXT", characters: "a", fontFamily: "Missing Sans" }, { fallbackFont: "Also Missing" });
  assert.equal(r.ok, false); assert.match(r.error, /not available/);
  console.log("ok: fallbackFont");

  // a spec produced by the HTML converter (snapshot of test/fixtures/sample-page.html) is accepted as is
  const fixture = JSON.parse(fs.readFileSync("test/fixtures/sample-page.spec.json", "utf8"));
  const count = (n) => 1 + (n.children || []).reduce((a, c) => a + count(c), 0);
  r = await make(fixture, { fallbackFont: "Inter" });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.created.length, count(fixture));
  const page = nodes.get(r.result.rootId);
  assert.equal(page.width, 1440); assert.equal(page.layoutMode, "VERTICAL");
  const walk = (n, f) => { f(n); (n.children || []).forEach((c) => walk(c, f)); };
  const byName = (name) => { let hit; walk(page, (n) => { if (n.name === name && !hit) hit = n; }); return hit; };
  const hero = byName("section.hero");
  assert.equal(hero.layoutSizingHorizontal, "FILL");
  const badge = byName("span.badge");
  assert.equal(badge.layoutPositioning, "ABSOLUTE"); assert.ok(badge.x > 1000 && badge.y === 40, "absolute x/y landed inside an auto-layout parent");
  const line = byName("border-bottom");
  assert.equal(line.layoutPositioning, "ABSOLUTE"); assert.equal(line.height, 1);
  assert.ok(byName("spacer"), "spacer frames are created");
  assert.equal(byName("svg").svgSource.startsWith("<svg"), true);
  let h1; walk(page, (n) => { if (n.type === "TEXT" && n.characters && n.characters.startsWith("Kelola")) h1 = n; });
  const h1n = await call("get_node", { id: h1.id, depth: 0 });
  assert.equal(h1n.result.runs.length, 3); assert.equal(h1n.result.runs[1].color, "#2563EB"); assert.equal(h1n.result.fontName.family, "Poppins");
  console.log("ok: converter output is accepted by the plugin");
}

console.log("\nPLUGIN MOCK TESTS PASSED");
