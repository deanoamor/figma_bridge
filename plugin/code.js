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

// Linear gradient direction. `angle` is in degrees, clockwise, 0 = left to right:
// 0 = to right, 90 = to bottom, 180 = to left, 270 = to top. For CSS-style values use
// `cssAngle` (0deg = to top, 90deg = to right, 180deg = to bottom) or `direction` ("to bottom right").
var GRADIENT_DIRECTIONS = {
  "right": 0, "bottom right": 45, "bottom": 90, "bottom left": 135,
  "left": 180, "top left": 225, "top": 270, "top right": 315,
};
function directionToAngle(dir) {
  var words = String(dir).toLowerCase().replace(/^to\s+/, "").trim().split(/\s+/);
  // "left top" means the same as "top left": put the vertical word first
  words.sort(function (a, b) {
    return (a === "top" || a === "bottom" ? 0 : 1) - (b === "top" || b === "bottom" ? 0 : 1);
  });
  var key = words.join(" ");
  if (GRADIENT_DIRECTIONS[key] === undefined) {
    throw new Error('Unknown gradient direction "' + dir + '". Use e.g. "to right", "to bottom", "to bottom right".');
  }
  return GRADIENT_DIRECTIONS[key];
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
    var angle = p.angle || 0;
    if (typeof p.cssAngle === "number") angle = p.cssAngle - 90;
    else if (typeof p.direction === "string") angle = directionToAngle(p.direction);
    var rad = (angle * Math.PI) / 180;
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
  if (!p) throw new Error("Parent not found: " + parentId + NODE_HINT);
  if (!("appendChild" in p)) throw new Error("Node " + parentId + " (" + p.type + ") cannot contain children");
  return p;
}

var NODE_HINT = ' Node ids look like "12:34" (copy them from a tool result, figma_list_children or figma_status). ' +
  "A deleted node or an id from another file no longer exists.";

async function getNode(id) {
  var n = typeof id === "string" && id ? await figma.getNodeByIdAsync(id) : null;
  if (!n) throw new Error("Node not found: " + id + "." + NODE_HINT);
  // with dynamic-page access a page's children are only readable after it is loaded
  if (n.type === "PAGE" && typeof n.loadAsync === "function") await n.loadAsync();
  return n;
}

// Move `node` (already a child of `parent`) so it ends up at position `index` (0 = first child,
// which is the first item in an auto-layout row/column). Out-of-range values are clamped.
function placeAt(parent, node, index) {
  if (typeof index !== "number" || !isFinite(index)) return;
  if (!("insertChild" in parent)) throw new Error("index needs a parent that can contain children");
  var target = Math.max(0, Math.min(Math.floor(index), parent.children.length - 1));
  parent.insertChild(target, node);
  // insertChild's index is relative to the list without the moved node; verify and correct once
  var actual = parent.children.indexOf(node);
  if (actual !== target && actual >= 0) {
    parent.insertChild(Math.max(0, Math.min(actual < target ? target + 1 : target - 1, parent.children.length - 1)), node);
  }
}

// Figma returns the `figma.mixed` symbol for properties that differ inside one node, and a
// symbol cannot be sent to the UI ("Cannot unwrap symbol"). Turn every symbol into "mixed".
function clean(v) {
  if (typeof v === "symbol") return "mixed";
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") {
    var out = {};
    Object.keys(v).forEach(function (k) { if (typeof v[k] !== "function") out[k] = clean(v[k]); });
    return out;
  }
  return v;
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

// Flipping the auto-resize mode forces Figma to recompute the text box from its current width,
// font and content; the original mode is restored afterwards.
function remeasureText(node) {
  var mode = node.textAutoResize;
  if (mode === "NONE" || mode === figma.mixed) return;
  node.textAutoResize = "NONE";
  node.textAutoResize = mode;
}

// ------------------------------------------------------------- vector paths
// Figma's vectorPaths understand M L C Q Z (absolute). Accept the full SVG path syntax except arcs:
// relative commands, H/V, S and T are converted; "A" is rejected with a pointer to the SVG node.
function normalizePathData(d) {
  var src = String(d);
  var re = /([a-zA-Z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  var toks = [], m;
  while ((m = re.exec(src))) toks.push(m[1] || parseFloat(m[2]));
  if (src.replace(re, "").replace(/[\s,]/g, "")) throw new Error('Path data has unexpected characters: "' + src.slice(0, 60) + '"');
  var arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };
  var out = [], i = 0, cx = 0, cy = 0, sx = 0, sy = 0, cmd = "", lastUp = "", lcx = 0, lcy = 0;
  var num = function () {
    var v = toks[i++];
    if (typeof v !== "number") throw new Error('Path data is malformed near "' + src.slice(0, 60) + '"');
    return v;
  };
  var f = function (n) { return String(Math.round(n * 1000) / 1000); };
  while (i < toks.length) {
    if (typeof toks[i] === "string") cmd = toks[i++];
    else if (!cmd) throw new Error('Path data is malformed near "' + src.slice(0, 60) + '"');
    var up = cmd.toUpperCase(), rel = cmd !== up;
    if (up === "A") {
      throw new Error('Path command "A" (arc) is not supported in vectorPaths. Use a node of type "SVG" for shapes with arcs, or approximate the arc with C curves.');
    }
    if (!(up in arity)) throw new Error('Unknown path command "' + cmd + '"');
    if (out.length === 0 && up !== "M") throw new Error('Path data must start with M (moveto)');
    var ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (up === "Z") { out.push("Z"); cx = sx; cy = sy; lastUp = "Z"; cmd = ""; continue; }
    if (up === "M") {
      var mx = num() + ox, my = num() + oy;
      out.push("M " + f(mx) + " " + f(my)); cx = sx = mx; cy = sy = my;
      cmd = rel ? "l" : "L"; // extra pairs after M are lineto
    } else if (up === "L") {
      var lx = num() + ox, ly = num() + oy; out.push("L " + f(lx) + " " + f(ly)); cx = lx; cy = ly;
    } else if (up === "H") {
      var hx = num() + ox; out.push("L " + f(hx) + " " + f(cy)); cx = hx;
    } else if (up === "V") {
      var vy = num() + oy; out.push("L " + f(cx) + " " + f(vy)); cy = vy;
    } else if (up === "C") {
      var c1x = num() + ox, c1y = num() + oy, c2x = num() + ox, c2y = num() + oy, ex = num() + ox, ey = num() + oy;
      out.push("C " + f(c1x) + " " + f(c1y) + " " + f(c2x) + " " + f(c2y) + " " + f(ex) + " " + f(ey));
      lcx = c2x; lcy = c2y; cx = ex; cy = ey;
    } else if (up === "S") {
      var s2x = num() + ox, s2y = num() + oy, sex = num() + ox, sey = num() + oy;
      var s1x = lastUp === "C" || lastUp === "S" ? 2 * cx - lcx : cx, s1y = lastUp === "C" || lastUp === "S" ? 2 * cy - lcy : cy;
      out.push("C " + f(s1x) + " " + f(s1y) + " " + f(s2x) + " " + f(s2y) + " " + f(sex) + " " + f(sey));
      lcx = s2x; lcy = s2y; cx = sex; cy = sey;
    } else if (up === "Q") {
      var q1x = num() + ox, q1y = num() + oy, qex = num() + ox, qey = num() + oy;
      out.push("Q " + f(q1x) + " " + f(q1y) + " " + f(qex) + " " + f(qey));
      lcx = q1x; lcy = q1y; cx = qex; cy = qey;
    } else if (up === "T") {
      var tex = num() + ox, tey = num() + oy;
      var t1x = lastUp === "Q" || lastUp === "T" ? 2 * cx - lcx : cx, t1y = lastUp === "Q" || lastUp === "T" ? 2 * cy - lcy : cy;
      out.push("Q " + f(t1x) + " " + f(t1y) + " " + f(tex) + " " + f(tey));
      lcx = t1x; lcy = t1y; cx = tex; cy = tey;
    }
    lastUp = up;
  }
  if (out.length === 0) throw new Error("Path data is empty");
  return out.join(" ");
}

// spec.vectorPaths: [{ data, windingRule? }] or ["M 0 0 L ..."]; spec.path: a single path string.
function toVectorPaths(spec) {
  var list = spec.vectorPaths !== undefined ? spec.vectorPaths : [spec.path];
  if (!Array.isArray(list) || list.length === 0) throw new Error("vectorPaths must be a non-empty array of path strings or { data, windingRule }");
  return list.map(function (e) {
    var data = typeof e === "string" ? e : e && e.data;
    if (typeof data !== "string") throw new Error("Each vector path needs a data string (SVG path syntax)");
    var rule = (e && e.windingRule) || "NONZERO";
    if (rule !== "NONZERO" && rule !== "EVENODD") throw new Error('windingRule must be "NONZERO" or "EVENODD"');
    return { windingRule: rule, data: normalizePathData(data) };
  });
}

// ------------------------------------------------------------- mixed text styles
// spec.runs: [{ text, fontSize?, fontFamily?, fontStyle?, color?, textDecoration?, letterSpacing?, lineHeight? }]
// builds the text from the runs; spec.ranges: [{ start, end, ...same style fields }] styles part of `characters`.
var RUN_STYLE_KEYS = ["fontSize", "fontFamily", "fontStyle", "color", "textDecoration", "letterSpacing", "lineHeight"];

function prepareRuns(spec) {
  var ranges = [], chars = "";
  if (spec.runs !== undefined) {
    if (!Array.isArray(spec.runs) || spec.runs.length === 0) throw new Error("runs must be a non-empty array of { text, ...style }");
    spec.runs.forEach(function (r, i) {
      if (!r || typeof r.text !== "string") throw new Error("runs[" + i + "] needs a text string");
      var rr = { start: chars.length, end: chars.length + r.text.length };
      RUN_STYLE_KEYS.forEach(function (k) { if (r[k] !== undefined) rr[k] = r[k]; });
      chars += r.text;
      if (rr.end > rr.start) ranges.push(rr);
    });
  } else {
    if (!Array.isArray(spec.ranges)) throw new Error("ranges must be an array of { start, end, ...style }");
    ranges = spec.ranges;
  }
  var out = Object.assign({}, spec, { _ranges: ranges });
  if (spec.runs !== undefined) out.characters = chars;
  return out;
}

async function applyTextRanges(node, ranges) {
  var len = node.characters.length;
  for (var i = 0; i < ranges.length; i++) {
    var r = ranges[i], a = r.start, b = r.end;
    if (typeof a !== "number" || typeof b !== "number" || a < 0 || b > len || a >= b) {
      throw new Error("Text range " + i + " is invalid: start " + a + ", end " + b + " (the text has " + len + " characters; end is exclusive)");
    }
    if (r.fontFamily !== undefined || r.fontStyle !== undefined) {
      var cur = node.getRangeFontName(a, b);
      var fam = r.fontFamily || (cur !== figma.mixed ? cur.family : node.fontName !== figma.mixed ? node.fontName.family : "Inter");
      var sty = r.fontStyle || (cur !== figma.mixed ? cur.style : "Regular");
      await ensureFont(fam, sty);
      node.setRangeFontName(a, b, { family: fam, style: sty });
    }
    if (r.fontSize !== undefined) node.setRangeFontSize(a, b, r.fontSize);
    if (r.color !== undefined) node.setRangeFills(a, b, await toPaintsAsync(r.color));
    if (r.textDecoration !== undefined) node.setRangeTextDecoration(a, b, r.textDecoration);
    if (r.letterSpacing !== undefined) node.setRangeLetterSpacing(a, b, { unit: "PIXELS", value: r.letterSpacing });
    if (r.lineHeight !== undefined) node.setRangeLineHeight(a, b, { unit: "PIXELS", value: r.lineHeight });
  }
}

function serializeRuns(node) {
  if (typeof node.getStyledTextSegments !== "function" || !node.characters.length) return undefined;
  var segs;
  try { segs = node.getStyledTextSegments(["fontSize", "fontName", "fills", "textDecoration", "letterSpacing", "lineHeight"]); }
  catch (e) { return undefined; }
  if (!segs || segs.length < 2) return undefined;
  return segs.map(function (g) {
    var run = { text: g.characters, fontSize: g.fontSize };
    if (g.fontName && g.fontName !== figma.mixed) { run.fontFamily = g.fontName.family; run.fontStyle = g.fontName.style; }
    var fl = simplifyPaints(g.fills);
    if (Array.isArray(fl) && fl.length === 1 && fl[0].type === "SOLID") run.color = fl[0].color;
    else if (Array.isArray(fl) && fl.length) run.color = fl;
    if (g.textDecoration && g.textDecoration !== "NONE") run.textDecoration = g.textDecoration;
    if (g.letterSpacing && g.letterSpacing.value) run.letterSpacing = g.letterSpacing.unit === "PIXELS" ? round(g.letterSpacing.value) : round(g.letterSpacing.value) + "%";
    if (g.lineHeight && g.lineHeight.unit === "PIXELS") run.lineHeight = round(g.lineHeight.value);
    return run;
  });
}

// ------------------------------------------------------------- apply props
async function applyProps(node, spec, isCreate) {
  var type = node.type;
  var has = function (k) { return spec[k] !== undefined; };
  if (type === "TEXT" && (has("runs") || has("ranges"))) spec = prepareRuns(spec);

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
    if (spec._ranges) await applyTextRanges(node, spec._ranges);
  }

  // --- vector paths (before size, so width/height scale the drawn path)
  if (type === "VECTOR" && (has("vectorPaths") || has("path"))) {
    node.vectorPaths = toVectorPaths(spec);
    if (isCreate && spec.fills === undefined && spec.strokes === undefined) node.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
  }

  // --- absolute positioning inside an auto-layout parent. This must come BEFORE x/y: while the node
  // is still part of the flow, Figma ignores x/y.
  var flowParent = node.parent;
  var flowParentIsAuto = !!(flowParent && "layoutMode" in flowParent && flowParent.layoutMode !== "NONE");
  if (has("layoutPositioning")) {
    if (spec.layoutPositioning === "ABSOLUTE" && !flowParentIsAuto) {
      throw new Error('layoutPositioning "ABSOLUTE" needs a parent with auto layout (layoutMode HORIZONTAL or VERTICAL)');
    }
    if (flowParentIsAuto) node.layoutPositioning = spec.layoutPositioning;
  }
  if (has("constraints") && "constraints" in node) node.constraints = spec.constraints;

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

    // A new auto-layout frame used to stay 100x100 unless both axes were set. Hug the content on
    // every axis the caller did not size (width/height, layoutSizing*, or an *AxisSizingMode).
    if (isCreate && (spec.layoutMode === "HORIZONTAL" || spec.layoutMode === "VERTICAL") && type !== "INSTANCE") {
      var rowLayout = spec.layoutMode === "HORIZONTAL";
      var sizedH = has("width") || has("layoutSizingHorizontal") || has(rowLayout ? "primaryAxisSizingMode" : "counterAxisSizingMode");
      var sizedV = has("height") || has("layoutSizingVertical") || has(rowLayout ? "counterAxisSizingMode" : "primaryAxisSizingMode");
      if (!sizedH) node.layoutSizingHorizontal = "HUG";
      if (!sizedV) node.layoutSizingVertical = "HUG";
    }
  }

  // --- child sizing inside an auto-layout parent (must be after being appended)
  var parent = node.parent;
  var inAutoLayout = parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  if (inAutoLayout) {
    if (has("layoutSizingHorizontal")) node.layoutSizingHorizontal = spec.layoutSizingHorizontal;
    if (has("layoutSizingVertical")) node.layoutSizingVertical = spec.layoutSizingVertical;
    if (has("layoutGrow")) node.layoutGrow = spec.layoutGrow;
    if (has("layoutAlign")) node.layoutAlign = spec.layoutAlign;
  } else if (
    (has("layoutSizingHorizontal") || has("layoutSizingVertical")) &&
    (node.type === "FRAME" || node.type === "COMPONENT") && node.layoutMode !== "NONE"
  ) {
    // a root auto-layout frame can HUG/FIXED itself
    if (has("layoutSizingHorizontal") && spec.layoutSizingHorizontal !== "FILL") node.layoutSizingHorizontal = spec.layoutSizingHorizontal;
    if (has("layoutSizingVertical") && spec.layoutSizingVertical !== "FILL") node.layoutSizingVertical = spec.layoutSizingVertical;
  }

  // --- text: re-measure after width / font / content / layout changes. Figma does not always recompute
  // the height right away (a title stayed 3 lines tall although its new width fits in 2).
  if (type === "TEXT" && (has("width") || has("fontSize") || has("fontFamily") || has("fontStyle") ||
      has("characters") || has("runs") || has("ranges") || has("lineHeight") || has("letterSpacing") || has("textAutoResize") ||
      has("layoutSizingHorizontal") || has("layoutSizingVertical"))) {
    remeasureText(node);
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
    case "VECTOR":
      if (spec.vectorPaths === undefined && spec.path === undefined) throw new Error('VECTOR node needs spec.vectorPaths (or spec.path) with SVG path data, e.g. path: "M 0 0 L 10 0 L 5 8 Z"');
      node = figma.createVector();
      break;
    case "SVG":
      // spec.svg = SVG markup; Figma turns it into a frame holding editable vectors
      if (typeof spec.svg !== "string" || spec.svg.indexOf("<svg") === -1) {
        throw new Error("SVG node needs spec.svg (an SVG markup string starting with <svg)");
      }
      node = figma.createNodeFromSvg(spec.svg);
      break;
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
    if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL") {
      var gp = { type: p.type };
      if (p.type === "GRADIENT_LINEAR" && p.gradientTransform) gp.angle = gradientAngle(p.gradientTransform);
      gp.stops = (p.gradientStops || []).map(function (s) {
        return { position: round(s.position), color: rgbToHex(s.color, s.color.a === undefined ? 1 : s.color.a) };
      });
      return gp;
    }
    return { type: p.type };
  });
}

// Inverse of the angle used when creating a linear gradient (same convention: 0 = left to right,
// 90 = top to bottom, clockwise).
function gradientAngle(t) {
  var a = (Math.atan2(t[0][1], t[0][0]) * 180) / Math.PI;
  if (a < 0) a += 360;
  return Math.round(a * 100) / 100;
}

// Effects use the same format figma_create accepts: { type, color, opacity, x, y, blur, spread }.
function serializeEffect(e) {
  var o;
  if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
    o = { type: e.type, blur: e.radius };
  } else {
    o = {
      type: e.type,
      color: rgbToHex(e.color),
      opacity: round(e.color.a === undefined ? 1 : e.color.a),
      x: e.offset ? e.offset.x : 0,
      y: e.offset ? e.offset.y : 0,
      blur: e.radius,
      spread: e.spread || 0,
    };
  }
  if (e.visible === false) o.visible = false;
  return o;
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
  if ("effects" in node && Array.isArray(node.effects) && node.effects.length) o.effects = node.effects.map(serializeEffect);
  if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") o.layoutPositioning = "ABSOLUTE";
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
    var runs = serializeRuns(node);
    if (runs) o.runs = runs;
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
    if (depth > 0) {
      o.children = node.children.map(function (c) {
        // one unreadable child must not make the whole call fail
        try { return serialize(c, depth - 1); }
        catch (e) { return { id: c.id, name: c.name, type: c.type, error: String((e && e.message) || e) }; }
      });
    } else o.childCount = node.children.length;
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

  // Read-only: local variable collections and their variables (used to bind tokens to nodes by name).
  list_variables: async function () {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var vars = await figma.variables.getLocalVariablesAsync();
    return cols.map(function (c) {
      var own = vars.filter(function (v) { return v.variableCollectionId === c.id; });
      return {
        id: c.id,
        name: c.name,
        modes: c.modes.map(function (m) { return m.name; }),
        variableCount: own.length,
        variables: own.map(function (v) {
          return { id: v.id, name: v.name, type: v.resolvedType, hasDescription: !!v.description };
        }),
      };
    });
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

  // Direct children of a page or node: id, name, type, position and size. With no id: the current
  // page; with pageName: that page (works for pages other than the one that is open).
  list_children: async function (p) {
    var node;
    if (p.id) {
      node = await getNode(p.id);
    } else if (p.pageName) {
      var pages = figma.root.children;
      var wanted = String(p.pageName).toLowerCase();
      node = pages.filter(function (pg) { return pg.name.toLowerCase() === wanted; })[0];
      if (!node) {
        throw new Error('Page "' + p.pageName + '" not found. Pages in this file: ' +
          pages.map(function (pg) { return '"' + pg.name + '"'; }).join(", "));
      }
      if (typeof node.loadAsync === "function") await node.loadAsync();
    } else {
      node = figma.currentPage;
    }
    if (!("children" in node)) throw new Error("Node " + node.id + " (" + node.type + ") has no children");
    return {
      id: node.id, name: node.name, type: node.type,
      children: node.children.map(function (c) {
        var o = { id: c.id, name: c.name, type: c.type };
        if ("x" in c) { o.x = round(c.x); o.y = round(c.y); }
        if ("width" in c) { o.width = round(c.width); o.height = round(c.height); }
        if ("visible" in c && c.visible === false) o.visible = false;
        if ("children" in c) o.childCount = c.children.length;
        return o;
      }),
    };
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
    placeAt(parent, root, p.index); // insert at a position instead of the end of the parent
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
    } else if (typeof props.index === "number" && node.parent) {
      placeAt(node.parent, node, props.index); // reorder inside the current parent
    }
    await applyProps(node, props, false);
    return serialize(node, 0);
  },

  boolean: async function (p) {
    var fnName = { UNION: "union", SUBTRACT: "subtract", INTERSECT: "intersect", EXCLUDE: "exclude" };
    var op = String(p.operation || "").toUpperCase();
    if (!fnName[op]) throw new Error("operation must be UNION, SUBTRACT, INTERSECT or EXCLUDE");
    if (!Array.isArray(p.ids) || p.ids.length < 2) throw new Error("ids needs at least 2 node ids");
    var parts = [];
    for (var i = 0; i < p.ids.length; i++) {
      var part = await getNode(p.ids[i]);
      if (part.type === "PAGE" || part.type === "DOCUMENT") throw new Error("A page cannot be combined: " + p.ids[i]);
      parts.push(part);
    }
    var parent = p.parentId ? await getParent(p.parentId) : parts[0].parent;
    var result = figma[fnName[op]](parts, parent, p.index);
    if (p.flatten) result = figma.flatten([result], parent);
    if (p.name) result.name = String(p.name);
    if (p.props) await applyProps(result, p.props, false);
    if (p.select !== false) figma.currentPage.selection = [result];
    return serialize(result, 0);
  },

  create_variables: async function (p) {
    if (!figma.variables) throw new Error("This Figma version has no variables API");
    if (!Array.isArray(p.collections) || p.collections.length === 0) throw new Error("collections is required: [{ name, modes?, variables: [{ name, type?, values }] }]");
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var existing = await figma.variables.getLocalVariablesAsync();
    var colById = {};
    cols.forEach(function (c) { colById[c.id] = c; });
    var byKey = {};
    existing.forEach(function (v) { var c = colById[v.variableCollectionId]; if (c) byKey[c.name + "/" + v.name] = v; });
    var stats = { collectionsCreated: 0, variablesCreated: 0, variablesUpdated: 0, valuesSet: 0, aliasesSet: 0 };
    var pending = [], summary = [];

    var inferType = function (val) {
      if (typeof val === "number") return "FLOAT";
      if (typeof val === "boolean") return "BOOLEAN";
      if (typeof val === "string" && /^#[0-9a-fA-F]{3,8}$/.test(val.trim())) return "COLOR";
      return "STRING";
    };
    var convert = function (type, val, label) {
      if (type === "COLOR") return hexToRgba(val);
      if (type === "FLOAT") {
        if (typeof val !== "number" || !isFinite(val)) throw new Error(label + ": FLOAT needs a number, got " + JSON.stringify(val));
        return val;
      }
      if (type === "BOOLEAN") {
        if (typeof val !== "boolean") throw new Error(label + ": BOOLEAN needs true or false, got " + JSON.stringify(val));
        return val;
      }
      return String(val);
    };

    for (var ci = 0; ci < p.collections.length; ci++) {
      var cs = p.collections[ci];
      if (!cs || typeof cs.name !== "string" || !cs.name) throw new Error("collections[" + ci + "] needs a name");
      var col = null;
      for (var k = 0; k < cols.length; k++) if (cols[k].name === cs.name) col = cols[k];
      var modeNames = Array.isArray(cs.modes) ? cs.modes.map(String) : [];
      if (!col) {
        col = figma.variables.createVariableCollection(cs.name);
        cols.push(col);
        stats.collectionsCreated++;
        if (modeNames.length) col.renameMode(col.modes[0].modeId, modeNames[0]); // the default mode becomes the first one
      }
      modeNames.forEach(function (mn) {
        if (!col.modes.some(function (m) { return m.name === mn; })) col.addMode(mn);
      });
      var modeId = function (name) {
        for (var mi = 0; mi < col.modes.length; mi++) if (col.modes[mi].name === name) return col.modes[mi].modeId;
        throw new Error('Mode "' + name + '" does not exist in collection "' + cs.name + '". Modes: ' + col.modes.map(function (m) { return m.name; }).join(", "));
      };
      var list = Array.isArray(cs.variables) ? cs.variables : [];
      for (var vi = 0; vi < list.length; vi++) {
        var vs = list[vi];
        var label = cs.name + "/" + (vs && vs.name);
        if (!vs || typeof vs.name !== "string" || !vs.name) throw new Error("collections[" + ci + "].variables[" + vi + "] needs a name");
        var vals = vs.values !== undefined ? vs.values : vs.value;
        var plain = vals !== null && typeof vals === "object" && !vals.alias;
        var type = vs.type ? String(vs.type).toUpperCase() : null;
        if (!type && vals !== undefined) {
          // infer from the first literal value; if every value is an alias, from an existing target
          var candidates = plain ? Object.keys(vals).map(function (mk0) { return vals[mk0]; }) : [vals];
          for (var ti = 0; ti < candidates.length && !type; ti++) {
            var cand = candidates[ti];
            if (cand && typeof cand === "object" && cand.alias) { if (byKey[cand.alias]) type = byKey[cand.alias].resolvedType; }
            else type = inferType(cand);
          }
          if (!type) throw new Error(label + ': give a type (COLOR, FLOAT, STRING or BOOLEAN): every value is an alias to a variable that does not exist yet');
        }
        if (!type) throw new Error(label + ": give a type (COLOR, FLOAT, STRING or BOOLEAN) when there is no value");
        if (["COLOR", "FLOAT", "STRING", "BOOLEAN"].indexOf(type) < 0) throw new Error(label + ': type must be COLOR, FLOAT, STRING or BOOLEAN (got "' + vs.type + '")');
        // validate everything before touching the file, so a bad value leaves no half-made variable
        var perMode = vals === undefined ? {} : plain ? vals : (function () { var o = {}; o[col.modes[0].name] = vals; return o; })();
        var writes = Object.keys(perMode).map(function (modeName) {
          var mval = perMode[modeName], isAlias = !!(mval && typeof mval === "object" && mval.alias);
          return { modeId: modeId(modeName), alias: isAlias ? mval.alias : null, value: isAlias ? null : convert(type, mval, label + " (" + modeName + ")") };
        });
        var variable = byKey[label];
        if (variable) {
          if (variable.resolvedType !== type) throw new Error(label + " already exists as " + variable.resolvedType + ", not " + type);
          stats.variablesUpdated++;
        } else {
          variable = figma.variables.createVariable(vs.name, col, type);
          byKey[label] = variable;
          stats.variablesCreated++;
        }
        if (vs.description !== undefined) variable.description = String(vs.description);
        if (vs.scopes !== undefined) variable.scopes = vs.scopes;
        writes.forEach(function (w) {
          if (w.alias) { pending.push({ variable: variable, modeId: w.modeId, ref: w.alias, label: label }); return; }
          variable.setValueForMode(w.modeId, w.value);
          stats.valuesSet++;
        });
      }
      summary.push({ name: cs.name, modes: col.modes.map(function (m) { return m.name; }), variables: list.length });
    }

    // aliases last: the target may live in a collection that was created after the alias
    for (var pi = 0; pi < pending.length; pi++) {
      var pa = pending[pi], target = byKey[pa.ref];
      if (!target) {
        var tail = String(pa.ref).split("/").pop();
        var near = Object.keys(byKey).filter(function (key) { return key.indexOf(tail) >= 0; }).slice(0, 5);
        throw new Error(pa.label + ': alias target "' + pa.ref + '" not found. Use "collection/name".' + (near.length ? " Similar: " + near.join(", ") : ""));
      }
      if (target.resolvedType !== pa.variable.resolvedType) throw new Error(pa.label + ": cannot alias " + pa.ref + " (" + target.resolvedType + ") from a " + pa.variable.resolvedType + " variable");
      pa.variable.setValueForMode(pa.modeId, figma.variables.createVariableAlias(target));
      stats.aliasesSet++;
    }
    varCache = null;
    return Object.assign(stats, { collections: summary });
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
    if (copy.parent) placeAt(copy.parent, copy, p.index); // no-op without index
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
    if (format === "SVG") {
      // vector export: text becomes outlines unless outlineText is false, so the shape matches the design
      var svg = await node.exportAsync({
        format: "SVG_STRING",
        svgOutlineText: p.outlineText !== false,
        svgIdAttribute: !!p.includeIds,
        svgSimplifyStroke: true,
      });
      return { svg: svg, name: node.name, width: Math.round(node.width), height: Math.round(node.height) };
    }
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
    figma.ui.postMessage({ id: msg.id, ok: true, result: clean(result) });
  } catch (e) {
    figma.ui.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
};
