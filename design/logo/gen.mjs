// Throwaway generator for design/logo/preview.html (not part of the app).
import fs from "node:fs";
const A = {
  bubL: "M24 6H40A20 20 0 0 1 60 26V38A20 20 0 0 1 40 58H4V26A20 20 0 0 1 24 6Z",
  bubR: "M40 6H24A20 20 0 0 0 4 26V38A20 20 0 0 0 24 58H60V26A20 20 0 0 0 40 6Z",
};
const variants = {
  A: { tick: "M17 34C20 37 22 40 25 44C30 36 35 31 42 27", dot: [53, 12, 8], dotR: [11, 12, 8], label: "A (recommended): dot on the corner, hooked tick" },
  B: { tick: "M17 31C21 34 25 39 28 45C32 35 38 28 47 23", dot: [53, 12, 8], dotR: [11, 12, 8], label: "B: deeper bowl, longer arm" },
  C: { tick: "M17 34C20 37 22 40 25 44C30 36 35 31 42 27", dot: [53, 52, 8], dotR: [11, 52, 8], label: "C: dot at bottom inline-end" },
};
let id = 0;
function svg(v, { size = 64, tone = "color", rtl = false }) {
  const k = variants[v], n = id++;
  const knock = tone !== "color"; const dd0 = rtl ? k.dotR : k.dot;
  const col = tone === "color" ? ["#2549D1", "#F2A93B"] : tone === "mono-light" ? ["#fff", "#fff"] : ["#101C3A", "#101C3A"];
  const d = rtl ? k.dotR : k.dot;
  const tick = (s) => `<path d="${k.tick}" fill="none" stroke="${s}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><defs><mask id="m${n}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/><circle cx="${dd0[0]}" cy="${dd0[1]}" r="${dd0[2] + 3}" fill="#000"/>${knock ? tick("#000") : ""}</mask></defs><path d="${rtl ? A.bubR : A.bubL}" fill="${col[0]}" mask="url(#m${n})"/><circle cx="${d[0]}" cy="${d[1]}" r="${d[2]}" fill="${col[1]}"/>${knock ? "" : tick("#fff")}</svg>`;
}
const bgs = [["Paper", "#fff", "color"], ["Mist", "#EEF2F9", "color"], ["Ink", "#101C3A", "mono-light"], ["Cobalt", "#2549D1", "mono-light"]];
const sizes = [16, 24, 32, 48, 64, 128, 256];
let h = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dawrak logo preview</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=Readex+Pro:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>body{margin:0;padding:32px;font-family:'IBM Plex Sans Arabic',sans-serif;background:#f6f7fb;color:#101C3A;width:1216px}
h1{font-family:'Readex Pro'}h2{font-family:'Readex Pro';margin:36px 0 8px;font-size:20px}
.row{display:flex;align-items:flex-end;gap:20px;padding:20px;border-radius:12px;margin:8px 0;border:1px solid #D3DBEB}
.row small{width:70px;font-size:12px;opacity:.7;align-self:center}
.lock{display:inline-flex;align-items:center;gap:.4em;font-family:'Readex Pro';font-weight:700;line-height:1}.lock span{font-size:.72em}
.grid{display:flex;gap:12px;flex-wrap:wrap}.box{padding:20px 24px;border-radius:12px;border:1px solid #D3DBEB}
.fav{display:flex;gap:24px;align-items:center;background:#dee1e8;padding:14px;border-radius:10px;flex-wrap:wrap}
.tab{background:#fff;border-radius:8px 8px 0 0;padding:8px 12px;display:flex;gap:8px;align-items:center;font:13px sans-serif;width:160px}
.app{border-radius:22.5%;overflow:hidden;display:inline-block;line-height:0}</style></head><body><h1>Dawrak logo, step 1 preview</h1>`;
for (const v of Object.keys(variants)) {
  h += `<h2>Variant ${variants[v].label}</h2>`;
  for (const [n, c, t] of bgs) h += `<div class="row" style="background:${c}"><small style="color:${t === "color" ? "#101C3A" : "#fff"}">${n}</small>${sizes.map((s) => svg(v, { size: s, tone: t })).join("")}</div>`;
  h += `<div class="row" style="background:#fff"><small>mono-dark</small>${sizes.map((s) => svg(v, { size: s, tone: "mono-dark" })).join("")}<small>RTL mark</small>${[32, 64, 128].map((s) => svg(v, { size: s, rtl: true })).join("")}</div>`;
  h += `<div class="grid">`;
  for (const [rtl, txt] of [[true, "دورك"], [false, "Dawrak"]])
    for (const [c, t, ink] of [["#fff", "color", "#101C3A"], ["#EEF2F9", "color", "#101C3A"], ["#101C3A", "mono-light", "#fff"], ["#2549D1", "mono-light", "#fff"]])
      h += `<div class="box" style="background:${c};color:${ink}" dir="${rtl ? "rtl" : "ltr"}"><span class="lock" style="font-size:48px">${svg(v, { size: 48, tone: t, rtl })}<span>${txt}</span></span><br><br><span class="lock" style="font-size:24px">${svg(v, { size: 24, tone: t, rtl })}<span>${txt}</span></span></div>`;
  h += `</div><div class="fav" style="margin-top:12px"><div class="tab">${svg(v, { size: 16 })}<span>Dawrak</span></div><div style="display:flex;gap:8px;align-items:center">${svg(v, { size: 16 })}${svg(v, { size: 32 })}<small>favicon 16 / 32 actual px</small></div>
 <span class="app" style="background:#fff"><span style="display:block;padding:0">${svg(v, { size: 180 })}</span></span>
 <span class="app" style="background:#EEF2F9"><span style="display:block;padding:34px">${svg(v, { size: 112 })}</span></span>
 <span class="app" style="background:#2549D1"><span style="display:block;padding:34px">${svg(v, { size: 112, tone: "mono-light" })}</span></span></div>`;
}
h += "</body></html>";
fs.writeFileSync(new URL("./preview.html", import.meta.url), h);
