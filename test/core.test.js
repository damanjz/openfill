const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const { toBase64, fromBase64, utf8Encode, crc32, adler32 } = require("../plugin/src/bytes");
const { encodePng, deflateRaw, imageSize } = require("../plugin/src/png");
const { computeCrop, inputSize, planExpand } = require("../plugin/src/geometry");
const { resample, toRGB, dilate, alphaEditMask, maskBounds, downsampleStrips } = require("../plugin/src/image");

function randomBytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

test("base64 round-trips and matches Node", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100, 12289, 50000]) {
    const b = randomBytes(n, n + 7);
    const enc = toBase64(b);
    assert.equal(enc, Buffer.from(b).toString("base64"));
    assert.deepEqual(fromBase64(enc), b);
  }
  assert.deepEqual(fromBase64("aGVs\nbG8="), utf8Encode("hello"));
});

test("utf8 encode matches Node", () => {
  const s = "Fill with a café ☕ and 🌄 sky, हिंदी";
  assert.deepEqual(Buffer.from(utf8Encode(s)), Buffer.from(s, "utf8"));
});

test("crc32 and adler32 match zlib", () => {
  const b = randomBytes(100000);
  assert.equal(crc32(b), zlib.crc32 ? zlib.crc32(b) : crc32(b));
  // adler32 checked indirectly through zlib inflate in the PNG test
  assert.equal(adler32(utf8Encode("Wikipedia")), 0x11e60398);
});

test("deflate output inflates back to the input (random, runs, mixed)", () => {
  const cases = [
    new Uint8Array(0),
    randomBytes(1),
    randomBytes(70000),
    new Uint8Array(200000).fill(7),
    Uint8Array.from({ length: 100000 }, (_, i) => (i % 300 < 150 ? 0 : (i * 31) & 255)),
  ];
  for (const c of cases) {
    const raw = deflateRaw(c);
    assert.deepEqual(new Uint8Array(zlib.inflateRawSync(raw)), c);
  }
  // runs compress hard
  assert.ok(deflateRaw(new Uint8Array(200000)).length < 2000);
});

function decodePng(bytes) {
  // tiny test-only decoder for our own Sub-filtered output
  const buf = Buffer.from(bytes);
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8;
  let w, h, ct;
  const idat = [];
  const types = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    const crc = buf.readUInt32BE(o + 8 + len);
    assert.equal(crc, crc32(bytes, o + 4, o + 8 + len), `crc of ${type}`);
    types.push(type);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ct = data[9];
    }
    if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const comps = { 0: 1, 2: 3, 6: 4 }[ct];
  const raw = zlib.inflateSync(Buffer.concat(idat)); // checks adler32 too
  const stride = w * comps;
  const px = new Uint8Array(w * h * comps);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (stride + 1)], 1);
    for (let x = 0; x < stride; x++) {
      const left = x >= comps ? px[y * stride + x - comps] : 0;
      px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + left) & 255;
    }
  }
  return { w, h, comps, px, types };
}

test("PNG encodes gray, RGB and RGBA losslessly with valid chunks", () => {
  for (const comps of [1, 3, 4]) {
    const w = 37, h = 23;
    const px = randomBytes(w * h * comps, comps);
    const png = encodePng(px, w, h, comps, { ppi: 300 });
    const d = decodePng(png);
    assert.equal(d.w, w);
    assert.equal(d.h, h);
    assert.equal(d.comps, comps);
    assert.deepEqual(d.px, px);
    assert.deepEqual(d.types, ["IHDR", "pHYs", "IDAT", "IEND"]);
    assert.deepEqual(imageSize(png), { width: w, height: h, type: "png" });
  }
  assert.throws(() => encodePng(new Uint8Array(5), 2, 2, 3));
});

test("PNG of a 1536x1024 mask stays small and encodes fast", () => {
  const w = 1536, h = 1024;
  const mask = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) mask[i * 4 + 3] = (i % w) > 600 && (i % w) < 900 ? 0 : 255;
  const t = Date.now();
  const png = encodePng(mask, w, h, 4);
  const ms = Date.now() - t;
  assert.ok(png.length < 200000, `mask png ${png.length} bytes`);
  assert.ok(ms < 3000, `took ${ms}ms`);
});

test("imageSize reads JPEG dimensions", () => {
  // SOI, APP0 (len 16), SOF0 with h=480 w=640
  const jpg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ]);
  assert.deepEqual(imageSize(jpg), { width: 640, height: 480, type: "jpeg" });
  assert.equal(imageSize(Uint8Array.from([1, 2, 3])), null);
});

const SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

// closest-aspect pick from a fixed list, like a fixed-size model
const fit = (w, h) => {
  let best = SIZES[0], err = Infinity;
  for (const z of SIZES) {
    const e = Math.abs(Math.log(z.width / z.height) - Math.log(w / h));
    if (e < err) { err = e; best = z; }
  }
  return best;
};

test("inputSize caps the long edge and keeps aspect", () => {
  assert.deepEqual(inputSize({ width: 4096, height: 2048 }), { width: 2048, height: 1024 });
  assert.deepEqual(inputSize({ width: 1024, height: 1536 }), { width: 1024, height: 1536 });
});

test("computeCrop keeps the selection inside, stays in the document, matches aspect", () => {
  const docWidth = 6000, docHeight = 4000;
  const selections = [
    { left: 100, top: 100, right: 300, bottom: 260 },
    { left: 5800, top: 3900, right: 6000, bottom: 4000 },
    { left: 0, top: 0, right: 6000, bottom: 4000 },
    { left: 2000, top: 500, right: 2100, bottom: 3500 },
  ];
  for (const selection of selections) {
    const { crop, target, scaleX, scaleY } = computeCrop({ docWidth, docHeight, selection, fit });
    assert.ok(crop.left >= 0 && crop.top >= 0 && crop.right <= docWidth && crop.bottom <= docHeight, "inside doc");
    assert.ok(crop.left <= selection.left && crop.top <= selection.top, "contains selection (top-left)");
    assert.ok(crop.right >= selection.right && crop.bottom >= selection.bottom, "contains selection (bottom-right)");
    const cw = crop.right - crop.left, ch = crop.bottom - crop.top;
    assert.ok(Math.abs(cw / ch - target.width / target.height) < 0.01, `aspect ${cw}x${ch} vs ${target.width}x${target.height}`);
    assert.ok(Math.abs(scaleX - scaleY) / scaleX < 0.01);
    assert.ok(Number.isInteger(crop.left) && Number.isInteger(crop.right));
  }
});

test("computeCrop on a tiny document never exceeds it", () => {
  const r = computeCrop({ docWidth: 300, docHeight: 200, selection: { left: 10, top: 10, right: 50, bottom: 50 }, fit });
  assert.deepEqual(r.crop, { left: 0, top: 0, right: 300, bottom: 200 });
  assert.deepEqual(r.target, SIZES[1]);
  assert.ok(r.softness < 1);
});

test("computeCrop reports softness for huge areas", () => {
  const r = computeCrop({ docWidth: 6000, docHeight: 4000, selection: { left: 0, top: 0, right: 6000, bottom: 4000 }, fit });
  assert.ok(r.softness > 3.5);
});

test("planExpand anchors and sizes correctly", () => {
  const all = planExpand({ docWidth: 1000, docHeight: 800, percent: 25, sides: { left: true, right: true, top: true, bottom: true } });
  assert.equal(all.newWidth, 1500);
  assert.equal(all.newHeight, 1200);
  assert.equal(all.anchor, "MIDDLECENTER");
  assert.deepEqual(all.original, { left: 250, top: 200, right: 1250, bottom: 1000 });
  assert.deepEqual(all.keep, { left: 274, top: 224, right: 1226, bottom: 976 });

  const right = planExpand({ docWidth: 1000, docHeight: 800, percent: 50, sides: { right: true } });
  assert.equal(right.newWidth, 1500);
  assert.equal(right.newHeight, 800);
  assert.equal(right.anchor, "MIDDLELEFT");
  assert.deepEqual(right.keep, { left: 0, top: 0, right: 976, bottom: 800 });

  const top = planExpand({ docWidth: 1000, docHeight: 800, percent: 10, sides: { top: true } });
  assert.equal(top.anchor, "BOTTOMCENTER");
  assert.throws(() => planExpand({ docWidth: 10, docHeight: 10, percent: 0, sides: { top: true } }));
  assert.throws(() => planExpand({ docWidth: 10, docHeight: 10, percent: 5, sides: {} }));
});

test("resample keeps flat colours and exact sizes", () => {
  const src = new Uint8Array(10 * 6 * 3);
  for (let i = 0; i < src.length; i += 3) { src[i] = 200; src[i + 1] = 100; src[i + 2] = 50; }
  const out = resample(src, 10, 6, 3, 17, 4);
  assert.equal(out.length, 17 * 4 * 3);
  for (let i = 0; i < out.length; i += 3) assert.deepEqual([out[i], out[i + 1], out[i + 2]], [200, 100, 50]);
  // gradient stays monotonic
  const g = Uint8Array.from({ length: 8 }, (_, i) => i * 32);
  const up = resample(g, 8, 1, 1, 32, 1);
  for (let i = 1; i < up.length; i++) assert.ok(up[i] >= up[i - 1]);
});

test("toRGB composites alpha over grey", () => {
  const rgba = Uint8Array.of(255, 0, 0, 255, 255, 0, 0, 0);
  assert.deepEqual(toRGB(rgba, 2, 1, 4), Uint8Array.of(255, 0, 0, 128, 128, 128));
});

test("dilate grows a single pixel into a square", () => {
  const m = new Uint8Array(25);
  m[12] = 255;
  const d = dilate(m, 5, 5, 1);
  assert.deepEqual(maskBounds(d, 5, 5), { left: 1, top: 1, right: 4, bottom: 4 });
  assert.equal(maskBounds(new Uint8Array(4), 2, 2), null);
});

test("alphaEditMask marks selected pixels transparent", () => {
  assert.deepEqual(alphaEditMask(Uint8Array.of(0, 255, 10)), Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0));
});

test("downsampleStrips keeps edges exactly where they belong, reading in strips", async () => {
  // 900x600 source, red left of x=563, blue from x=563 (an odd split), read as 37-row strips
  const W = 900, H = 600;
  const src = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) src.set(x < 563 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * W + x) * 4);
  const reads = [];
  const strip = async (y0, y1) => {
    reads.push([y0, y1]);
    return src.subarray(y0 * W * 4, y1 * W * 4);
  };
  for (const [ow, oh] of [[450, 300], [300, 200], [617, 411]]) {
    reads.length = 0;
    const out = await downsampleStrips(strip, W, H, 4, ow, oh, 37);
    assert.equal(out.length, ow * oh * 4);
    const split = (563 * ow) / W;
    const at = (x) => [out[x * 4], out[x * 4 + 1], out[x * 4 + 2]];
    assert.deepEqual(at(Math.floor(split) - 1), [255, 0, 0], `${ow}: left of split is red`);
    assert.deepEqual(at(Math.ceil(split) + 1), [0, 0, 255], `${ow}: right of split is blue`);
    // strips cover every row exactly once, in order
    let next = 0;
    for (const [a, b] of reads) { assert.equal(a, next); next = b; }
    assert.equal(next, H);
  }
  await assert.rejects(downsampleStrips(strip, 10, 10, 4, 20, 10), /only shrinks/);
});
