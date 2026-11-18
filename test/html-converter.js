// HTML -> spec converter (plugin/ui.html), run in a real Chromium. Needs Playwright; skipped when it is not installed.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

let chromium;
try {
  const require = createRequire(import.meta.url);
  const paths = [process.cwd()];
  try { paths.push(execSync("npm root -g", { encoding: "utf8" }).trim()); } catch {}
  ({ chromium } = require(require.resolve("playwright", { paths })));
} catch {
  console.log("SKIPPED html-converter tests: Playwright is not installed (npm i -D playwright && npx playwright install chromium)");
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(pathToFileURL(path.resolve("plugin/ui.html")).href);

const convert = (html, opts = {}) => page.evaluate(([h, o]) => window.htmlToSpec(h, o), [html, opts]);
const doc = (css, body) => `<!doctype html><html><head><style>*{box-sizing:border-box;margin:0}body{font-family:sans-serif;font-size:16px}${css}</style></head><body>${body}</body></html>`;
const find = (n, pred) => { if (pred(n)) return n; for (const c of n.children || []) { const f = find(c, pred); if (f) return f; } return null; };
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => all(c, pred, out)); return out; };
const named = (n, name) => find(n, (x) => x.name === name);
const texts = (n) => all(n, (x) => x.type === "TEXT");

// 1) flex row: gap, padding, background, radius, shadow, border
{
  const { spec, warnings, stats } = await convert(doc(".row{display:flex;gap:12px;padding:16px 20px;background:#FF0000;border-radius:8px;border:2px solid #00FF00;box-shadow:0 4px 12px rgba(0,0,0,.25);width:600px} .row div{width:100px;height:40px;background:#fff}",
    `<div class="row"><div></div><div></div><div></div></div>`));
  assert.equal(spec.type, "FRAME"); assert.equal(spec.layoutMode, "HORIZONTAL");
  assert.equal(spec.itemSpacing, 12);
  assert.deepEqual([spec.paddingTop, spec.paddingRight, spec.paddingBottom, spec.paddingLeft], [18, 22, 18, 22], "border widths are added to the padding");
  assert.deepEqual(spec.fills, ["#FF0000"]); assert.equal(spec.cornerRadius, 8);
  assert.deepEqual(spec.strokes, ["#00FF00"]); assert.equal(spec.strokeWeight, 2); assert.equal(spec.strokeAlign, "INSIDE");
  assert.deepEqual(spec.effects, [{ type: "DROP_SHADOW", color: "#000000", opacity: 0.25, x: 0, y: 4, blur: 12, spread: 0 }]);
  assert.equal(spec.width, 600); assert.equal(spec.layoutSizingVertical, "HUG");
  assert.equal(spec.children.length, 3); assert.equal(spec.children[0].width, 100); assert.equal(spec.children[0].height, 40);
  assert.equal(stats.absoluteFallbacks, 0); assert.deepEqual(warnings, []);
  console.log("ok: flex row -> auto layout with gap, padding, radius, border, shadow");
}

// 2) block flow with uneven margins: smallest gap + spacer
{
  const { spec } = await convert(doc(".a,.b,.c{width:300px;height:20px;background:#eee} .b{margin-top:8px} .c{margin-top:30px}", `<div class="wrap" style="width:300px"><div class="a"></div><div class="b"></div><div class="c"></div></div>`));
  assert.equal(spec.layoutMode, "VERTICAL"); assert.equal(spec.itemSpacing, 8);
  assert.deepEqual(spec.children.map((c) => c.name), ["div.a", "div.b", "spacer", "div.c"]);
  const sp = spec.children.find((c) => c.name === "spacer");
  assert.equal(sp.height, 22); assert.equal(sp.layoutSizingVertical, "FIXED");
  assert.equal(spec.layoutSizingVertical, "HUG");
  console.log("ok: uneven margins -> itemSpacing + spacer frame");
}

// 3) justify-content: space-between / center, align-items center
{
  let r = await convert(doc(".bar{display:flex;justify-content:space-between;align-items:center;width:800px;height:80px;padding:0 24px}.bar div{width:100px;height:30px;background:#ccc}", `<div class="bar"><div></div><div></div></div>`));
  assert.equal(r.spec.primaryAxisAlignItems, "SPACE_BETWEEN"); assert.equal(r.spec.counterAxisAlignItems, "CENTER");
  assert.equal(r.spec.height, 80); assert.notEqual(r.spec.layoutSizingVertical, "HUG");
  r = await convert(doc(".bar{display:flex;justify-content:center;gap:10px;width:800px}.bar div{width:100px;height:30px;background:#ccc}", `<div class="bar"><div></div><div></div></div>`));
  assert.equal(r.spec.primaryAxisAlignItems, "CENTER"); assert.equal(r.spec.itemSpacing, 10);
  r = await convert(doc(".bar{display:flex;justify-content:flex-end;width:800px}.bar div{width:100px;height:30px;background:#ccc}", `<div class="bar"><div></div></div>`));
  assert.equal(r.spec.primaryAxisAlignItems, "MAX");
  console.log("ok: justify-content / align-items");
}

// 4) grid: one row of columns fills; a 2D grid becomes rows in a column
{
  let r = await convert(doc(".g{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;width:940px}.g div{height:50px;background:#ddd}", `<div class="g"><div></div><div></div><div></div></div>`));
  assert.equal(r.spec.layoutMode, "HORIZONTAL"); assert.equal(r.spec.itemSpacing, 20);
  assert.ok(r.spec.children.every((c) => c.layoutSizingHorizontal === "FILL"), "equal grid columns fill");
  r = await convert(doc(".g{display:grid;grid-template-columns:repeat(2,1fr);gap:16px 24px;width:500px}.g div{height:50px;background:#ddd}", `<div class="g"><div></div><div></div><div></div><div></div></div>`));
  assert.equal(r.spec.layoutMode, "VERTICAL"); assert.equal(r.spec.itemSpacing, 16);
  assert.equal(r.spec.children.length, 2);
  assert.ok(r.spec.children.every((row) => row.layoutMode === "HORIZONTAL" && row.itemSpacing === 24 && row.children.length === 2 && row.layoutSizingHorizontal === "FILL"));
  console.log("ok: grid -> row / rows");
}

// 5) text: runs for mixed styles, transform, alignment, wrapping
{
  const { spec } = await convert(doc("p{font-size:18px;line-height:28px;width:400px;color:#333} b{font-weight:700} .hi{color:#E11D48;font-size:24px} a{text-decoration:underline}",
    `<p>Hemat <span class="hi">30%</span> dengan <b>paket</b> <a>ini</a> untuk kamu semua yang suka belanja hemat setiap hari</p>`));
  assert.equal(spec.type, "TEXT"); assert.equal(spec.fontSize, 18); assert.equal(spec.textColor, "#333333"); assert.equal(spec.lineHeight, 28);
  assert.equal(spec.characters, undefined);
  assert.equal(spec.runs.map((r) => r.text).join(""), "Hemat 30% dengan paket ini untuk kamu semua yang suka belanja hemat setiap hari");
  const hi = spec.runs.find((r) => r.text === "30%"); assert.equal(hi.color, "#E11D48"); assert.equal(hi.fontSize, 24);
  assert.equal(spec.runs.find((r) => r.text === "paket").fontStyle, "Bold");
  assert.equal(spec.runs.find((r) => r.text === "ini").textDecoration, "UNDERLINE");
  assert.equal(spec.textAutoResize, "HEIGHT"); assert.equal(spec.width, 400, "wrapped text keeps its width");
  const r2 = await convert(doc("h1{text-transform:uppercase;letter-spacing:2px;font-weight:600;font-size:30px;text-align:center;width:500px}", `<h1>Judul   halaman<br>kedua</h1>`));
  assert.equal(r2.spec.characters, "JUDUL HALAMAN\nKEDUA"); assert.equal(r2.spec.letterSpacing, 2);
  assert.equal(r2.spec.fontStyle, "Semi Bold"); assert.equal(r2.spec.textAlignHorizontal, "CENTER");
  console.log("ok: text runs, transform, whitespace, alignment");
}

// 6) button: frame with padding around a text
{
  const { spec } = await convert(doc(".btn{display:inline-block;padding:10px 20px;background:#2563EB;color:#fff;border-radius:6px;font-weight:600}", `<a class="btn">Beli</a>`));
  assert.equal(spec.type, "FRAME"); assert.equal(spec.layoutMode, "HORIZONTAL");
  assert.deepEqual([spec.paddingTop, spec.paddingLeft], [10, 20]);
  assert.equal(spec.children.length, 1); assert.equal(spec.children[0].characters, "Beli"); assert.equal(spec.children[0].textColor, "#FFFFFF");
  assert.equal(spec.children[0].fontStyle, "Semi Bold");
  assert.equal(spec.counterAxisAlignItems, "CENTER");
  console.log("ok: button -> padded frame + text");
}

// 7) absolute positioning; relative parent
{
  const { spec } = await convert(doc(".card{position:relative;width:300px;padding:20px;background:#fff}.tag{position:absolute;top:8px;right:8px;background:#f00;color:#fff;padding:2px 6px}", `<div class="card"><p>Isi kartu</p><span class="tag">Baru</span></div>`));
  const tag = named(spec, "span.tag");
  assert.equal(tag.layoutPositioning, "ABSOLUTE"); assert.equal(tag.y, 8);
  assert.ok(Math.abs(tag.x + tag.width - 300 + 8) < 1.5, "right: 8px -> x from the parent's left edge");
  assert.equal(spec.layoutMode, "VERTICAL");
  assert.equal(spec.children.length, 2);
  console.log("ok: position:absolute -> ABSOLUTE with x/y");
}

// 8) fills: gradient (angle and keyword), image, multiple layers
{
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const r = await convert(doc(".a{width:100px;height:50px;background:linear-gradient(to right,#000 0%,rgba(0,0,0,0) 100%)}.b{width:100px;height:50px;background:linear-gradient(90deg,#f00,#0f0 40%,#00f)}.c{width:100px;height:50px;background:linear-gradient(rgba(0,0,0,.5),rgba(0,0,0,.5)),url(" + png + ") center/cover,#fff}",
    `<div class="a"></div><div class="b"></div><div class="c"></div>`));
  const [a, b, c] = r.spec.children;
  assert.equal(a.fills[0].type, "GRADIENT_LINEAR"); assert.equal(a.fills[0].direction, "to right");
  assert.deepEqual(a.fills[0].stops, [{ position: 0, color: "#000000" }, { position: 1, color: "#00000000" }]);
  assert.equal(b.fills[0].cssAngle, 90); assert.deepEqual(b.fills[0].stops.map((s) => s.position), [0, 0.4, 1]);
  assert.deepEqual(b.fills[0].stops.map((s) => s.color), ["#FF0000", "#00FF00", "#0000FF"]);
  assert.equal(c.fills[0], "#FFFFFF"); assert.equal(c.fills[1].type, "IMAGE"); assert.equal(c.fills[1].base64, png); assert.equal(c.fills[1].scaleMode, "FILL");
  assert.equal(c.fills[2].type, "GRADIENT_LINEAR", "the CSS top layer is the last fill");
  console.log("ok: gradients and background images");
}

// 9) <img> and inline <svg>
{
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const r = await convert(doc("img{display:block}", `<div style="display:flex;gap:10px"><img alt="Logo" src="${png}" style="width:60px;height:40px;border-radius:8px;object-fit:contain"><img src="photos/a.jpg" style="width:80px;height:80px"><img style="width:20px;height:20px"><svg width="24" height="24" viewBox="0 0 24 24" style="color:#2563EB"><path d="M0 0h24" stroke="currentColor"/></svg></div>`));
  const [i1, i2, i3, svg] = r.spec.children;
  assert.equal(i1.type, "RECTANGLE"); assert.equal(i1.name, "img: Logo"); assert.equal(i1.fills[0].base64, png); assert.equal(i1.fills[0].scaleMode, "FIT"); assert.equal(i1.cornerRadius, 8);
  assert.equal(i2.fills[0].path, "photos/a.jpg", "relative paths are kept for the server to resolve"); assert.equal(i2.fills[0].url, undefined);
  assert.deepEqual(i3.fills, ["#E5E7EB"]); assert.ok(r.warnings.some((w) => /no src/.test(w)));
  assert.equal(svg.type, "SVG"); assert.match(svg.svg, /stroke="#2563EB"/); assert.match(svg.svg, /xmlns=/); assert.equal(svg.width, 24);
  const r2 = await convert(doc("", `<img src="https://example.com/x.png" style="width:50px;height:50px">`));
  assert.equal(r2.spec.fills[0].url, "https://example.com/x.png");
  console.log("ok: images (data/relative/http/missing) and inline svg");
}

// 10) layout: "absolute" mode and width
{
  const html = doc(".a{display:flex;gap:10px;padding:10px}.a div{width:50px;height:50px;background:#ccc}", `<div class="a"><div></div><div></div></div>`);
  const r = await convert(html, { layout: "absolute" });
  assert.equal(r.spec.layoutMode, undefined);
  assert.deepEqual(r.spec.children.map((c) => [c.x, c.y, c.width, c.height]), [[10, 10, 50, 50], [70, 10, 50, 50]]);
  const narrow = await convert(doc("body{margin:0}.p{background:#eee}", `<div class="p"><p>x</p></div>`), { width: 390 });
  assert.equal(narrow.spec.width, 390);
  console.log("ok: layout absolute, width option");
}

// 11) borders and warnings
{
  let r = await convert(doc("div{width:200px;height:60px;border-bottom:3px solid #0f0;padding:8px}", `<div>x</div>`));
  const line = named(r.spec, "border-bottom");
  assert.equal(line.type, "RECTANGLE"); assert.equal(line.height, 3); assert.equal(line.y, 57); assert.equal(line.width, 200); assert.deepEqual(line.fills, ["#00FF00"]);
  assert.equal(r.spec.strokes, undefined);
  r = await convert(doc("div{width:100px;height:40px;border:2px dashed #123;border-left:6px solid #123}", `<div></div>`));
  assert.ok(r.warnings.some((w) => /differ per side/.test(w)));
  r = await convert(doc("div{width:100px;height:40px;border:2px dashed #123;transform:rotate(3deg);backdrop-filter:blur(4px)}div::before{content:'x'}", `<div></div><ul><li>a</li></ul>`));
  assert.ok(r.warnings.some((w) => /dashed/.test(w)) && r.warnings.some((w) => /transform/.test(w)) && r.warnings.some((w) => /backdrop/.test(w)));
  assert.ok(r.warnings.some((w) => /::before/.test(w))); assert.ok(r.warnings.some((w) => /List markers/.test(w)));
  console.log("ok: single-side border and warnings");
}

// 12) sanitizing, selector, hidden content, errors
{
  let r = await convert(`<!doctype html><html><head><link rel="stylesheet" href="https://example.com/a.css"><style>@import url(x.css);.k{color:red}</style><script>window.__pwn = 1</script></head>
    <body><div onclick="window.__pwn=2" class="k" style="width:100px;background:#eee">Hi</div><iframe src="https://example.com"></iframe><p style="display:none">gone</p><p style="visibility:hidden">gone too</p></body></html>`);
  assert.ok(r.warnings.some((w) => /External stylesheet ignored/.test(w))); assert.ok(r.warnings.some((w) => /@import/.test(w)));
  assert.equal(await page.evaluate(() => window.__pwn), undefined, "scripts of the page never run");
  assert.equal(texts(r.spec).map((t) => t.characters).join("|"), "Hi");
  r = await convert(doc("", `<section id="a"><p>one</p></section><section id="b"><p>two</p></section>`), { selector: "#b", name: "Section B" });
  assert.equal(r.spec.name, "Section B"); assert.deepEqual(texts(r.spec).map((t) => t.characters), ["two"]);
  await assert.rejects(convert(doc("", `<p>x</p>`), { selector: "#nope" }), /matches nothing/);
  await assert.rejects(convert(`<!doctype html><body></body>`), /no visible content/);
  const css = await convert(doc("", `<div class="x">hi</div>`), { css: ".x{background:#123456;padding:4px}" });
  assert.deepEqual(css.spec.fills, ["#123456"]);
  console.log("ok: sanitizing, selector, hidden content, errors");
}

// 13) page background and root sizing
{
  const r = await convert(`<!doctype html><html style="background:#f0f0f0"><body style="margin:0"><div style="width:500px;height:100px"></div><div style="width:500px;height:100px"></div></body></html>`, { width: 500 });
  assert.deepEqual(r.spec.fills, ["#F0F0F0"], "background of <html> goes to the root frame");
  assert.equal(r.spec.layoutMode, "VERTICAL"); assert.equal(r.spec.width, 500);
  console.log("ok: root frame and page background");
}

// 14) regression: one child with a left margin must not turn the column into a grid of "rows"
{
  const { spec, stats } = await convert(doc(".b{height:20px;background:#ddd}.in{margin-left:30px}", `<div style="width:300px"><div class="b"></div><div class="b in"></div><div class="b"></div></div>`));
  assert.equal(spec.layoutMode, "VERTICAL"); assert.equal(spec.children.length, 3);
  assert.equal(spec.children.filter((c) => /^row /.test(c.name || "")).length, 0, "no synthetic rows");
  const wrap = spec.children[1];
  assert.equal(wrap.name, "margin"); assert.equal(wrap.layoutMode, "HORIZONTAL"); assert.equal(wrap.paddingLeft, 30);
  assert.equal(wrap.layoutSizingHorizontal, "FILL", "the pushed-in block still reaches the right edge");
  assert.equal(wrap.children[0].layoutSizingHorizontal, "FILL");
  assert.equal(stats.absoluteFallbacks, 0);
  // a real grid of two rows still becomes rows
  const g = await convert(doc(".c{display:flex;flex-wrap:wrap;width:320px;gap:10px}.c div{width:150px;height:30px;background:#ccc}", `<div class="c"><div></div><div></div><div></div><div></div></div>`));
  assert.ok(g.spec.layoutWrap === "WRAP" || g.spec.layoutMode === "VERTICAL");
  const end = await convert(doc(".c{display:flex;flex-direction:column;align-items:flex-end;width:300px}.c div{height:20px;background:#ccc}", `<div class="c"><div style="width:100px"></div><div style="width:200px"></div></div>`));
  assert.equal(end.spec.counterAxisAlignItems, "MAX"); assert.ok(!end.spec.children.some((c) => c.name === "margin"));
  console.log("ok: margin wrapper instead of false grid rows");
}

assert.deepEqual(pageErrors.filter((e) => !/WebSocket|ERR_/.test(e)), [], "no script errors in the plugin window");
await browser.close();
console.log("\nHTML CONVERTER TESTS PASSED");
process.exit(0);
