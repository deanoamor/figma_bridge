// Claude Bridge - Figma plugin main code.
// Receives commands from ui.html (which holds the WebSocket to the local MCP server)
// and executes them with the Figma Plugin API.

figma.showUI(__html__, { width: 320, height: 450 });

// Build animation settings (changed from the plugin window, remembered between sessions)
var settings = { animate: true, speed: "normal" };
function pushSettings() {
  figma.ui.postMessage({ type: "settings", animate: settings.animate, speed: settings.speed });
}
function saveSettings() {
  if (figma.clientStorage) {
    try { figma.clientStorage.setAsync("settings", settings); } catch (e) {}
  }
}
if (figma.clientStorage) {
  figma.clientStorage.getAsync("settings").then(function (s) {
    if (s) {
      if (typeof s.animate === "boolean") settings.animate = s.animate;
      if (s.speed === "fast" || s.speed === "normal" || s.speed === "slow") settings.speed = s.speed;
    }
    pushSettings();
  }).catch(function () { pushSettings(); });
}

// ------------------------------------------------------------------ helpers
function round(n) { return typeof n === "number" ? Math.round(n * 100) / 100 : n; }

function hexToRgba(hex) {
  var h = String(hex).trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error("Invalid color: " + hex + " (use #RRGGBB or #RRGGBBAA)");
  if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
  if (h.length === 4) h = h.split("").map(function (c) { return c + c; }).join("");
  if (h.length !== 6 && h.length !== 8) throw new Error("Invalid color: " + hex + " (use #RRGGBB or #RRGGBBAA)");
  var n = function (i) { return parseInt(h.substr(i, 2), 16) / 255; };
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

function rgbToHex(c, a) {
  var p = function (v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? "0" + s : s; };
  var out = "#" + p(c.r) + p(c.g) + p(c.b);
  if (typeof a === "number" && a < 1) out += p(a);
  return out.toUpperCase();
}

function toPaint(p) {
  if (typeof p === "string") {
    var c = hexToRgba(p);
    return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  }
  if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL") {
    if (!p.stops || p.stops.length < 2) throw new Error("Gradient needs at least 2 stops");
    var stops = p.stops.map(function (s) {
      var c = hexToRgba(s.color);
      return { position: s.position, color: { r: c.r, g: c.g, b: c.b, a: c.a } };
    });
    var rad = ((p.angle || 0) * Math.PI) / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var t = [
      [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
      [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos],
    ];
    return { type: p.type, gradientStops: stops, gradientTransform: t };
  }
  // default: solid
  var c2 = hexToRgba(p.color || "#000000");
  return {
    type: "SOLID",
    color: { r: c2.r, g: c2.g, b: c2.b },
    opacity: typeof p.opacity === "number" ? p.opacity : c2.a,
  };
}

function toPaints(v) {
  if (v === "none" || v === null || (Array.isArray(v) && v.length === 0)) return [];
  if (!Array.isArray(v)) v = [v];
  return v.map(toPaint);
}

// ---- image fills
var SCALE_MODES = ["FILL", "FIT", "CROP", "TILE"];

// An IMAGE paint comes from one of: base64 (bytes sent by the server), imageHash (an image that
// already exists in this file), or fromNodeId (reuse the first image fill of another node).
async function toImagePaint(p) {
  var hash = p.imageHash;
  var scaleMode = p.scaleMode;
  if (!hash && p.fromNodeId) {
    var src = await getNode(p.fromNodeId);
    var srcFills = "fills" in src && Array.isArray(src.fills) ? src.fills : [];
    var found = null;
    for (var i = 0; i < srcFills.length; i++) {
      if (srcFills[i].type === "IMAGE") { found = srcFills[i]; break; }
    }
    if (!found) throw new Error("Node " + p.fromNodeId + " has no image fill to copy");
    hash = found.imageHash;
    if (scaleMode === undefined) scaleMode = found.scaleMode;
  }
  if (!hash && p.base64) {
    var image;
    try {
      image = figma.createImage(figma.base64Decode(p.base64));
    } catch (e) {
      throw new Error("Figma could not read this image (use PNG, JPEG or GIF): " + ((e && e.message) || e));
    }
    hash = image.hash;
  }
  if (!hash) throw new Error("IMAGE fill needs one of: url, path, base64, fromNodeId, imageHash");
  scaleMode = scaleMode || "FILL";
  if (SCALE_MODES.indexOf(scaleMode) < 0) throw new Error("scaleMode must be one of " + SCALE_MODES.join(", "));
  var paint = { type: "IMAGE", imageHash: hash, scaleMode: scaleMode };
  if (typeof p.opacity === "number") paint.opacity = p.opacity;
  if (typeof p.rotation === "number" && scaleMode !== "TILE") paint.rotation = p.rotation;
  if (scaleMode === "TILE" && typeof p.scale === "number") paint.scalingFactor = p.scale;
  return paint;
}

// Same as toPaints() but also understands IMAGE paints (which need async work).
async function toPaintsAsync(v) {
  if (v === "none" || v === null || (Array.isArray(v) && v.length === 0)) return [];
  if (!Array.isArray(v)) v = [v];
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var p = v[i];
    if (typeof p === "string" && p.indexOf("var:") === 0) p = { type: "SOLID", variable: p.slice(4) };
    if (p && typeof p === "object" && p.type === "IMAGE") out.push(await toImagePaint(p));
    else if (p && typeof p === "object" && p.variable) out.push(await toVariablePaint(p));
    else out.push(toPaint(p));
  }
  return out;
}

function toEffect(e) {
  if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
    return { type: e.type, radius: e.blur || e.radius || 4, visible: true };
  }
  var c = hexToRgba(e.color || "#000000");
  return {
    type: e.type || "DROP_SHADOW",
    color: { r: c.r, g: c.g, b: c.b, a: typeof e.opacity === "number" ? e.opacity : c.a === 1 ? 0.25 : c.a },
    offset: { x: e.x || 0, y: e.y || 0 },
    radius: e.blur || 0,
    spread: e.spread || 0,
    visible: true,
    blendMode: "NORMAL",
  };
}

var loadedFonts = {};
async function ensureFont(family, style) {
  var key = family + "|" + style;
  if (loadedFonts[key]) return;
  try {
    await figma.loadFontAsync({ family: family, style: style });
  } catch (e) {
    throw new Error('Font "' + family + " " + style + '" is not available. Try fontFamily "Inter" with fontStyle "Regular"/"Bold".');
  }
  loadedFonts[key] = true;
}

async function getParent(parentId) {
  if (!parentId) return figma.currentPage;
  var p = await figma.getNodeByIdAsync(parentId);
  if (!p) throw new Error("Parent not found: " + parentId);
  if (!("appendChild" in p)) throw new Error("Node " + parentId + " (" + p.type + ") cannot contain children");
  return p;
}

async function getNode(id) {
  var n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error("Node not found: " + id);
  return n;
}

// ---- variables: bind design tokens to nodes by name ("collection/variable", e.g. "light/primary")
var varCache = null; // reset for every command; { byKey: { "collection/name": Variable }, names: { id: "collection/name" } }
async function loadVars() {
  if (varCache) return varCache;
  var byKey = {}, names = {}, collections = [];
  if (figma.variables) {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var vars = await figma.variables.getLocalVariablesAsync();
    var colName = {};
    cols.forEach(function (c) { colName[c.id] = c.name; collections.push(c.name); });
    vars.forEach(function (v) {
      var key = (colName[v.variableCollectionId] || "?") + "/" + v.name;
      byKey[key] = v;
      names[v.id] = key;
    });
  }
  varCache = { byKey: byKey, names: names, collections: collections };
  return varCache;
}

async function findVariable(ref) {
  var c = await loadVars();
  if (c.byKey[ref]) return c.byKey[ref];
  var keys = Object.keys(c.byKey);
  var last = String(ref).split("/").pop();
  var close = keys.filter(function (k) { return k.indexOf(last) >= 0; }).slice(0, 6);
  throw new Error(
    'Variable "' + ref + '" not found. Use "collection/name", e.g. "light/primary" or "core/radius/md".' +
    (keys.length === 0 ? " This file has no local variables." : close.length ? " Similar: " + close.join(", ") : "")
  );
}

async function toVariablePaint(p) {
  var variable = await findVariable(p.variable);
  if (variable.resolvedType !== "COLOR") throw new Error('Variable "' + p.variable + '" is ' + variable.resolvedType + ", not COLOR");
  var paint = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
  if (typeof p.opacity === "number") paint.opacity = p.opacity;
  return figma.variables.setBoundVariableForPaint(paint, "color", variable);
}

function varName(alias) {
  return alias && alias.id ? (varCache && varCache.names[alias.id]) || alias.id : alias;
}

// Re-point every variable of collection `from` in a subtree to the same-named variable of collection `to`
// (e.g. light -> dark). Variables of other collections (e.g. core) are left alone.
async function rebindNode(node, from, to, stats, c) {
  function target(alias) {
    var key = alias && alias.id && c.names[alias.id];
    if (!key || key.indexOf(from + "/") !== 0) return null;
    var tkey = to + "/" + key.slice(from.length + 1);
    if (!c.byKey[tkey]) { stats.missing[tkey] = true; return null; }
    return c.byKey[tkey];
  }
  ["fills", "strokes"].forEach(function (k) {
    if (!(k in node) || !Array.isArray(node[k])) return;
    var changed = false;
    var next = node[k].map(function (p) {
      var a = p.type === "SOLID" && p.boundVariables && p.boundVariables.color;
      var v = a ? target(a) : null;
      if (!v) return p;
      changed = true;
      stats.rebound++;
      return figma.variables.setBoundVariableForPaint(p, "color", v);
    });
    if (changed) node[k] = next;
  });
  var bv = node.boundVariables || {};
  Object.keys(bv).forEach(function (field) {
    var a = bv[field];
    if (field === "fills" || field === "strokes" || !a || Array.isArray(a) || !a.id) return;
    var v = target(a);
    if (v) { node.setBoundVariable(field, v); stats.rebound++; }
  });
  if ("children" in node) {
    for (var i = 0; i < node.children.length; i++) await rebindNode(node.children[i], from, to, stats, c);
  }
}

// ------------------------------------------------------------- apply props
async function applyProps(node, spec, isCreate) {
  var type = node.type;
  var has = function (k) { return spec[k] !== undefined; };

  if (has("name")) node.name = String(spec.name);
  if (has("visible")) node.visible = !!spec.visible;
  if (has("opacity")) node.opacity = spec.opacity;
  if (has("rotation")) node.rotation = spec.rotation;

  // --- text content first (needs font)
  if (type === "TEXT") {
    var family = spec.fontFamily, style = spec.fontStyle;
    var hasFontChange = has("fontFamily") || has("fontStyle") || has("characters");
    if (hasFontChange) {
      var current = node.fontName;
      var curFam = current && current !== figma.mixed ? current.family : "Inter";
      var curSty = current && current !== figma.mixed ? current.style : "Regular";
      family = family || curFam;
      style = style || curSty;
      if (!isCreate && node.characters.length > 0 && current === figma.mixed) {
        var fonts = node.getRangeAllFontNames(0, node.characters.length);
        for (var i = 0; i < fonts.length; i++) await ensureFont(fonts[i].family, fonts[i].style);
      }
      await ensureFont(family, style);
      node.fontName = { family: family, style: style };
    }
    if (has("characters")) node.characters = String(spec.characters);
    if (has("fontSize")) node.fontSize = spec.fontSize;
    if (has("textAlignHorizontal")) node.textAlignHorizontal = spec.textAlignHorizontal;
    if (has("textAlignVertical")) node.textAlignVertical = spec.textAlignVertical;
    if (has("lineHeight")) node.lineHeight = { unit: "PIXELS", value: spec.lineHeight };
    if (has("letterSpacing")) node.letterSpacing = { unit: "PIXELS", value: spec.letterSpacing };
    if (has("textAutoResize")) node.textAutoResize = spec.textAutoResize;
    if (has("textColor")) node.fills = await toPaintsAsync(spec.textColor);
  }

  // --- size / position
  if (has("width") || has("height")) {
    if (type === "TEXT" && has("width") && !has("textAutoResize")) node.textAutoResize = "HEIGHT";
    var w = has("width") ? spec.width : node.width;
    var h = has("height") ? spec.height : node.height;
    if (type === "LINE") h = 0;
    node.resize(Math.max(w, 0.01), type === "LINE" ? 0.01 : Math.max(h, 0.01));
    if (type === "LINE") node.resize(Math.max(w, 0.01), 0);
  }
  if (has("x")) node.x = spec.x;
  if (has("y")) node.y = spec.y;

  // --- appearance
  if (has("fills") && "fills" in node) node.fills = await toPaintsAsync(spec.fills);
  if (has("strokes") && "strokes" in node) node.strokes = await toPaintsAsync(spec.strokes);
  if (has("strokeWeight") && "strokeWeight" in node) node.strokeWeight = spec.strokeWeight;
  if (has("strokeAlign") && "strokeAlign" in node) node.strokeAlign = spec.strokeAlign;
  if (has("cornerRadius") && "cornerRadius" in node) node.cornerRadius = spec.cornerRadius;
  ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"].forEach(function (k) {
    if (has(k) && k in node) node[k] = spec[k];
  });
  if (has("effects") && "effects" in node) node.effects = (spec.effects || []).map(toEffect);
  if (has("clipsContent") && "clipsContent" in node) node.clipsContent = !!spec.clipsContent;
  if (has("pointCount") && type === "POLYGON") node.pointCount = spec.pointCount;
  if (has("pointCount") && type === "STAR") node.pointCount = spec.pointCount;
  if (has("innerRadius") && type === "STAR") node.innerRadius = spec.innerRadius;

  // --- auto layout (frames)
  if (type === "FRAME" || type === "COMPONENT" || type === "INSTANCE") {
    if (has("layoutMode")) node.layoutMode = spec.layoutMode;
    if (has("layoutWrap")) node.layoutWrap = spec.layoutWrap;
    if (has("primaryAxisSizingMode")) node.primaryAxisSizingMode = spec.primaryAxisSizingMode;
    if (has("counterAxisSizingMode")) node.counterAxisSizingMode = spec.counterAxisSizingMode;
    if (has("primaryAxisAlignItems")) node.primaryAxisAlignItems = spec.primaryAxisAlignItems;
    if (has("counterAxisAlignItems")) node.counterAxisAlignItems = spec.counterAxisAlignItems;
    if (has("itemSpacing")) node.itemSpacing = spec.itemSpacing;
    if (has("counterAxisSpacing")) node.counterAxisSpacing = spec.counterAxisSpacing;
    if (has("padding")) {
      node.paddingTop = node.paddingRight = node.paddingBottom = node.paddingLeft = spec.padding;
    }
    if (has("paddingTop")) node.paddingTop = spec.paddingTop;
    if (has("paddingRight")) node.paddingRight = spec.paddingRight;
    if (has("paddingBottom")) node.paddingBottom = spec.paddingBottom;
    if (has("paddingLeft")) node.paddingLeft = spec.paddingLeft;
  }

  // --- child sizing inside an auto-layout parent (must be after being appended)
  var parent = node.parent;
  var inAutoLayout = parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  if (inAutoLayout) {
    if (has("layoutSizingHorizontal")) node.layoutSizingHorizontal = spec.layoutSizingHorizontal;
    if (has("layoutSizingVertical")) node.layoutSizingVertical = spec.layoutSizingVertical;
    if (has("layoutGrow")) node.layoutGrow = spec.layoutGrow;
    if (has("layoutAlign")) node.layoutAlign = spec.layoutAlign;
    if (has("layoutPositioning")) node.layoutPositioning = spec.layoutPositioning;
  } else if (
    (has("layoutSizingHorizontal") || has("layoutSizingVertical")) &&
    (node.type === "FRAME" || node.type === "COMPONENT") && node.layoutMode !== "NONE"
  ) {
    // a root auto-layout frame can HUG/FIXED itself
    if (has("layoutSizingHorizontal") && spec.layoutSizingHorizontal !== "FILL") node.layoutSizingHorizontal = spec.layoutSizingHorizontal;
    if (has("layoutSizingVertical") && spec.layoutSizingVertical !== "FILL") node.layoutSizingVertical = spec.layoutSizingVertical;
  }

  // --- variable bindings, last so layout and size are already set: { field: "collection/name" | null }
  if (has("bind") && spec.bind) {
    var fields = Object.keys(spec.bind);
    for (var bi = 0; bi < fields.length; bi++) {
      if (typeof node.setBoundVariable !== "function") throw new Error(type + " cannot bind variables");
      var ref = spec.bind[fields[bi]];
      var bound = ref === null ? null : await findVariable(ref);
      try {
        node.setBoundVariable(fields[bi], bound);
      } catch (e) {
        throw new Error('Cannot bind "' + fields[bi] + '" on ' + type + ": " + ((e && e.message) || e));
      }
    }
  }
}

// `anim` (array or null): when an array, every new node starts fully transparent and is
// recorded with its target opacity so revealNodes() can fade the design in step by step.
async function createNodeTree(spec, parent, created, anim) {
  var type = (spec.type || "FRAME").toUpperCase();
  var node;
  switch (type) {
    case "FRAME": node = figma.createFrame(); break;
    case "COMPONENT": node = figma.createComponent(); break;
    case "RECTANGLE": node = figma.createRectangle(); break;
    case "ELLIPSE": node = figma.createEllipse(); break;
    case "TEXT": node = figma.createText(); break;
    case "LINE": node = figma.createLine(); break;
    case "POLYGON": node = figma.createPolygon(); break;
    case "STAR": node = figma.createStar(); break;
    default: throw new Error("Unsupported node type: " + type);
  }
  parent.appendChild(node);
  if (anim) node.opacity = 0; // hide immediately so nothing flashes while it is being built
  // new frames have a white fill by default; make it explicit unless user set fills
  if ((type === "FRAME" || type === "COMPONENT") && spec.fills === undefined) node.fills = [];
  if (type === "TEXT" && spec.characters === undefined) spec = Object.assign({ characters: "" }, spec);
  if (type === "TEXT" && spec.fills === undefined && spec.textColor === undefined) {
    node.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
  }
  if (anim) {
    // keep the node hidden: apply everything except opacity, which revealNodes() restores
    await applyProps(node, Object.assign({}, spec, { opacity: undefined }), true);
    anim.push({ node: node, target: spec.opacity !== undefined ? spec.opacity : 1 });
  } else {
    await applyProps(node, spec, true);
  }
  created.push({ id: node.id, name: node.name, type: node.type });

  if (Array.isArray(spec.children)) {
    if (!("appendChild" in node)) throw new Error(type + " cannot have children");
    for (var i = 0; i < spec.children.length; i++) {
      await createNodeTree(spec.children[i], node, created, anim);
    }
  }
  return node;
}

// -------------------------------------------------------------- serializing
function simplifyPaints(paints) {
  if (paints === figma.mixed) return "mixed";
  if (!paints) return [];
  return paints.map(function (p) {
    if (p.type === "SOLID") {
      var sp = { type: "SOLID", color: rgbToHex(p.color, p.opacity === undefined ? 1 : p.opacity) };
      if (p.boundVariables && p.boundVariables.color) sp.variable = varName(p.boundVariables.color);
      return sp;
    }
    if (p.type === "IMAGE") return { type: "IMAGE", imageHash: p.imageHash, scaleMode: p.scaleMode };
    return { type: p.type };
  });
}

function serialize(node, depth) {
  var o = {
    id: node.id, name: node.name, type: node.type,
  };
  if ("visible" in node && node.visible === false) o.visible = false;
  if ("x" in node) { o.x = round(node.x); o.y = round(node.y); }
  if ("width" in node) { o.width = round(node.width); o.height = round(node.height); }
  if ("rotation" in node && node.rotation) o.rotation = round(node.rotation);
  if ("opacity" in node && node.opacity !== 1) o.opacity = node.opacity;
  if ("fills" in node) o.fills = simplifyPaints(node.fills);
  if ("strokes" in node && node.strokes.length) {
    o.strokes = simplifyPaints(node.strokes);
    o.strokeWeight = node.strokeWeight;
  }
  if ("cornerRadius" in node && node.cornerRadius !== 0) o.cornerRadius = node.cornerRadius === figma.mixed ? "mixed" : node.cornerRadius;
  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    o.layoutMode = node.layoutMode;
    o.itemSpacing = node.itemSpacing;
    o.padding = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
    o.primaryAxisAlignItems = node.primaryAxisAlignItems;
    o.counterAxisAlignItems = node.counterAxisAlignItems;
  }
  if ("layoutSizingHorizontal" in node && node.parent && "layoutMode" in node.parent && node.parent.layoutMode !== "NONE") {
    o.layoutSizingHorizontal = node.layoutSizingHorizontal;
    o.layoutSizingVertical = node.layoutSizingVertical;
  }
  if (node.type === "TEXT") {
    o.characters = node.characters;
    o.fontSize = node.fontSize === figma.mixed ? "mixed" : node.fontSize;
    o.fontName = node.fontName === figma.mixed ? "mixed" : node.fontName;
  }
  if (node.boundVariables) {
    var bound = {};
    Object.keys(node.boundVariables).forEach(function (k) {
      if (k === "fills" || k === "strokes") return; // shown on the paints themselves
      var a = node.boundVariables[k];
      bound[k] = Array.isArray(a) ? a.map(varName) : varName(a);
    });
    if (Object.keys(bound).length) o.bound = bound;
  }
  if ("children" in node) {
    if (depth > 0) o.children = node.children.map(function (c) { return serialize(c, depth - 1); });
    else o.childCount = node.children.length;
  }
  return o;
}

// ------------------------------------------------------- source / target slots
// The user marks a "source" (information to read) and a "target" (design to change) from the
// plugin window; Claude reads both with get_slots. Saved in the file so they survive restarts.
var slots = { source: [], target: [] };
try {
  var rawSlots = figma.root.getPluginData("claudeBridgeSlots");
  if (rawSlots) {
    var parsedSlots = JSON.parse(rawSlots);
    if (Array.isArray(parsedSlots.source)) slots.source = parsedSlots.source;
    if (Array.isArray(parsedSlots.target)) slots.target = parsedSlots.target;
  }
} catch (e) {}

function saveSlots() {
  try { figma.root.setPluginData("claudeBridgeSlots", JSON.stringify(slots)); } catch (e) {}
}

function brief(n) { return { id: n.id, name: n.name, type: n.type }; }

// Nodes of a slot that still exist (deleted ones are dropped from the slot)
async function resolveSlot(name) {
  var out = [];
  for (var i = 0; i < slots[name].length; i++) {
    var n = await figma.getNodeByIdAsync(slots[name][i]);
    if (n && !n.removed) out.push(n);
  }
  if (out.length !== slots[name].length) {
    slots[name] = out.map(function (x) { return x.id; });
    saveSlots();
  }
  return out;
}

async function pushSlots() {
  var s = await resolveSlot("source");
  var t = await resolveSlot("target");
  figma.ui.postMessage({ type: "slots", source: s.map(brief), target: t.map(brief) });
}

function checkSlotName(slot) {
  if (slot !== "source" && slot !== "target") throw new Error('slot must be "source" or "target"');
}

async function setSlot(slot, ids, clear) {
  checkSlotName(slot);
  if (clear) {
    slots[slot] = [];
  } else if (ids && ids.length) {
    for (var i = 0; i < ids.length; i++) await getNode(ids[i]); // throws if missing
    slots[slot] = ids.slice();
  } else {
    var sel = figma.currentPage.selection;
    if (sel.length === 0) throw new Error("Nothing is selected in Figma. Select something first (or pass ids).");
    slots[slot] = sel.map(function (n) { return n.id; });
  }
  saveSlots();
  await pushSlots();
}

// All visible text (in reading order: top to bottom, then left to right) and image-filled
// nodes under the given roots, so Claude can see the information without walking the tree.
function collectContent(roots) {
  var texts = [], images = [], truncated = false;
  function walk(node, path) {
    if (node.visible === false) return;
    var here = path.concat([node.name]);
    if (node.type === "TEXT") {
      if (texts.length >= 500) { truncated = true; return; }
      var box = node.absoluteBoundingBox;
      texts.push({
        id: node.id,
        path: here.join(" / "),
        characters: node.characters,
        fontSize: node.fontSize === figma.mixed ? "mixed" : node.fontSize,
        _x: box ? box.x : node.x,
        _y: box ? box.y : node.y,
      });
    } else if ("fills" in node && Array.isArray(node.fills) &&
               node.fills.some(function (f) { return f.type === "IMAGE"; })) {
      var imgFill = node.fills.filter(function (f) { return f.type === "IMAGE"; })[0];
      images.push({
        id: node.id, name: node.name, width: round(node.width), height: round(node.height),
        imageHash: imgFill.imageHash, scaleMode: imgFill.scaleMode,
      });
    }
    if ("children" in node) {
      for (var i = 0; i < node.children.length; i++) walk(node.children[i], here);
    }
  }
  roots.forEach(function (r) { walk(r, []); });
  texts.sort(function (a, b) {
    var ya = Math.round(a._y / 10), yb = Math.round(b._y / 10);
    return ya !== yb ? ya - yb : a._x - b._x;
  });
  texts.forEach(function (t) { delete t._x; delete t._y; });
  return { texts: texts, images: images, truncated: truncated };
}

async function describeSlot(name, depth) {
  var nodes = await resolveSlot(name);
  return {
    nodes: nodes.map(brief),
    content: collectContent(nodes),
    tree: nodes.map(function (n) { return serialize(n, depth); }),
  };
}

// ------------------------------------------------------------ build animation
var SPEED_MS = { fast: 40, normal: 90, slow: 180 }; // time per node
var MAX_ANIM_MS = 12000; // whole animation never takes longer than this

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Reveal nodes one by one in creation order (parent first, then its children, top to bottom),
// fading each in and moving the selection along so it looks like the design is being drawn.
async function revealNodes(anim, speed, root, followSelection) {
  if (anim.length === 0) return;
  var base = SPEED_MS[speed] || SPEED_MS.normal;
  var delay = Math.min(base, Math.floor(MAX_ANIM_MS / anim.length));
  figma.viewport.scrollAndZoomIntoView([root]);
  for (var i = 0; i < anim.length; i++) {
    var e = anim[i];
    if (e.node.removed) continue; // user deleted it meanwhile
    if (followSelection) figma.currentPage.selection = [e.node];
    if (delay >= 30) {
      var third = Math.floor(delay / 3);
      e.node.opacity = e.target / 3;
      await sleep(third);
      if (e.node.removed) continue;
      e.node.opacity = (e.target * 2) / 3;
      await sleep(third);
      if (e.node.removed) continue;
      e.node.opacity = e.target;
      await sleep(third);
    } else {
      e.node.opacity = e.target;
      await sleep(delay);
    }
  }
}

function restoreOpacity(anim) {
  for (var i = 0; i < anim.length; i++) {
    try { if (!anim[i].node.removed) anim[i].node.opacity = anim[i].target; } catch (err) {}
  }
}

// ----------------------------------------------------------------- commands
var handlers = {
  status: async function () {
    return {
      connected: true,
      file: figma.root.name,
      page: figma.currentPage.name,
      selectionCount: figma.currentPage.selection.length,
      pages: figma.root.children.map(function (p) { return { id: p.id, name: p.name }; }),
    };
  },

  // Combine COMPONENT nodes into one component set. Names must be "Property=Value, Property=Value".
  combine_variants: async function (p) {
    if (!Array.isArray(p.ids) || p.ids.length < 1) throw new Error("ids: at least one COMPONENT node id is required");
    var comps = [];
    for (var i = 0; i < p.ids.length; i++) {
      var n = await getNode(p.ids[i]);
      if (n.type !== "COMPONENT") throw new Error("Node " + p.ids[i] + " is " + n.type + ", not COMPONENT");
      if (!/^[^=,]+=[^=,]+(,\s*[^=,]+=[^=,]+)*$/.test(n.name)) {
        throw new Error('Component name "' + n.name + '" must look like "variant=default, size=md"');
      }
      comps.push(n);
    }
    var parent = p.parentId ? await getParent(p.parentId) : comps[0].parent;
    var set = figma.combineAsVariants(comps, parent);
    if (p.name) set.name = p.name;
    await loadVars(); // so the result shows variable names, not ids
    return serialize(set, 1);
  },

  // Copy a design to another theme: rebind_variables({id, from:"light", to:"dark"}) after figma_clone.
  rebind_variables: async function (p) {
    if (!p.id || !p.from || !p.to) throw new Error("id, from and to are required");
    var c = await loadVars();
    [p.from, p.to].forEach(function (n) {
      if (c.collections.indexOf(n) < 0) throw new Error('Collection "' + n + '" not found. Available: ' + c.collections.join(", "));
    });
    var node = await getNode(p.id);
    var stats = { rebound: 0, missing: {} };
    await rebindNode(node, p.from, p.to, stats, c);
    if (p.name) node.name = p.name;
    return { id: node.id, name: node.name, rebound: stats.rebound, missing: Object.keys(stats.missing) };
  },

  get_selection: async function (p) {
    var depth = p.depth === undefined ? 1 : p.depth;
    return figma.currentPage.selection.map(function (n) { return serialize(n, depth); });
  },

  get_node: async function (p) {
    var depth = p.depth === undefined ? 2 : p.depth;
    var node = p.id ? await getNode(p.id) : figma.currentPage;
    return serialize(node, depth);
  },

  create: async function (p) {
    if (!p.spec) throw new Error("spec is required");
    var parent = await getParent(p.parentId);
    var created = [];
    var animate = p.animate === undefined ? settings.animate : !!p.animate;
    var anim = animate ? [] : null;
    var root;
    try {
      root = await createNodeTree(p.spec, parent, created, anim);
      if (anim) await revealNodes(anim, p.speed || settings.speed, root, p.select !== false);
    } finally {
      if (anim) restoreOpacity(anim); // never leave anything transparent, even on error
    }
    if (p.select !== false) {
      figma.currentPage.selection = [root];
      figma.viewport.scrollAndZoomIntoView([root]);
    }
    return { rootId: root.id, created: created };
  },

  update: async function (p) {
    var node = await getNode(p.id);
    var props = p.props || {};
    if (props.parentId) {
      var newParent = await getParent(props.parentId);
      if (typeof props.index === "number") newParent.insertChild(props.index, node);
      else newParent.appendChild(node);
    }
    await applyProps(node, props, false);
    return serialize(node, 0);
  },

  delete: async function (p) {
    var removed = [];
    for (var i = 0; i < p.ids.length; i++) {
      var n = await figma.getNodeByIdAsync(p.ids[i]);
      if (n) { n.remove(); removed.push(p.ids[i]); }
    }
    return { removed: removed, notFound: p.ids.filter(function (id) { return removed.indexOf(id) < 0; }) };
  },

  clone: async function (p) {
    var node = await getNode(p.id);
    var copy = node.clone();
    if (p.parentId) (await getParent(p.parentId)).appendChild(copy);
    if (typeof p.x === "number") copy.x = p.x;
    if (typeof p.y === "number") copy.y = p.y;
    return serialize(copy, 0);
  },

  select: async function (p) {
    var nodes = [];
    for (var i = 0; i < p.ids.length; i++) nodes.push(await getNode(p.ids[i]));
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    return { selected: nodes.map(function (n) { return n.id; }) };
  },

  set_slot: async function (p) {
    await setSlot(p.slot, p.ids, p.clear);
    return { source: (await resolveSlot("source")).map(brief), target: (await resolveSlot("target")).map(brief) };
  },

  get_slots: async function (p) {
    var sd = p.sourceDepth === undefined ? 2 : p.sourceDepth;
    var td = p.targetDepth === undefined ? 4 : p.targetDepth;
    var source = await describeSlot("source", sd);
    var target = await describeSlot("target", td);
    var result = { source: source, target: target };
    if (source.nodes.length === 0 || target.nodes.length === 0) {
      result.note = "Slot " + (source.nodes.length === 0 ? "1 (source)" : "2 (target)") +
        " is empty. Ask the user to select the design in Figma and click \"Pakai seleksi\" in the Claude Bridge window, " +
        "or call figma_set_slot.";
    }
    return result;
  },

  export: async function (p) {
    var node = await getNode(p.id);
    if (!("exportAsync" in node)) throw new Error("Node " + p.id + " cannot be exported");
    var format = p.format || "PNG";
    var scale = p.scale || 1;
    var bytes = await node.exportAsync({ format: format, constraint: { type: "SCALE", value: scale } });
    return {
      base64: figma.base64Encode(bytes),
      mimeType: format === "JPG" ? "image/jpeg" : "image/png",
      name: node.name,
      width: Math.round(node.width * scale),
      height: Math.round(node.height * scale),
    };
  },
};

figma.ui.onmessage = async function (msg) {
  if (msg && msg.type === "ready") { pushSettings(); await pushSlots(); return; }
  if (msg && (msg.type === "set-slot" || msg.type === "clear-slot")) {
    try {
      await setSlot(msg.slot, null, msg.type === "clear-slot");
    } catch (e) {
      if (figma.notify) figma.notify(String((e && e.message) || e));
    }
    return;
  }
  if (msg && msg.type === "settings") {
    if (typeof msg.animate === "boolean") settings.animate = msg.animate;
    if (msg.speed === "fast" || msg.speed === "normal" || msg.speed === "slow") settings.speed = msg.speed;
    saveSettings();
    return;
  }
  if (!msg || msg.id === undefined) return;
  try {
    varCache = null;
    if (msg.command === "get_node" || msg.command === "get_selection" || msg.command === "get_slots") await loadVars();
    var handler = handlers[msg.command];
    if (!handler) throw new Error("Unknown command: " + msg.command);
    var result = await handler(msg.params || {});
    figma.ui.postMessage({ id: msg.id, ok: true, result: result });
  } catch (e) {
    figma.ui.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
};
