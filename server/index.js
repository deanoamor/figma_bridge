#!/usr/bin/env node
// MCP server (stdio) <-> WebSocket bridge to the Figma plugin.
// IMPORTANT: stdout is reserved for the MCP protocol. Log only to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 3055);
const HOST = "127.0.0.1"; // localhost only, never exposed to the network
const TIMEOUT_MS = Number(process.env.FIGMA_BRIDGE_TIMEOUT_MS || 30000);

const log = (...a) => console.error("[figma-bridge]", ...a);

// ---------------------------------------------------------------- WebSocket
// One server instance (the "primary") owns the port and talks to the Figma plugin.
// If the MCP client starts this server more than once (Claude Desktop does this for chat
// and for Code/Cowork sessions), the other instances become "relay clients": they connect
// to the primary and forward their Figma calls through it. If the primary goes away,
// a relay client takes over the port.
let mode = "starting"; // "primary" | "client" | "starting"
let wss = null;
let plugin = null;   // primary: the connected Figma plugin
let upstream = null; // client: connection to the primary
let nextId = 1;
const pending = new Map(); // locally originated calls: id -> { resolve, reject, timer }
const routed = new Map();  // primary: plugin call id -> { ws, id, timer } for relayed calls

const NOT_CONNECTED =
  "Figma plugin is not connected. In Figma: Plugins > Development > Claude Bridge, " +
  "and keep its window open.";

const isOpen = (ws) => ws && ws.readyState === WebSocket.OPEN;
const safeSend = (ws, obj) => { if (isOpen(ws)) ws.send(JSON.stringify(obj)); };

function settle(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.result);
  else entry.reject(new Error(msg.error || "Unknown plugin error"));
}

function rejectAllPending(message) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(message));
    pending.delete(id);
  }
}

// ---- primary side
function setRole(ws, role) {
  ws.role = role;
  if (role === "plugin") {
    if (plugin && plugin !== ws && isOpen(plugin)) {
      try { plugin.close(1000, "replaced by a newer connection"); } catch {}
    }
    plugin = ws;
    log("Figma plugin connected");
  } else {
    log("relay instance connected");
  }
}

function relayToPlugin(clientWs, msg) {
  if (!isOpen(plugin)) {
    return safeSend(clientWs, { id: msg.id, ok: false, error: NOT_CONNECTED });
  }
  const pid = nextId++;
  const timer = setTimeout(() => routed.delete(pid), TIMEOUT_MS + 5000);
  routed.set(pid, { ws: clientWs, id: msg.id, timer });
  safeSend(plugin, { id: pid, command: msg.command, params: msg.params });
}

function onConnection(ws) {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "hello") { setRole(ws, msg.role === "client" ? "client" : "plugin"); return; }
    if (!ws.role) setRole(ws, msg.command ? "client" : "plugin");
    if (ws.role === "client") return relayToPlugin(ws, msg);

    // a response from the plugin
    const r = routed.get(msg.id);
    if (r) {
      clearTimeout(r.timer);
      routed.delete(msg.id);
      return safeSend(r.ws, { ...msg, id: r.id });
    }
    settle(msg);
  });

  ws.on("close", () => {
    if (ws.role === "plugin" && plugin === ws) {
      plugin = null;
      log("Figma plugin disconnected");
      rejectAllPending("Figma plugin disconnected");
      for (const [pid, r] of routed) {
        clearTimeout(r.timer);
        safeSend(r.ws, { id: r.id, ok: false, error: "Figma plugin disconnected" });
        routed.delete(pid);
      }
    } else if (ws.role === "client") {
      log("relay instance disconnected");
      for (const [pid, r] of routed) {
        if (r.ws === ws) { clearTimeout(r.timer); routed.delete(pid); }
      }
    }
  });
}

// ---- relay-client side
function connectAsClient() {
  const ws = new WebSocket(`ws://${HOST}:${PORT}`);
  let opened = false;
  ws.on("open", () => {
    opened = true;
    upstream = ws;
    mode = "client";
    ws.send(JSON.stringify({ type: "hello", role: "client" }));
    log(`Port ${PORT} is owned by another instance; relaying through it`);
  });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    settle(msg);
  });
  ws.on("error", () => { /* "close" follows */ });
  ws.on("close", () => {
    if (upstream === ws) upstream = null;
    mode = "starting";
    if (opened) {
      rejectAllPending("Lost connection to the primary bridge instance");
      log("Lost the primary instance; trying to take over");
    }
    setTimeout(startBridge, opened ? 500 : 2000);
  });
}

function startBridge() {
  const w = new WebSocketServer({ host: HOST, port: PORT });
  w.on("listening", () => {
    wss = w;
    mode = "primary";
    log(`WebSocket listening on ws://${HOST}:${PORT} (primary)`);
  });
  w.on("error", (err) => {
    if (mode === "primary") { log("WebSocket error:", err.message); return; }
    try { w.close(); } catch {}
    if (err.code === "EADDRINUSE") connectAsClient();
    else { log("WebSocket error:", err.message); setTimeout(startBridge, 3000); }
  });
  w.on("connection", onConnection);
}

function callPlugin(command, params = {}) {
  return new Promise((resolve, reject) => {
    if (mode === "starting") {
      return reject(new Error("The bridge is still starting up. Try again in a moment."));
    }
    const target = mode === "primary" ? plugin : upstream;
    if (!isOpen(target)) return reject(new Error(NOT_CONNECTED));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s waiting for Figma (${command})`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    target.send(JSON.stringify({ id, command, params }));
  });
}

startBridge();

// --------------------------------------------------------------- MCP server
const mcp = new McpServer({ name: "figma-claude-bridge", version: "1.0.0" });

// ------------------------------------------------------------- image loading
// IMAGE fills may give `url` (http/https, or a data: URI), `path` (a file on this computer) or `base64`
// (the bytes themselves, e.g. from a sandbox that cannot reach this computer's disks). The server reads
// and checks the bytes and hands them to the plugin as base64, since the plugin has no network/file access.
const MAX_IMAGE_BYTES = Number(process.env.FIGMA_BRIDGE_MAX_IMAGE_MB || 12) * 1024 * 1024;

function sniffImage(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "GIF8") return "gif";
  return null;
}

// base64 text (optionally a "data:image/png;base64,..." URI) -> checked Buffer
function decodeBase64Image(text, label) {
  const m = /^data:[^,]*?(;base64)?,/i.exec(text);
  let data = text;
  if (m) {
    if (!m[1]) throw new Error(`${label}: only base64 data: URIs are supported (data:image/png;base64,...)`);
    data = text.slice(m[0].length);
  }
  data = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(data) || data.length < 8) {
    throw new Error(`${label}: not valid base64 image data`);
  }
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function loadImage(src) {
  let buf;
  if (/^data:/i.test(src)) {
    buf = decodeBase64Image(src, "Image data: URI");
  } else if (/^https?:\/\//i.test(src)) {
    let res;
    try {
      res = await fetch(src, { signal: AbortSignal.timeout(20000), redirect: "follow" });
    } catch (e) {
      throw new Error(`Could not download image ${src}: ${e.message}`);
    }
    if (!res.ok) throw new Error(`Could not download image (HTTP ${res.status}): ${src}`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${Math.round(declared / 1048576)} MB, limit ${MAX_IMAGE_BYTES / 1048576} MB): ${src}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    const file = path.resolve(src);
    let info;
    try { info = await stat(file); }
    catch { throw new Error(`Image file not found: ${src}`); }
    if (!info.isFile()) throw new Error(`Not a file: ${src}`);
    if (info.size > MAX_IMAGE_BYTES) throw new Error(`Image is too large (${Math.round(info.size / 1048576)} MB, limit ${MAX_IMAGE_BYTES / 1048576} MB): ${src}`);
    buf = await readFile(file);
  }
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image is too large (limit ${MAX_IMAGE_BYTES / 1048576} MB): ${src.slice(0, 80)}`);
  if (!sniffImage(buf)) {
    throw new Error(`Unsupported image format: ${src.slice(0, 80)}. Figma accepts PNG, JPEG or GIF; convert WebP/SVG/other formats first.`);
  }
  return buf.toString("base64");
}

// Deep-walk any params object and replace IMAGE paints that have url/path/base64 with checked base64.
async function resolveImages(value, cache = new Map()) {
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await resolveImages(v, cache));
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolveImages(v, cache);
    if (out.type === "IMAGE" && typeof out.base64 === "string") {
      // raw bytes sent by the caller: validate them like any other source (format and size)
      const raw = out.base64;
      const key = "b64:" + raw.length + ":" + raw.slice(0, 64) + raw.slice(-32);
      if (!cache.has(key)) cache.set(key, loadImage(raw.startsWith("data:") ? raw : "data:;base64," + raw));
      out.base64 = await cache.get(key);
      delete out.url;
      delete out.path;
    } else if (out.type === "IMAGE" && (out.url || out.path)) {
      const src = String(out.url || out.path);
      if (!cache.has(src)) cache.set(src, loadImage(src));
      out.base64 = await cache.get(src);
      delete out.url;
      delete out.path;
    }
    return out;
  }
  return value;
}

const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: String(err?.message || err) }],
});
const wrap = (command, mapParams = (p) => p) => async (params) => {
  try { return ok(await callPlugin(command, await resolveImages(mapParams(params)))); }
  catch (e) { return fail(e); }
};

const NODE_SPEC_DOC = `
Node spec (JSON object). Common fields:
- type: FRAME | COMPONENT | RECTANGLE | ELLIPSE | TEXT | LINE | POLYGON | STAR | VECTOR | SVG  (default FRAME). COMPONENT is a frame that can be combined into variants with figma_combine_variants.
  VECTOR draws a path: {type:"VECTOR", path:"M 0 0 L 40 0 L 20 30 Z", fills?, strokes?, width?, height?} (or vectorPaths:[{data, windingRule:"NONZERO"|"EVENODD"}]). SVG path syntax: M L H V C S Q T Z, absolute or relative; arcs (A) are not supported, use an SVG node for those. width/height rescale the drawn path. With no fills and no strokes it gets a black fill. Combine shapes with figma_boolean.
  SVG imports vector artwork (e.g. an icon): {type:"SVG", svg:"<svg ...>...</svg>", name?, x?, y?, width?, height?}. It creates a frame containing editable vectors; use parentId on figma_create to drop it into a slot.
- name, x, y, width, height, rotation, opacity (0-1), visible
- fills: "#RRGGBB" | "#RRGGBBAA" | [{type:"SOLID",color:"#hex",opacity?}] | [{type:"GRADIENT_LINEAR",stops:[{position:0,color:"#hex"},...], direction|cssAngle|angle}] | "none"
  Linear gradient direction (pick ONE): direction:"to right"|"to bottom"|"to bottom right"|... (like CSS), or cssAngle:deg (CSS convention: 0 = to top, 90 = to right, 180 = to bottom),
  or angle:deg (0 = left to right, 90 = top to bottom, 180 = right to left, 270 = bottom to top; clockwise; default 0).
  Example: a hero fading from dark at the top to transparent at the bottom: {type:"GRADIENT_LINEAR", direction:"to bottom", stops:[{position:0,color:"#000000CC"},{position:1,color:"#00000000"}]}.
  figma_get_node returns gradients as {type, angle, stops} in the same convention as angle.
- image fill: fills:[{type:"IMAGE", url:"https://..." | path:"D:/foto/a.png" | base64:"..." | fromNodeId:"12:34" | imageHash:"...", scaleMode:"FILL"|"FIT"|"CROP"|"TILE" (default FILL), opacity?}]
  Put it on a RECTANGLE/ELLIPSE/FRAME (e.g. a rectangle with cornerRadius for a rounded photo). PNG, JPEG or GIF only, max 12 MB.
  base64 (or a "data:image/png;base64,..." URI in url) sends the bytes themselves, for callers that cannot reach this computer's folders. Keep it small (a few hundred KB) since the data passes through the conversation.
  fromNodeId reuses the first image of an existing node (e.g. a photo from the source slot, see figma_get_slots content.images).
  The same fills format works in figma_update to swap an image. Fills can mix, e.g. [image, gradient overlay].
- variables (design tokens): refer to a local Figma variable as "collection/name", e.g. "light/primary", "core/radius/md" (the variable name keeps its own slashes).
  Colors: fills/strokes/textColor accept "var:light/primary" or [{type:"SOLID", variable:"light/primary", opacity?}].
  Numbers and other fields: bind:{cornerRadius:"core/radius/md", strokeWeight:"core/line/hairline", itemSpacing:"core/space/2", paddingLeft:"core/space/4", height:"core/control/md"}; use null to unbind.
  Works in figma_create and figma_update (see figma_rebind_variables to switch a copy to another collection). Unknown names fail with similar suggestions; figma_get_node shows bindings as "variable" on paints and "bound" on the node.
- strokes: same format as fills (solid/gradient only); strokeWeight; strokeAlign: INSIDE|OUTSIDE|CENTER
- cornerRadius (number) or topLeftRadius/topRightRadius/bottomLeftRadius/bottomRightRadius
- effects: [{type:"DROP_SHADOW"|"INNER_SHADOW",color:"#hex",opacity?,x,y,blur,spread?}] or [{type:"LAYER_BLUR",blur}]. figma_get_node returns effects in this same format.
- clipsContent (frames)
Auto layout (frames): layoutMode "HORIZONTAL"|"VERTICAL"|"NONE", itemSpacing, padding (all sides) or paddingTop/Right/Bottom/Left,
  primaryAxisAlignItems MIN|CENTER|MAX|SPACE_BETWEEN, counterAxisAlignItems MIN|CENTER|MAX|BASELINE,
  layoutWrap "WRAP"|"NO_WRAP", primaryAxisSizingMode / counterAxisSizingMode "FIXED"|"AUTO".
  A new auto-layout frame HUGS its content on every axis you do not size (no width/height, layoutSizing* or *AxisSizingMode); give width/height or layoutSizing "FILL" to override.
Child sizing inside an auto-layout parent: layoutSizingHorizontal / layoutSizingVertical "FIXED"|"HUG"|"FILL", layoutGrow (0|1), layoutAlign.
  layoutPositioning:"ABSOLUTE" takes the child out of the flow so x/y place it freely inside the parent (e.g. a badge or an image overlapping a card); the parent must be auto layout. x/y of the result are returned. Optional constraints:{horizontal,vertical} (MIN|CENTER|MAX|STRETCH|SCALE).
Order: figma_create and figma_clone accept index (0 = first child) to insert at a position instead of the end; figma_update accepts index to reorder inside the current parent (or with parentId to move).
Text: characters, fontSize, fontFamily (default "Inter"), fontStyle (default "Regular", e.g. "Bold", "Semi Bold"),
  textAlignHorizontal LEFT|CENTER|RIGHT|JUSTIFIED, textAlignVertical TOP|CENTER|BOTTOM, lineHeight (px number), letterSpacing (px number),
  textAutoResize "WIDTH_AND_HEIGHT"|"HEIGHT"|"NONE", textColor (shortcut for fills on TEXT).
  Mixed styles in one text: runs:[{text:"Hemat ", fontStyle:"Regular"},{text:"30%", fontStyle:"Bold", color:"#E11D48", fontSize:28, textDecoration:"UNDERLINE", letterSpacing:0.5, lineHeight:32}] builds the text from the runs (characters is derived). Or style part of characters with ranges:[{start:0,end:5,fontStyle:"Bold",color:"#hex"}] (end exclusive). Per-run fields: fontSize, fontFamily, fontStyle, color, textDecoration NONE|UNDERLINE|STRIKETHROUGH, letterSpacing, lineHeight; unset fields keep the text's base style. figma_get_node returns runs when the styles differ.
children: array of node specs (created recursively inside this node; frames only).
Tip: build whole screens in ONE figma_create call using nested children instead of many tiny calls.`;

mcp.registerTool(
  "figma_status",
  {
    description: "Check whether the Figma plugin is connected, and get the current file name, page and selection count.",
    inputSchema: {},
  },
  async () => {
    try { return ok(await callPlugin("status")); }
    catch (e) { return fail(e); }
  }
);

mcp.registerTool(
  "figma_get_selection",
  {
    description: "Get the currently selected nodes in Figma (with their properties and children up to `depth`).",
    inputSchema: { depth: z.number().int().min(0).max(6).optional().describe("Child levels to include (default 1)") },
  },
  wrap("get_selection")
);

mcp.registerTool(
  "figma_boolean",
  {
    description:
      "Combine shapes with a boolean operation (like Figma's Union / Subtract / Intersect / Exclude) into one new node. " +
      "UNION merges all shapes; SUBTRACT cuts the shapes in front out of the shape at the back (stacking order decides, not the order of ids); " +
      "INTERSECT keeps the overlap; EXCLUDE keeps everything except the overlap. Use flatten:true to turn the result into a single plain vector (a logo or icon that no longer needs its parts). " +
      "Make the shapes with figma_create first (RECTANGLE, ELLIPSE, POLYGON, STAR or VECTOR with a path). Returns the new node.",
    inputSchema: {
      operation: z.enum(["UNION", "SUBTRACT", "INTERSECT", "EXCLUDE"]),
      ids: z.array(z.string()).min(2).describe("Ids of the shapes to combine (at least 2)"),
      name: z.string().optional().describe("Name of the result"),
      parentId: z.string().optional().describe("Where to put the result (default: the parent of the first shape)"),
      index: z.number().int().min(0).optional().describe("Position inside the parent (0 = first child)"),
      flatten: z.boolean().optional().describe("Flatten the result into one vector (default false, which keeps the shapes editable)"),
      props: z.record(z.any()).optional().describe("Properties to apply to the result, same as figma_update, e.g. {fills:'#111111', x:10, y:20}"),
      select: z.boolean().optional().describe("Select the result (default true)"),
    },
  },
  wrap("boolean")
);

mcp.registerTool(
  "figma_create_variables",
  {
    description:
      "Create or update local variables (design tokens) from a list: collections with modes, and variables with a value per mode. " +
      "Safe to run again: collections and variables are matched by name and updated, never duplicated. " +
      "Types: COLOR (\"#RRGGBB\" or \"#RRGGBBAA\"), FLOAT (number), STRING, BOOLEAN; type is inferred from the value when omitted. " +
      "values is {modeName: value}, or a single value for the first mode. An alias to another variable is {alias:\"collection/name\"}; the target may be created in the same call. " +
      "Names with slashes make groups, e.g. \"color/brand/primary\". Example: " +
      '{collections:[{name:"core",modes:["Default"],variables:[{name:"blue/500",values:"#3B82F6"},{name:"radius/md",values:12}]},' +
      '{name:"theme",modes:["Light","Dark"],variables:[{name:"primary",type:"COLOR",values:{Light:{alias:"core/blue/500"},Dark:"#60A5FA"},description:"Brand color"}]}]}. ' +
      "Then use them in figma_create / figma_update as \"var:theme/primary\" or bind:{...} (see the node spec), and list them with figma_list_variables.",
    inputSchema: {
      collections: z
        .array(
          z.object({
            name: z.string().min(1),
            modes: z.array(z.string()).optional().describe("Mode names. A new collection's default mode is renamed to the first; missing modes are added; existing modes are kept."),
            variables: z
              .array(
                z.object({
                  name: z.string().min(1),
                  type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]).optional(),
                  values: z.any().optional().describe("{modeName: value | {alias:'collection/name'}} or one value for the first mode"),
                  description: z.string().optional(),
                  scopes: z.array(z.string()).optional().describe("Figma variable scopes, e.g. ['CORNER_RADIUS'] or ['ALL_FILLS']"),
                })
              )
              .optional(),
          })
        )
        .min(1),
    },
  },
  wrap("create_variables")
);

mcp.registerTool(
  "figma_combine_variants",
  {
    description:
      "Combine COMPONENT nodes into one component set (variants). Every component must be named " +
      '"Property=Value, Property=Value", e.g. "variant=default, size=md"; those names become the variant properties. ' +
      "Returns the new component set. Create components with figma_create (type COMPONENT) first.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("COMPONENT node ids to combine"),
      name: z.string().optional().describe("Name of the component set, e.g. Button"),
      parentId: z.string().optional().describe("Where to put the set (default: the parent of the first component)"),
    },
  },
  wrap("combine_variants")
);

mcp.registerTool(
  "figma_rebind_variables",
  {
    description:
      "In a node and all its children, re-point every variable of one collection to the variable with the same name in " +
      'another collection, e.g. from "light" to "dark". Variables of other collections (such as "core") are unchanged. ' +
      "Use it to make a dark copy of a design: figma_clone the node, then rebind the copy. Returns how many bindings changed " +
      "and the target variables that do not exist (those bindings stay as they were).",
    inputSchema: {
      id: z.string().describe("Node id (usually a freshly cloned frame, component or component set)"),
      from: z.string().describe('Collection to move away from, e.g. "light"'),
      to: z.string().describe('Collection to move to, e.g. "dark"'),
      name: z.string().optional().describe("Optional new name for the node"),
    },
  },
  wrap("rebind_variables")
);

mcp.registerTool(
  "figma_list_variables",
  {
    description:
      "List the local Figma variable collections in the current file with their modes and variables (id, name, type, " +
      "whether a description is set). Read-only. Use it to learn which variable names exist before binding tokens.",
    inputSchema: {},
  },
  wrap("list_variables")
);

mcp.registerTool(
  "figma_get_slots",
  {
    description:
      "Read the two slots the user marked in the Claude Bridge plugin window: SOURCE (slot 1 = the existing design that holds " +
      "the information) and TARGET (slot 2 = the design to change/rebuild from that information). For each slot you get the node(s), " +
      "`content` (all visible text in reading order with node ids, plus image-filled nodes) and `tree` (structure and styling). " +
      "Workflow for 'make a new design from this information': (1) call this first and read the user's brief; " +
      "(2) unless the user says to edit in place, duplicate the target with figma_clone and work on the copy so the original stays intact; " +
      "(3) change text with figma_update on the target's text node ids (this keeps the existing styling); when the source has more or fewer " +
      "items than the target (list rows, cards), figma_clone a row/card or figma_delete extras, then fill them; " +
      "(4) restyle only as the brief asks; (5) figma_export the result (and the source if needed) to check it visually, fix problems, " +
      "and report what you filled and anything you left empty or could not fit. Do not invent information that is not in the source. " +
      "If a slot is empty the result says so; ask the user to pick it in the plugin window, or use figma_set_slot.",
    inputSchema: {
      sourceDepth: z.number().int().min(0).max(6).optional().describe("Tree levels to include for the source (default 2)"),
      targetDepth: z.number().int().min(0).max(6).optional().describe("Tree levels to include for the target (default 4)"),
    },
  },
  wrap("get_slots")
);

mcp.registerTool(
  "figma_set_slot",
  {
    description:
      "Set or clear a slot. slot 'source' = the design with the information, slot 'target' = the design to change. " +
      "Uses the given node ids, or the user's current selection in Figma when ids is omitted. Pass clear:true to empty it.",
    inputSchema: {
      slot: z.enum(["source", "target"]),
      ids: z.array(z.string()).optional().describe("Node ids. Omit to use the current Figma selection."),
      clear: z.boolean().optional().describe("Empty the slot"),
    },
  },
  wrap("set_slot")
);

mcp.registerTool(
  "figma_get_node",
  {
    description:
      "Get a node by id (e.g. '12:34'), including its properties (fills, strokes, effects, auto layout, text, variable bindings) and children up to `depth`. " +
      "Use no id for the current page. To just see what is on a page, figma_list_children is lighter.",
    inputSchema: {
      id: z.string().optional().describe("Node id. Omit for the current page."),
      depth: z.number().int().min(0).max(6).optional().describe("Child levels to include (default 2)"),
    },
  },
  wrap("get_node")
);

mcp.registerTool(
  "figma_list_children",
  {
    description:
      "List the direct children of a page or node: id, name, type, x, y, width, height, childCount. " +
      "No arguments = the current page; pageName = another page by name; id = any node (a page id also works). " +
      "Use it to find ids before figma_get_node, figma_update or figma_clone.",
    inputSchema: {
      id: z.string().optional().describe("Node or page id"),
      pageName: z.string().optional().describe("Page name (case-insensitive), e.g. 'Web Flow'"),
    },
  },
  wrap("list_children")
);

mcp.registerTool(
  "figma_create",
  {
    description:
      "Create one node (optionally with nested children) in Figma. Returns the created node ids." + NODE_SPEC_DOC,
    inputSchema: {
      spec: z.record(z.any()).describe("Node spec object, see description"),
      parentId: z.string().optional().describe("Parent node id. Default: current page."),
      index: z.number().int().min(0).optional().describe("Position among the parent's children (0 = first). Default: end."),
      select: z.boolean().optional().describe("Select and zoom to the new node (default true)"),
      animate: z.boolean().optional().describe(
        "Play a build animation: nodes fade in one by one, in order, as if the design is being drawn live. " +
        "Default follows the setting in the plugin window (on by default). Use false for quick bulk edits."
      ),
      speed: z.enum(["fast", "normal", "slow"]).optional().describe("Animation speed (default from plugin window). The whole animation is capped at 12s."),
    },
  },
  wrap("create")
);

mcp.registerTool(
  "figma_update",
  {
    description:
      "Update properties of an existing node by id. Accepts the same fields as a node spec (name, x, y, width, height, fills, strokes, " +
      "characters, fontSize, layoutMode, ...). Also accepts parentId (+ optional index) to move the node.",
    inputSchema: {
      id: z.string().describe("Node id"),
      props: z.record(z.any()).describe("Properties to change"),
    },
  },
  wrap("update")
);

mcp.registerTool(
  "figma_delete",
  {
    description: "Delete nodes by id. They can be recovered with Undo (Cmd/Ctrl+Z) in Figma.",
    inputSchema: { ids: z.array(z.string()).min(1).describe("Node ids to delete") },
  },
  wrap("delete")
);

mcp.registerTool(
  "figma_clone",
  {
    description: "Duplicate a node. Optionally place the copy into another parent, at a position (index) and/or offset it.",
    inputSchema: {
      id: z.string(),
      parentId: z.string().optional(),
      index: z.number().int().min(0).optional().describe("Position among the parent's children (0 = first). Default: next to the original, or the end of parentId."),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  wrap("clone")
);

mcp.registerTool(
  "figma_select",
  {
    description: "Select nodes by id and scroll/zoom the viewport to them.",
    inputSchema: { ids: z.array(z.string()).min(1) },
  },
  wrap("select")
);

mcp.registerTool(
  "figma_export",
  {
    description:
      "Export a node. PNG/JPG returns an image so you can look at the result. SVG returns the vector markup as text " +
      "(logos and icons you want to copy into code or into another design); pass savePath (a .svg file on this computer) " +
      "to also write it to disk.",
    inputSchema: {
      id: z.string().describe("Node id to export"),
      format: z.enum(["PNG", "JPG", "SVG"]).optional().describe("Default PNG"),
      scale: z.number().min(0.1).max(4).optional().describe("PNG/JPG only. Default 1"),
      outlineText: z.boolean().optional().describe("SVG only: convert text to outlines (default true, so fonts are not needed). false keeps <text>."),
      includeIds: z.boolean().optional().describe("SVG only: keep layer names as id attributes (default false)"),
      savePath: z.string().optional().describe("SVG only: write the SVG to this .svg path, e.g. D:/proyek/img/logo.svg (folders are created)"),
    },
  },
  async (params) => {
    try {
      const { savePath, ...pluginParams } = params;
      if (savePath && params.format !== "SVG") throw new Error("savePath only works with format SVG");
      if (savePath && !/\.svg$/i.test(savePath)) throw new Error("savePath must end in .svg");
      const r = await callPlugin("export", pluginParams);
      if (typeof r.svg === "string") {
        let saved = "";
        if (savePath) {
          const file = path.resolve(savePath);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, r.svg, "utf8");
          saved = `\nSaved to ${file}`;
        }
        return {
          content: [
            { type: "text", text: `Exported ${r.name} as SVG (${r.width}x${r.height}, ${r.svg.length} characters).${saved}` },
            { type: "text", text: r.svg },
          ],
        };
      }
      return {
        content: [
          { type: "image", data: r.base64, mimeType: r.mimeType },
          { type: "text", text: `Exported ${r.name} (${r.width}x${r.height})` },
        ],
      };
    } catch (e) { return fail(e); }
  }
);

// -------------------------------------------------------------------- start
const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP server ready (stdio)");

const shutdown = () => { try { wss && wss.close(); } catch {} process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
