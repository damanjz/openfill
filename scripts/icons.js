// Draw the plugin icons (dashed selection marquee with a solid fill inside) with the plugin's own PNG encoder.
// Run: node scripts/icons.js

const fs = require("node:fs");
const path = require("node:path");
const { encodePng } = require("../plugin/src/png");

const OUT = path.join(__dirname, "..", "plugin", "icons");

function draw(size, rgb) {
  const px = new Uint8Array(size * size * 4);
  const s = size / 24; // design grid 24x24
  const SS = 4; // supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const gx = (x + (sx + 0.5) / SS) / s;
          const gy = (y + (sy + 0.5) / SS) / s;
          // dashed square outline 3..21, 1.5 thick, dashes 3 on / 2 off
          const inOuter = gx >= 3 && gx <= 21 && gy >= 3 && gy <= 21;
          const inInner = gx > 4.5 && gx < 19.5 && gy > 4.5 && gy < 19.5;
          let on = false;
          if (inOuter && !inInner) {
            const along = gy < 4.5 || gy > 19.5 ? gx - 3 : gy - 3;
            on = along % 5 < 3;
          }
          // solid fill: circle centre (12,12) r 5
          if ((gx - 12) ** 2 + (gy - 12) ** 2 <= 25) on = true;
          if (on) cover++;
        }
      }
      const a = Math.round((cover / (SS * SS)) * 255);
      const o = (y * size + x) * 4;
      px[o] = rgb[0];
      px[o + 1] = rgb[1];
      px[o + 2] = rgb[2];
      px[o + 3] = a;
    }
  }
  return encodePng(px, size, size, 4);
}

fs.mkdirSync(OUT, { recursive: true });
const variants = [
  ["dark", [235, 235, 235]], // light glyph for dark UI themes
  ["light", [50, 50, 50]], // dark glyph for light UI themes
];
for (const [name, rgb] of variants) {
  fs.writeFileSync(path.join(OUT, `icon-${name}@1x.png`), draw(23, rgb));
  fs.writeFileSync(path.join(OUT, `icon-${name}@2x.png`), draw(46, rgb));
}
fs.writeFileSync(path.join(OUT, "plugin@1x.png"), draw(48, [55, 142, 240]));
fs.writeFileSync(path.join(OUT, "plugin@2x.png"), draw(96, [55, 142, 240]));
console.log("icons written to plugin/icons");
