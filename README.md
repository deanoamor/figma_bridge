# Figma Bridge (Claude Bridge)

A Figma plugin plus a local MCP server that lets **Claude design directly in Figma**. Built for personal use on your own computer, using your existing Claude subscription (no API key needed).

```
Claude Desktop / Claude Code
        │  MCP (stdio)
        ▼
  server/index.js  ──WebSocket (localhost:3055)──►  Figma plugin (plugin/)
                                                          │
                                                          ▼
                                                    Figma Plugin API
```

The server only listens on `127.0.0.1`, so it is not exposed to the network.

> **Unofficial project:** not affiliated with or endorsed by Figma or Anthropic. Claude can modify your Figma file, so try it on a copy first. Licensed under MIT, see [LICENSE](LICENSE).

## Features

- **Create and edit designs**: frames, text, shapes, auto layout, gradients, shadows, rounded corners, and nested structures in a single command.
- **Image fills**: from a file on your computer, a URL, base64, or copied from another node.
- **HTML import**: turn a web page (HTML + CSS) into auto-layout frames in Figma.
- **Vectors and booleans**: draw your own paths and combine shapes (union, subtract, intersect, exclude).
- **Mixed text styles**: one text node with bold, colored, or underlined parts.
- **Variables (tokens)**: create collections, modes, and variables from a list of tokens.
- **SVG export**: take a logo or icon as SVG, optionally saved straight to a file.
- **Build animation**: the design appears step by step, as if being drawn live.
- **Two slots (Source → Target)**: pick a design that holds the information and a design to transform, then give Claude a brief.
- **Claude can see the result**: export a node as an image, then fix it on its own.

## Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Advanced features](#advanced-features)
- [Tool reference](#tool-reference)
- [Stopping and updating](#stopping-and-updating)
- [Troubleshooting](#troubleshooting)
- [Development and tests](#development-and-tests)
- [Security notes](#security-notes)

## Prerequisites

- **Node.js 18 or newer** (check with `node -v`)
- **The Figma desktop app**. Plugin development cannot be run from Figma in the browser.
- **Claude Desktop** or **Claude Code** (either one is enough)

## Installation

### 1. Get the code and install dependencies

```bash
git clone https://github.com/deanoamor/figma_bridge.git
cd figma_bridge
npm install
```

You can ignore the `npm audit` or "new major version of npm" messages after `npm install`. Do not run `npm audit fix --force`.

Note the **full path** to `server/index.js`, for example `D:/figma_bridge/server/index.js`. On Windows, write it with forward slashes `/` so you do not have to double the backslashes.

### 2. Register the MCP server with Claude

Pick one.

**Claude Desktop**

1. Open **Settings → Desktop app**, scroll down to the **Extensions** row and click **Manage**. On that page, in the **Local MCP servers** section, click **Edit config** (older versions call this menu **Developer**). The folder containing `claude_desktop_config.json` opens; open that file in a text editor (Notepad/VS Code).
2. Add the `figma-bridge` block (if `mcpServers` already has entries, just add it inside):

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "node",
      "args": ["D:/figma_bridge/server/index.js"]
    }
  }
}
```

3. Save, then **quit Claude Desktop completely**, including from the system tray (right-click its icon → Quit), and open it again.
4. Check **Settings → Desktop app → Extensions → Manage → Local MCP servers**: `figma-bridge` should show *Running*.

**Claude Code**

```bash
claude mcp add figma-bridge -- node D:/figma_bridge/server/index.js
```

Change the path to match your location. If the `claude` command is not recognized, install it first: `npm install -g @anthropic-ai/claude-code`.

### 3. Import the plugin into Figma

1. Open the Figma desktop app and a **Design** file (not FigJam).
2. Menu **Plugins → Development → Import plugin from manifest...**
3. Choose `plugin/manifest.json` from this project folder.

You only need to import it once. The plugin stays in the Plugins → Development menu.

### 4. Run and test

1. In Figma: **Plugins → Development → Claude Bridge**. A small window appears with a **green** dot and the text "Connected to Claude". **Keep this window open** while Claude works. If you close it, the connection is lost.
2. In a Claude chat (just one chat), type:

> Use figma_status to check the connection, then build a simple 320x200 profile card with a name and a button.

If the card appears on the Figma canvas, everything works.

## Usage

Claude works through the `figma_*` tools. You just write a normal brief. Some useful patterns:

### Creating a design from scratch

> Build a professional web dashboard page in Figma, a 1440x1024 frame. Left sidebar 240px, a header with search, 4 KPI cards, a line chart, and a table of recent orders. Background #F6F7F9, accent #4F46E5, font Inter. Use auto layout, give layers clear names, and check the result with figma_export after each big section.

Tip: ask Claude to build one screen in **one** `figma_create` call with nested children, then inspect and fix it. If the result is off, ask for a specific fix ("the spacing between the KPI cards is too tight") instead of starting over.

### Two slots: build a new design from existing information

For the case "there is a design that holds the information, and I want a new design made from it".

1. Select the design that holds the information, then click **Use selection** on the *1 · Source* row of the plugin window.
2. Select the design you want to transform (a template, poster, card, etc.), then click **Use selection** on the *2 · Target* row.
3. Write a brief to Claude, for example:

> Fill the target with the information from the source. Only the title and the 3 main points, a more minimalist style, do not change the brand colors.

Claude reads the source content (text in top-to-bottom order, images, structure) and the target structure, **duplicates the target first** so the original stays safe (unless you ask it to edit in place), fills in text by node id (keeping font styles), adds or removes rows if the number of items differs, then checks the result with a screenshot. Claude does not invent information that is not in the source and reports parts that do not fit.

A slot can hold several nodes. Slots are saved in the Figma file, so they persist when the plugin is reopened.

### Image fills

Rectangles, ellipses, and frames can get an image as a fill, both when created and via `figma_update` to replace the image.

| Source | Example |
|---|---|
| `path` | a file on your computer: `D:/photos/shoe.png` |
| `url` | `https://example.com/photo.jpg` |
| `fromNodeId` | reuse the image from another node in Figma |

`scaleMode`: `FILL` (default), `FIT`, `CROP`, `TILE`. PNG, JPEG, and GIF formats, up to 12 MB (change it with the `FIGMA_BRIDGE_MAX_IMAGE_MB` environment variable). WebP and SVG must be converted first. Images can be stacked with other fills, for example a dark gradient over a photo.

> Build a 320x420 product card. At the top, a photo from D:/photos/shoe.png (height 240, top corners 16, FILL mode), then the product name, the price, and a Buy button below it.

### Build animation

When Claude builds a design, nodes appear one by one with a fade-in from container to contents, while the canvas zooms to the area being built.

- Enable/disable and speed (Fast / Normal / Slow) are set in the plugin window and remembered between sessions.
- Claude can override them per call (`animate`, `speed`), for example `animate: false` for bulk edits.
- Total animation time is capped at about 12 seconds, so large designs are sped up automatically.
- When it finishes, all nodes return to their original opacity.

## Advanced features

This section comes from the list of improvements made after using the bridge to move a web page into Figma.

### HTML import

`figma_import_html` reads HTML + CSS and creates auto-layout frames. The plugin renders the page in a hidden window (scripts on the page are not run), measures every box, and then translates it.

> Import D:/project/index.html at width 1440 into this page. Only the `#pricing` section.

- Provide `htmlPath` (a file on your computer) or `html` (text). With `htmlPath`, `<link>` stylesheets and relative images are read from the same folder. With `html`, set `baseDir` if there are relative images.
- Supported: flexbox, grid, normal block flow, padding, gap, radius, colors, gradients, borders, shadows, text (font, weight, size, line height, alignment, uppercase), mixed styles inside one text (`<b>`, `<a>`, `<span>`), `<img>`, background images, inline `<svg>`, `position: absolute`, buttons, inputs.
- Layout is taken from the rendered positions: children arranged in one row or one column become auto layout, grids become rows, and uneven margins become `spacer` or `margin` frames. Other arrangements are placed at absolute coordinates. `layout: "absolute"` forces everything to absolute (exactly like the browser, but not responsive).
- `dryRun: true` only shows the conversion result without creating anything. `width` sets the page width (390 for a mobile view), and `selector` picks one section.
- Fonts from the CSS are used as they are. Fonts that do not exist in Figma are replaced by `fallbackFont` (default Inter) and reported in `fontSubstitutions`. Text re-measuring can differ slightly if that font is not installed on your computer.
- This is an approximation, not a pixel-for-pixel copy. What is not imported is reported in `warnings`: `::before`/`::after`, transforms, per-side different borders, list markers (bullets), and `backdrop-filter`.

### Vectors and booleans

```
{ "type": "VECTOR", "path": "M 0 0 L 40 0 L 20 30 Z", "fills": "#2563EB", "width": 80, "height": 60 }
```

SVG path syntax: `M L H V C S Q T Z`, absolute or relative. Arcs (`A`) are not supported yet; for shapes with arcs use an `SVG` node. `figma_boolean` combines shapes: `UNION`, `SUBTRACT` (the front shape cuts the shape behind it), `INTERSECT`, `EXCLUDE`. `flatten: true` turns the result into a plain vector.

### Mixed text styles

```
{ "type": "TEXT", "fontSize": 20, "runs": [
  { "text": "Save " },
  { "text": "30%", "fontStyle": "Bold", "color": "#E11D48", "fontSize": 28 }
] }
```

Each `run` may contain `fontSize`, `fontFamily`, `fontStyle`, `color`, `textDecoration`, `letterSpacing`, `lineHeight`. Alternatively `ranges: [{ "start": 0, "end": 5, ... }]` styles part of `characters`. `figma_get_node` returns `runs` when the styles differ.

### Variables (tokens)

`figma_create_variables` creates or updates collections, modes, and variables from a single list. It is safe to run again (matched by name). Values are per mode, and an alias to another variable is written as `{ "alias": "core/blue/500" }`.

> Create a `core` collection (blue/500 = #3B82F6, radius/md = 12) and a `theme` collection with Light and Dark modes: `primary` Light refers to core/blue/500, Dark = #60A5FA.

### Gradient direction

Pick one: `direction` (like CSS: `"to bottom"`, `"to bottom right"`), `cssAngle` (CSS convention: 0 = up, 90 = right, 180 = down), or `angle` (0 = left to right, 90 = top to bottom, clockwise).

```
{ "type": "GRADIENT_LINEAR", "direction": "to bottom", "stops": [
  { "position": 0, "color": "#000000CC" }, { "position": 1, "color": "#00000000" } ] }
```

`figma_get_node` returns gradients using the same `angle` convention.

### Behaviors to know

- New auto-layout frames automatically **HUG** on any axis you did not size (no longer 100×100).
- Text is re-measured automatically after the width, font size, or content changes, so its height adjusts right away.
- `index` on `figma_create`, `figma_clone`, and `figma_update` sets the order (0 = first child), with no need for a `figma_update` afterwards.
- `layoutPositioning: "ABSOLUTE"` takes a child out of the auto-layout flow so `x`/`y` apply (badges, images overlapping a card). `constraints` may be added.
- `figma_get_node` also returns `effects` (shadows and blurs) in the same format as `figma_create`. A page id or an unknown id gives a clear message; `figma_list_children` lists the contents of a page or node (with `pageName` for other pages).
- Font styles are matched across spellings: `Semi Bold` (Inter) and `SemiBold` (Poppins) are both accepted.
- `figma_export` with `format: "SVG"` returns SVG markup (text converted to outlines). `savePath: "D:/project/img/logo.svg"` saves it to a file.

### Limitations

- **Responsive**: Figma has no breakpoints, so one import produces one width. For other versions, import again with `width: 768` or `390` into a separate frame.
- The HTML converter is tested in Chromium, and the plugin is tested with a fake Figma. Gradient direction and text re-measuring have not been tested in real Figma, so try them in a scratch file first.

## Tool reference

| Tool | Purpose |
|---|---|
| `figma_status` | Check the connection, file name, page, and selection count |
| `figma_get_selection` | Read the currently selected nodes |
| `figma_list_variables` | List the file's local collections and variables (read-only) |
| `figma_get_node` | Read a node (or page) by id |
| `figma_get_slots` | Read the Source and Target slots (ordered text, images, structure) |
| `figma_set_slot` | Fill or clear a slot (from ids or the current selection) |
| `figma_list_children` | List the children of a page or node (id, name, type, position, size) |
| `figma_create` | Create nodes, optionally nested (auto layout, text, gradients, shadows, images, vectors, SVG) |
| `figma_import_html` | Turn HTML + CSS into auto-layout frames |
| `figma_boolean` | Union, subtract, intersect, exclude, and flatten shapes |
| `figma_create_variables` | Create or update collections, modes, and variables from a list of tokens |
| `figma_update` | Change node properties, or move a node to another parent |
| `figma_delete` | Delete nodes (can be undone in Figma) |
| `figma_clone` | Duplicate a node |
| `figma_combine_variants` | Combine COMPONENT nodes into one component set (variants). Component names must be `property=value, property=value` |
| `figma_arrange_variants` | Arrange the variants in a component set into a tidy grid (`rows` and `columns` are variant property names) |
| `figma_rebind_variables` | On one node and its children, switch variables from one collection to the same-named variables in another collection (e.g. `light` → `dark`) |
| `figma_create_variable` | Create or update a single variable in an existing collection (hex color, alias, or composed color: color + opacity) |
| `figma_create_instance` | Create an instance of a COMPONENT, or of a specific variant in a COMPONENT_SET (`variant:{size:"md"}`) |
| `figma_create_effect_style` | Create or update an effect style (e.g. `elevation/2`); apply it to a node with `effectStyle` |
| `figma_create_text_style` | Create or update a text style (e.g. `text/sm`), with fields that can be bound to variables; apply it with the `textStyle` prop |
| `figma_list_styles` | List local effect, text, and paint styles (read-only) |
| `figma_apply_text_styles` | Apply local text styles to all text under a node (matched by font family, style, and size; instance contents are skipped; `dryRun` only reports) |
| `figma_select` | Select nodes and zoom to them |
| `figma_export` | Export a node as an image (PNG/JPG) so Claude can see the result, or as SVG (can be saved to a file) |

Supported node properties (summary): `type` (FRAME, COMPONENT, RECTANGLE, ELLIPSE, TEXT, LINE, POLYGON, STAR, VECTOR, SVG), `name`, `x`, `y`, `width`, `height`, `rotation`, `opacity`, `fills`, `strokes`, `cornerRadius`, `effects`, auto layout (`layoutMode`, `itemSpacing`, `padding`, `primaryAxisAlignItems`, `layoutSizingHorizontal`, etc.), text (`characters`, `fontSize`, `fontFamily`, `fontStyle`, `lineHeight`, `letterSpacing`, `textAlignHorizontal`), and `children`. The full list is in the description of the `figma_create` tool.

## Stopping and updating

**Stopping**

1. Close the **Claude Bridge** window in Figma (the X button). Claude can no longer change your Figma file.
2. The MCP server runs together with Claude Desktop and stops when the app is closed. To disable it without closing the app: **Settings → Desktop app → Extensions → Manage → Local MCP servers**, then turn off or delete `figma-bridge`.

**Updating after `git pull`**

0. If your local folder has changes of its own that you no longer need (for example a self-made `SVG` node, which is now in the repo), save them with `git stash` or discard them with `git checkout -- .` before pulling.
1. Quit Claude Desktop completely, then open it again (so the new server is used).
2. In Figma, close the Claude Bridge window and run it again from Plugins → Development. You do not need to re-import unless `plugin/manifest.json` changed. The window must be reopened after any update that changes `plugin/ui.html` (for example HTML import).

## Troubleshooting

| Symptom | Cause and solution |
|---|---|
| `claude : The term 'claude' is not recognized` | Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code`, or use Claude Desktop. |
| `figma-bridge` shows **Failed** / "Connection closed" | Click **View logs**. Make sure the path in the config is correct (use `/`), `npm install` has been run, and Node.js is installed. Then restart Claude Desktop completely. |
| Figma: `Manifest error: Invalid value for devAllowedDomains` | Figma rejects IP addresses. `devAllowedDomains` must be `["ws://localhost:3055"]` (already so in this repo). |
| Claude replies "Figma plugin is not connected" | The plugin window is not open or was closed. Open it again via Plugins → Development → Claude Bridge until the dot is green. Update to the latest version (it supports relaying between several server instances). |
| The dot in the plugin window stays red | The server is not running (check `figma-bridge` in Settings → Desktop app → Extensions → Manage → Local MCP servers), or the port differs. Make the **Port** field in the plugin window match `FIGMA_BRIDGE_PORT` (default 3055). |
| Port 3055 is in use | Set `FIGMA_BRIDGE_PORT` in the server environment, enter the same port in the plugin window, and change `devAllowedDomains` in `plugin/manifest.json` to `ws://localhost:PORT`. |
| `Font "..." is not available` | That font does not exist in Figma. Use an installed font (e.g. `Inter` with `Regular`/`Medium`/`Semi Bold`/`Bold`). `Semi Bold` and `SemiBold` are matched automatically. For HTML import a fallback font is used automatically. |
| `Unknown command: html_to_spec` | The plugin window is still the old version. Close it and open it again from Plugins → Development. |
| `Timed out after 30s` | Large operations can take a while. Raise `FIGMA_BRIDGE_TIMEOUT_MS` (default 30000). |
| `Unsupported image format` | Image fills only accept PNG, JPEG, GIF. Convert WebP/SVG first. |

Note: Claude Desktop may run this server more than once (for example for a chat and a Code session). The server handles this: one instance holds the connection to the plugin, the other instances forward their commands through it, and take over if the first one stops.

## Development and tests

```bash
npm test    # MCP server, relay, images, HTML import, plugin logic (fake Figma), HTML converter
```

The HTML converter tests run in Chromium via Playwright and are skipped automatically if Playwright is not installed (`npm i -D playwright && npx playwright install chromium` to run them). All tests use a fake Figma, not real Figma. Try changes in an empty Figma file first.

Structure:

```
server/index.js      MCP server + WebSocket bridge (+ relay between instances, image loader, HTML import)
plugin/manifest.json Figma plugin manifest
plugin/code.js       main plugin code (Figma Plugin API)
plugin/ui.html       plugin window (WebSocket, settings, slots, HTML-to-design converter)
test/                automated tests (test/fixtures: a sample page and its conversion result)
```

## Security notes

- The server only listens on `127.0.0.1` (not exposed to the network), but other programs on your computer that know the port can connect. Use it on a personal computer.
- HTML import renders the page in a hidden window without running scripts and without loading outside resources. Local stylesheets and images are only read from the HTML folder (or `baseDir`). Still, do not import HTML from sources you do not trust.
- Because Claude can read image files from a `path` it chooses, do not run briefs from sources you do not trust. The server only forwards files proven to be PNG/JPEG/GIF to Figma, and only up to 12 MB.
- This plugin is made for personal use (development mode), not for publishing to the Figma Community.
