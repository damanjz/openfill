// Minimal PNG encoder: 8-bit gray / RGB / RGBA, Sub filter, zlib with fixed-Huffman deflate + LZ77.
// Pure JS so it runs in UXP (no canvas, no zlib) and in Node tests.

const { concat, crc32, adler32 } = require("./bytes");

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// Lookup tables: length (3..258) -> code index, distance (1..32768) -> code index.
const LEN_CODE = new Uint8Array(259);
for (let i = 0; i < LEN_BASE.length; i++) {
  const top = i + 1 < LEN_BASE.length ? LEN_BASE[i + 1] : 259;
  for (let l = LEN_BASE[i]; l < top && l < 259; l++) LEN_CODE[l] = i;
}
LEN_CODE[258] = 28;

function distCode(d) {
  let lo = 0;
  let hi = DIST_BASE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>= 1;
  }
  return r;
}

class BitWriter {
  constructor(sizeHint) {
    this.buf = new Uint8Array(Math.max(1024, sizeHint));
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
  }
  ensure(extra) {
    if (this.pos + extra < this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra + 1024));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  bits(value, len) {
    this.acc |= value << this.n;
    this.n += len;
    while (this.n >= 8) {
      this.ensure(1);
      this.buf[this.pos++] = this.acc & 255;
      this.acc >>>= 8;
      this.n -= 8;
    }
  }
  huff(code, len) {
    this.bits(reverseBits(code, len), len);
  }
  finish() {
    if (this.n > 0) {
      this.ensure(1);
      this.buf[this.pos++] = this.acc & 255;
      this.acc = 0;
      this.n = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

function writeLiteral(w, v) {
  if (v < 144) w.huff(0x30 + v, 8);
  else w.huff(0x190 + (v - 144), 9);
}

function writeLitLenSymbol(w, sym) {
  if (sym < 256) writeLiteral(w, sym);
  else if (sym < 280) w.huff(sym - 256, 7);
  else w.huff(0xc0 + (sym - 280), 8);
}

// Raw deflate (single fixed-Huffman block) with greedy hash-chain LZ77.
function deflateRaw(data, { maxChain = 16 } = {}) {
  const w = new BitWriter(Math.ceil(data.length * 0.6) + 64);
  w.bits(1, 1); // BFINAL
  w.bits(1, 2); // BTYPE = 01 fixed Huffman
  const WSIZE = 32768;
  const HBITS = 15;
  const head = new Int32Array(1 << HBITS).fill(-1);
  const prev = new Int32Array(WSIZE);
  const n = data.length;
  const hash = (i) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & ((1 << HBITS) - 1));
  const insert = (i) => {
    const h = hash(i);
    prev[i & (WSIZE - 1)] = head[h];
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < n) {
      const h = hash(i);
      let cand = head[h];
      let chain = maxChain;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && i - cand <= WSIZE && chain-- > 0) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === maxLen) break;
          }
        }
        cand = prev[cand & (WSIZE - 1)];
      }
    }
    if (bestLen >= 3) {
      const lc = LEN_CODE[bestLen];
      writeLitLenSymbol(w, 257 + lc);
      if (LEN_EXTRA[lc]) w.bits(bestLen - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCode(bestDist);
      w.huff(dc, 5);
      if (DIST_EXTRA[dc]) w.bits(bestDist - DIST_BASE[dc], DIST_EXTRA[dc]);
      const end = i + bestLen;
      for (; i < end; i++) if (i + 2 < n) insert(i);
    } else {
      writeLiteral(w, data[i]);
      if (i + 2 < n) insert(i);
      i++;
    }
  }
  writeLitLenSymbol(w, 256); // end of block
  return w.finish();
}

function zlibCompress(data) {
  const body = deflateRaw(data);
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  const a = adler32(data);
  const p = body.length + 2;
  out[p] = (a >>> 24) & 255;
  out[p + 1] = (a >>> 16) & 255;
  out[p + 2] = (a >>> 8) & 255;
  out[p + 3] = a & 255;
  return out;
}

function u32(v) {
  return Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

function chunk(type, data) {
  const typeBytes = Uint8Array.from(type, (c) => c.charCodeAt(0));
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

const COLOR_TYPE = { 1: 0, 3: 2, 4: 6 };

/**
 * Encode interleaved 8-bit pixels as PNG.
 * @param {Uint8Array} pixels  width*height*components bytes
 * @param {number} width
 * @param {number} height
 * @param {1|3|4} components
 * @param {{ppi?: number}} [opts] optional resolution written to pHYs
 */
function encodePng(pixels, width, height, components, opts = {}) {
  const ct = COLOR_TYPE[components];
  if (ct === undefined) throw new Error(`Unsupported component count: ${components}`);
  if (pixels.length !== width * height * components) throw new Error("Pixel buffer size does not match dimensions");
  const stride = width * components;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 1; // Sub filter
    for (let x = 0; x < stride; x++) {
      const left = x >= components ? pixels[src + x - components] : 0;
      raw[dst + 1 + x] = (pixels[src + x] - left) & 255;
    }
  }
  const ihdr = concat([u32(width), u32(height), Uint8Array.of(8, ct, 0, 0, 0)]);
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk("IHDR", ihdr)];
  if (opts.ppi) {
    const ppm = Math.round(opts.ppi / 0.0254);
    parts.push(chunk("pHYs", concat([u32(ppm), u32(ppm), Uint8Array.of(1)])));
  }
  parts.push(chunk("IDAT", zlibCompress(raw)), chunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

/** Read width/height from PNG or JPEG bytes without decoding. Returns null if unknown. */
function imageSize(bytes) {
  if (bytes.length > 24 && bytes[0] === 137 && bytes[1] === 80) {
    const r = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    return { width: r(16), height: r(20), type: "png" };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1];
      const len = (bytes[o + 2] << 8) | bytes[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (bytes[o + 7] << 8) | bytes[o + 8], height: (bytes[o + 5] << 8) | bytes[o + 6], type: "jpeg" };
      }
      o += 2 + len;
    }
    return null;
  }
  if (bytes.length > 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return { width: 0, height: 0, type: "webp" };
  }
  return null;
}

module.exports = { encodePng, deflateRaw, zlibCompress, imageSize };
