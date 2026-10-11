// Developer self-test, run inside real Photoshop. Not shipped: scripts/package.js leaves this file out.
//
// Trigger: drop selftest.json into the plugin's data folder
//   (%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<ver>\External\<id>\PluginData). The panel picks it up within
//   a few seconds, runs every scenario on throwaway documents, and writes selftest\result.json plus PNG
//   snapshots next to it. selftest.json may contain {"only": ["fill", ...]} or {"live": "openai"|"gemini"}.
//
// Scenarios use a stand-in AI service that returns a position-encoded gradient (R = x, G = y), so every
// probe can check that the result landed exactly where it should, at any resolution or bit depth.

const { app, action, constants } = require("photoshop");
const uxp = require("uxp");
const ps = require("./photoshop");
const { runGeneration, layerName } = require("./pipeline");
const openai = require("./providers/openai");
const gemini = require("./providers/gemini");
const settings = require("./settings");
const { encodePng } = require("./png");
const { toRGB } = require("./image");

const lfs = uxp.storage.localFileSystem;
const formats = uxp.storage.formats;
const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const SELECTION = { _ref: "channel", _property: "selection" };
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

// ---------- images from the stand-in service ----------

function gradientPng(w, h) {
  const p = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      p[o] = Math.round((x * 255) / (w - 1));
      p[o + 1] = Math.round((y * 255) / (h - 1));
      p[o + 2] = 0;
    }
  }
  return encodePng(p, w, h, 3);
}

function solidPng(w, h, rgb) {
  const p = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) p.set(rgb, i * 3);
  return encodePng(p, w, h, 3);
}

/** Stand-in AI service. Variation 1 is the gradient, others solid colours. */
function mockProvider({ base = openai, colors = [null, [0, 255, 0], [255, 255, 0], [0, 255, 255]], scale = 1, garbage = false } = {}) {
  const m = {
    name: "Mock",
    requests: [],
    fitSize: base.fitSize,
    async generate(req) {
      m.requests.push(req);
      if (garbage) return [{ bytes: Uint8Array.of(1, 2, 3, 4, 5), mime: "image/png" }];
      const W = Math.round(req.target.width * scale);
      const H = Math.round(req.target.height * scale);
      m.outSize = { W, H };
      return Array.from({ length: req.n }, (_, i) => ({ bytes: i === 0 ? gradientPng(W, H) : solidPng(W, H, colors[i]), mime: "image/png" }));
    },
  };
  return m;
}

// ---------- assertions ----------

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function near(actual, expected, tol, label) {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(actual[k] - expected[k]) > tol) throw new Error(`${label}: got [${actual.slice(0, 3)}], expected [${expected.map(Math.round)}] (±${tol})`);
  }
}

function gradAt(x, y, crop, W, H) {
  const fx = ((x + 0.5 - crop.left) / (crop.right - crop.left)) * W - 0.5;
  const fy = ((y + 0.5 - crop.top) / (crop.bottom - crop.top)) * H - 0.5;
  const c = (v) => Math.max(0, Math.min(255, v));
  return [c((fx * 255) / (W - 1)), c((fy * 255) / (H - 1)), 0];
}

// ---------- Photoshop helpers (each in its own modal scope) ----------

const made = [];

/** Pattern image, left half red, right half blue, written as a PNG and opened like a user would. */
async function newDoc({ width = 1200, height = 800, resolution = 72, transparent = false, bits16 = false, opaque = null } = {}) {
  const comps = transparent ? 4 : 3;
  const p = new Uint8Array(width * height * comps);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * comps;
      p.set(x < width / 2 ? RED : BLUE, o);
      if (comps === 4) p[o + 3] = !opaque || (x >= opaque.left && x < opaque.right && y >= opaque.top && y < opaque.bottom) ? 255 : 0;
    }
  }
  const png = encodePng(p, width, height, comps, { ppi: resolution });
  // Unique name per document: rewriting a file Photoshop has open triggers its "disk copy changed" dialog.
  const file = await outFolder.createFile(`pattern-${width}x${height}-${resolution}${transparent ? "-alpha" : ""}${opaque ? "-island" : ""}-${Date.now()}-${made.length}.png`, { overwrite: true });
  await file.write(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), { format: formats.binary });
  return ps.modal("OpenFill self-test: open", async () => {
    const d = await app.open(file);
    made.push(d);
    if (bits16) d.bitsPerChannel = constants.BitsPerChannelType.SIXTEEN;
    return d;
  });
}

async function selectRect(r) {
  await ps.bp([{ _obj: "set", _target: [SELECTION], to: { _obj: "rectangle", top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) } }]);
}

async function select(doc, shape, r) {
  return ps.modal("OpenFill self-test: select", async () => {
    if (shape === "none") return ps.bp([{ _obj: "set", _target: [SELECTION], to: { _enum: "ordinal", _value: "none" } }]);
    if (shape === "ellipse") {
      return ps.bp([{ _obj: "set", _target: [SELECTION], to: { _obj: "ellipse", top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) }, antiAlias: true }]);
    }
    return selectRect(r);
  });
}

// Photoshop 27.10 returns wrong pixels for tiny (1x1) imaging reads, so probes read the whole
// document at full resolution and look the pixel up.
async function readWhole(doc) {
  const w = Math.round(doc.width);
  const h = Math.round(doc.height);
  const r = await ps.modal("OpenFill self-test: read", () => ps.readComposite(doc.id, { left: 0, top: 0, right: w, bottom: h }, { width: w, height: h }));
  expect(r.width === w && r.height === h, `full read came back ${r.width}x${r.height}, expected ${w}x${h}`);
  return r;
}

async function probe(doc, x, y) {
  const r = await readWhole(doc);
  const o = (y * r.width + x) * r.components;
  const a = r.components === 4 ? r.data[o + 3] / 255 : 1;
  return [Math.round(r.data[o] * a), Math.round(r.data[o + 1] * a), Math.round(r.data[o + 2] * a), Math.round(a * 255)];
}

const historyCount = (doc) => doc.historyStates.length;

async function undoTo(doc, count) {
  await ps.modal("OpenFill self-test: undo", async () => {
    doc.activeHistoryState = doc.historyStates[count - 1];
  });
}

async function groupInfo(doc, groupId) {
  const group = Array.from(doc.layers).find((l) => l.id === groupId);
  expect(group, `group ${groupId} not found at top level`);
  const [m] = await ps.modal("OpenFill self-test: inspect", () =>
    ps.bp([{ _obj: "get", _target: [{ _property: "hasUserMask" }, { _ref: "layer", _id: groupId }, { _ref: "document", _id: doc.id }] }])
  );
  return {
    name: group.name,
    hasMask: !!(m && m.hasUserMask),
    feather: group.layerMaskFeather,
    children: Array.from(group.layers || []).map((l) => ({ id: l.id, name: l.name, visible: l.visible })),
  };
}

let outFolder = null;

async function snapshot(doc, name) {
  const w = Math.round(doc.width);
  const h = Math.round(doc.height);
  const k = Math.min(1, 640 / Math.max(w, h));
  const size = { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
  const r = await ps.modal("OpenFill self-test: snapshot", () => ps.readComposite(doc.id, { left: 0, top: 0, right: w, bottom: h }, size));
  const rgb = toRGB(r.data, r.width, r.height, r.components, 200);
  const file = await outFolder.createFile(`${name}.png`, { overwrite: true });
  const png = encodePng(rgb, r.width, r.height, 3);
  await file.write(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), { format: formats.binary });
}

function run(provider, extra) {
  return runGeneration({ ps, provider, fetch: (u, i) => fetch(u, i), apiKey: "selftest", model: "selftest-model", maxTier: "2K", n: 1, ...extra });
}

// ---------- scenarios ----------

/** Standard fill check on a painted doc: input sent, placement accuracy, mask, history, undo. */
async function fillScenario(name, docOpts, sel, { shape = "rect", base = openai, scale = 1, n = 1, mode = "fill" } = {}) {
  const doc = await newDoc(docOpts);
  await select(doc, shape, sel);
  const h0 = historyCount(doc);
  const prov = mockProvider({ base, scale });
  const trace = [];
  const out = await run(prov, { mode, prompt: `selftest ${name}`, n, trace });
  await snapshot(doc, name);
  const req = prov.requests[0];
  const crop = out.crop;
  const notes = { crop, target: out.target, input: { w: req.image.width, h: req.image.height }, out: prov.outSize, trace };
  try {

  // What the service received: the right pixels at the right place, and the right mask.
  const at = (x, y) => {
    const ix = Math.floor(((x - crop.left) * req.image.width) / (crop.right - crop.left));
    const iy = Math.floor(((y - crop.top) * req.image.height) / (crop.bottom - crop.top));
    const o = iy * req.image.width + ix;
    return { rgb: [req.image.rgb[o * 3], req.image.rgb[o * 3 + 1], req.image.rgb[o * 3 + 2]], mask: req.mask[o] };
  };
  const cx = Math.round((sel.left + sel.right) / 2);
  const cy = Math.round((sel.top + sel.bottom) / 2);
  expect(at(cx, cy).mask === 255, "mask sent to service: selection centre not marked");
  const halfW = Math.round(docOpts.width || 1200) / 2;
  // The mask sent to the service is grown ~1% of the upload (so the model can blend); stay outside that.
  const grownDoc = Math.ceil((Math.max(req.image.width, req.image.height) * 0.01 * (crop.right - crop.left)) / req.image.width) + 4;
  const gap = 40 + grownDoc;
  const outsideLeft = { x: Math.max(crop.left + 2, Math.min(sel.left - gap, halfW - 20)), y: cy };
  if (outsideLeft.x <= sel.left - gap && outsideLeft.x < halfW) {
    const s = at(outsideLeft.x, outsideLeft.y);
    near(s.rgb, RED, 12, "image sent to service (left of selection)");
    expect(s.mask === 0, "mask sent to service marks an unselected pixel");
  }
  if (mode === "remove") expect(/Remove everything/.test(req.task), "remove mode did not send the remove instruction");

  // Result placed exactly over the crop, clipped to the selection.
  const W = prov.outSize.W;
  const H = prov.outSize.H;
  // Stay clear of the soft edge: the mask feather scales with the crop (same rule as the pipeline).
  const feather = Math.max(2, Math.min(24, Math.round(Math.max(crop.right - crop.left, crop.bottom - crop.top) * 0.004)));
  const inset = Math.max(30, 3 * feather + 10);
  const pts = shape === "ellipse"
    ? [[cx, cy], [cx - 40, cy + 30]]
    : [[sel.left + inset, sel.top + inset], [cx, cy], [sel.right - inset, sel.bottom - inset]];
  for (const [x, y] of pts) near(await probe(doc, x, y), gradAt(x, y, crop, W, H), 12, `result at (${x},${y})`);
  if (shape === "ellipse") {
    // inside the bounding box, outside the ellipse: must be untouched
    const x = sel.left + 15;
    const y = sel.top + 15;
    near(await probe(doc, x, y), x < halfW ? RED : BLUE, 12, `ellipse corner (${x},${y}) untouched`);
  }
  if (sel.left > inset + 20) near(await probe(doc, sel.left - inset, cy), sel.left - inset < halfW ? RED : BLUE, 12, "left of selection untouched");

  const g = await groupInfo(doc, out.placed.groupId);
  expect(g.hasMask, "group has no layer mask");
  expect(g.name === layerName(mode, `selftest ${name}`), `group name is "${g.name}"`);
  expect(g.children.length === n, `group has ${g.children.length} layers, expected ${n}`);
  expect(historyCount(doc) === h0 + 1, `history grew by ${historyCount(doc) - h0}, expected exactly 1`);
  notes.feather = g.feather;

  await undoTo(doc, h0);
  near(await probe(doc, cx, cy), cx < halfW ? RED : BLUE, 12, "undo restores the original");
  } catch (e) {
    e.message = `${e.message} || ${JSON.stringify(notes)}`;
    throw e;
  }
  return { doc, notes };
}


function describeDoc(d) {
  const safe = (f) => {
    try {
      return f();
    } catch (e) {
      return `err: ${e.message}`;
    }
  };
  return {
    id: d.id,
    name: safe(() => d.name),
    mode: safe(() => String(d.mode)),
    bits: safe(() => String(d.bitsPerChannel)),
    activeDocId: safe(() => app.activeDocument && app.activeDocument.id),
    layers: safe(() => Array.from(d.layers).map((l) => l.name)),
    active: safe(() => d.activeLayers.map((l) => ({ name: l.name, kind: String(l.kind), isBackground: safe(() => l.isBackgroundLayer), allLocked: safe(() => l.allLocked) }))),
  };
}

async function diag() {
  const info = {};
  const raw = async (label, descs) => {
    try {
      info[label] = await action.batchPlay(descs, { dialogOptions: "silent" });
    } catch (e) {
      info[label] = `threw: ${e.message}`;
    }
  };
  const small = solidPng(64, 64, [0, 255, 0]);
  const f = await outFolder.createFile("diag-green.png", { overwrite: true });
  await f.write(small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength), { format: formats.binary });
  const token = lfs.createSessionToken(f);
  const place = {
    _obj: "placeEvent",
    null: { _path: token, _kind: "local" },
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    offset: { _obj: "offset", horizontal: px(0), vertical: px(0) },
  };
  const fillRed = { _obj: "fill", using: { _enum: "fillContents", _value: "color" }, color: { _obj: "RGBColor", red: 255, grain: 0, blue: 0 }, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } };

  // A: blank document from documents.add
  await ps.modal("diag A", async () => {
    const DF = constants.DocumentFill || {};
    const d = await app.documents.add({ width: 400, height: 300, resolution: 72, mode: (constants.NewDocumentMode && constants.NewDocumentMode.RGB) || "RGBColorMode", fill: DF.WHITE || "white" });
    made.push(d);
    info.A_state = describeDoc(d);
    await raw("A_fill", [fillRed]);
    await raw("A_place", [place]);
    info.A_after = describeDoc(d);
  });
  // B: an opened PNG file
  const doc = await newDoc({ width: 400, height: 300 });
  await ps.modal("diag B", async () => {
    info.B_state = describeDoc(doc);
    await raw("B_place", [place]);
    info.B_after = describeDoc(doc);
  });
  // C: same, inside a history suspension (how commit runs)
  await ps.modal("diag C", async () => {
    await raw("C_place", [place]);
    info.C_after = describeDoc(doc);
  }, { historyDocId: doc.id });
  // D: plain DOM: new pixel layer, then place on top of it
  await ps.modal("diag D", async () => {
    try {
      await doc.createLayer({ name: "diag layer" });
      info.D_layer = "created";
    } catch (e) {
      info.D_layer = `err: ${e.message}`;
    }
    await raw("D_place", [place]);
    info.D_after = describeDoc(doc);
  });
  return info;
}

const SCENARIOS = {
  diag,

  async probeCheck() {
    // The reads OpenFill depends on (regions at odd offsets, scaled) must hit exact pixels.
    const doc = await newDoc(); // red x<600, blue x>=600
    for (const [x, y, want] of [[100, 100, RED], [599, 400, RED], [600, 400, BLUE], [1199, 799, BLUE], [0, 0, RED]]) {
      near(await probe(doc, x, y), want, 2, `full-resolution read (${x},${y})`);
    }
    const region = async (b, size) => ps.modal("OpenFill self-test: region", () => ps.readComposite(doc.id, b, size));
    const colAt = (r, x) => [r.data[x * r.components], r.data[x * r.components + 1], r.data[x * r.components + 2]];
    const cases = [
      { b: { left: 37, top: 53, right: 937, bottom: 653 }, size: { width: 900, height: 600 } }, // 1:1, odd offset
      { b: { left: 37, top: 53, right: 937, bottom: 653 }, size: { width: 450, height: 300 } }, // half size
      { b: { left: 344, top: 144, right: 856, bottom: 656 }, size: { width: 816, height: 816 } }, // upscaled, like a real fill
      { b: { left: 0, top: 0, right: 1200, bottom: 800 }, size: { width: 2048, height: 1365 } }, // whole document, upscaled
    ];
    const notes = [];
    for (const c of cases) {
      const r = await region(c.b, c.size);
      expect(r.width === c.size.width && r.height === c.size.height, `region read ${r.width}x${r.height}, expected ${c.size.width}x${c.size.height}`);
      const k = c.size.width / (c.b.right - c.b.left);
      const edge = (600 - c.b.left) * k; // where the red/blue split must land in the returned image
      const before = Math.floor(edge - 2 * Math.max(1, k));
      const after = Math.ceil(edge + 2 * Math.max(1, k));
      near(colAt(r, before), RED, 12, `region ${JSON.stringify(c.b)} at ${c.size.width}px: pixel ${before} (just left of the split)`);
      near(colAt(r, after), BLUE, 12, `region ${JSON.stringify(c.b)} at ${c.size.width}px: pixel ${after} (just right of the split)`);
      notes.push({ region: c.b, size: c.size, split: edge.toFixed(1) });
    }
    // Record (not assert) the tiny-read behaviour, for reference.
    const tiny = await region({ left: 600, top: 400, right: 601, bottom: 401 }, { width: 1, height: 1 });
    notes.push({ tinyReadAt600: Array.from(tiny.data.slice(0, 3)), expected: BLUE });
    return notes;
  },

  async fill() {
    return (await fillScenario("fill", {}, { left: 500, top: 300, right: 700, bottom: 500 })).notes;
  },

  async variations() {
    const doc = await newDoc();
      const sel = { left: 450, top: 250, right: 750, bottom: 550 };
    await select(doc, "rect", sel);
    const h0 = historyCount(doc);
    const prov = mockProvider();
    const out = await run(prov, { mode: "fill", prompt: "selftest variations", n: 3 });
    await snapshot(doc, "variations-1");
    const g = await groupInfo(doc, out.placed.groupId);
    expect(g.children.length === 3, `${g.children.length} variation layers`);
    const names = g.children.map((c) => c.name).sort();
    expect(names.join() === "Variation 1,Variation 2,Variation 3", `names: ${names}`);
    expect(g.children.filter((c) => c.visible).length === 1, "more than one variation visible");
    near(await probe(doc, 600, 400), gradAt(600, 400, out.crop, prov.outSize.W, prov.outSize.H), 12, "variation 1 shown first");
    await ps.showVariation(out.placed, 1);
    near(await probe(doc, 600, 400), [0, 255, 0], 12, "variation 2 after switching");
    await ps.showVariation(out.placed, 2);
    near(await probe(doc, 600, 400), [255, 255, 0], 12, "variation 3 after switching");
    near(await probe(doc, 400, 400), RED, 12, "outside selection untouched with variations");
    await snapshot(doc, "variations");
    expect(historyCount(doc) === h0 + 3, `history grew by ${historyCount(doc) - h0}, expected 3 (generate + 2 switches)`);
    return { crop: out.crop };
  },

  async ellipse() {
    return (await fillScenario("ellipse", {}, { left: 300, top: 200, right: 900, bottom: 600 }, { shape: "ellipse" })).notes;
  },

  async remove() {
    return (await fillScenario("remove", {}, { left: 520, top: 320, right: 680, bottom: 480 }, { mode: "remove" })).notes;
  },

  async edge() {
    return (await fillScenario("edge", {}, { left: 0, top: 0, right: 160, bottom: 120 })).notes;
  },

  async selectAll() {
    return (await fillScenario("selectAll", {}, { left: 0, top: 0, right: 1200, bottom: 800 })).notes;
  },

  async bigPhotoDownscale() {
    // 24 MP document, 3000x2000 selection: the crop is far larger than the 2048px upload, so the
    // full strip-read + shrink path runs, and the result is enlarged back on placement.
    const t0 = Date.now();
    const r = await fillScenario("bigPhotoDownscale", { width: 6000, height: 4000 }, { left: 1500, top: 1000, right: 4500, bottom: 3000 });
    expect(r.notes.input.w <= 2048 && r.notes.input.h <= 2048, `upload ${r.notes.input.w}x${r.notes.input.h} exceeds 2048`);
    expect(r.notes.crop.right - r.notes.crop.left > 2048, "crop was not larger than the upload; shrink path not exercised");
    return { ...r.notes, trace: undefined, seconds: (Date.now() - t0) / 1000 };
  },

  async bigDiag() {
    // Where does each gradient pixel actually land? Sample a grid two ways and invert the gradient.
    const doc = await newDoc({ width: 6000, height: 4000 });
    const sel = { left: 1500, top: 1000, right: 4500, bottom: 3000 };
    await select(doc, "rect", sel);
    const prov = mockProvider();
    const trace = [];
    const out = await run(prov, { mode: "fill", prompt: "selftest bigDiag", trace });
    const { W, H } = prov.outSize;
    const crop = out.crop;
    const whole = await readWhole(doc);
    const rows = [];
    for (const y of [1100, 2000, 2900]) {
      for (const x of [1600, 2500, 3500, 4400]) {
        const o = (y * whole.width + x) * 4;
        const a = [whole.data[o], whole.data[o + 1]];
        const small = await ps.modal("diag region", () => ps.readComposite(doc.id, { left: x - 16, top: y - 16, right: x + 16, bottom: y + 16 }, { width: 32, height: 32 }));
        const so = (16 * 32 + 16) * 4;
        const b = [small.data[so], small.data[so + 1]];
        const imply = (v) => ({ x: Math.round(crop.left + ((v[0] / 255) * (W - 1) + 0.5) * ((crop.right - crop.left) / W)), y: Math.round(crop.top + ((v[1] / 255) * (H - 1) + 0.5) * ((crop.bottom - crop.top) / H)) });
        rows.push({ at: [x, y], expect: gradAt(x, y, crop, W, H).slice(0, 2).map(Math.round), whole: a, region: b, impliedWhole: imply(a), impliedRegion: imply(b) });
      }
    }
    return { crop, W, H, trace, rows };
  },

  async panelPickers() {
    // Drive the panel's own pickers the way a change from the UI does, and check they keep working.
    const $ = (id) => document.getElementById(id);
    const tick = () => new Promise((r) => setTimeout(r, 120));
    const labels = (id) => Array.from($(id).querySelectorAll("sp-menu-item")).map((m) => m.textContent);
    const choose = async (id, label) => {
      const items = labels(id);
      const i = items.indexOf(label);
      expect(i >= 0, `"${label}" not in ${id} picker: ${items.join(" | ")}`);
      const el = $(id);
      el.selectedIndex = i;
      el.dispatchEvent(new Event("change"));
      await tick();
    };
    const prefs = () => JSON.parse(localStorage.getItem("openfill.prefs.v1") || "{}");
    const before = prefs().provider || "openai";
    const log = [];
    await choose("provider", "Google Gemini");
    expect(prefs().provider === "gemini", "provider not saved");
    expect(labels("model").includes("Nano Banana 2.1 (best)"), `model list after Gemini: ${labels("model").join(" | ")}`);
    expect($("qualityCell").hidden, "quality should hide for Gemini");
    log.push({ gemini: labels("model") });
    await choose("model", "Nano Banana Pro");
    expect(prefs().models.gemini === "gemini-3-pro-image", "model choice not saved");
    await choose("model", "Custom model ID...");
    expect(!$("customModelRow").hidden, "custom model field not shown");
    await choose("model", "Nano Banana 2.1 (best)");
    expect($("customModelRow").hidden, "custom model field still shown");
    await choose("n", "3");
    await choose("maxTier", "1K (fast)");
    await choose("provider", "OpenAI");
    expect(labels("model").some((l) => /GPT Image/.test(l)), `model list after OpenAI: ${labels("model").join(" | ")}`);
    expect(!$("qualityCell").hidden, "quality should show for OpenAI");
    await choose("quality", "High");
    await choose("model", "GPT Image 2.5 Flare (fast)");
    expect(prefs().models.openai === "gpt-image-2.5-flare", "OpenAI model choice not saved");
    await choose("provider", "Google Gemini");
    await choose("provider", "OpenAI");
    log.push({ openai: labels("model"), n: prefs().n, maxTier: prefs().maxTier, quality: prefs().quality });
    // put the user's choices back
    await choose("model", "GPT Image 2.5 Sunburst (best edits)");
    await choose("quality", "Auto");
    await choose("n", "1");
    await choose("maxTier", "2K");
    await choose("provider", before === "gemini" ? "Google Gemini" : "OpenAI");
    return log;
  },

  async geminiRaw() {
    // Raw requests with the saved Gemini key, no retries, one per image model: records exactly what
    // Google answers. Responses never contain the key; refused requests are not billed.
    const apiKey = await settings.getKey("gemini");
    expect(apiKey, "no Gemini key saved");
    const w = 64, h = 64;
    const b64 = require("./bytes").toBase64(encodePng(new Uint8Array(w * h * 3).fill(128), w, h, 3));
    const models = ["gemini-nano-banana-2.1", "gemini-3.1-flash-lite-image", "gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-2.5-flash-image"];
    const out = {};
    for (const model of models) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Return this image unchanged." }, { inline_data: { mime_type: "image/png", data: b64 } }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } } }),
      });
      const text = await res.text();
      let summary;
      try {
        const j = JSON.parse(text);
        summary = j.error ? `${j.error.status}: ${String(j.error.message).split(String.fromCharCode(10))[0].slice(0, 160)}${/limit: 0/.test(j.error.message) ? " [free tier limit 0]" : ""}` : `OK, ${(j.candidates || []).length} candidate(s), finish ${j.candidates && j.candidates[0] && j.candidates[0].finishReason}`;
      } catch (_) {
        summary = text.slice(0, 200);
      }
      out[model] = { status: res.status, summary };
    }
    return out;
  },

  async openaiRaw() {
    // One raw edit request with the saved OpenAI key, no retries: records exactly what OpenAI answers.
    const apiKey = await settings.getKey("openai");
    expect(apiKey, "no OpenAI key saved");
    const w = 64, h = 64;
    const b64 = require("./bytes").toBase64(encodePng(new Uint8Array(w * h * 3).fill(128), w, h, 3));
    const out = {};
    for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2"]) {
      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt: "Return this image unchanged.", images: [{ image_url: `data:image/png;base64,${b64}` }], n: 1, size: "1024x1024", quality: "low" }),
      });
      const text = await res.text();
      let summary;
      try {
        const j = JSON.parse(text);
        summary = j.error ? { type: j.error.type, code: j.error.code, message: j.error.message } : { ok: true, images: (j.data || []).length };
      } catch (_) {
        summary = text.slice(0, 300);
      }
      out[model] = { status: res.status, summary };
    }
    return out;
  },

  async transparentEmptyArea() {
    // Content only in the middle; fill a selection that sits in empty, transparent space.
    const doc = await newDoc({ transparent: true, opaque: { left: 400, top: 250, right: 800, bottom: 550 } });
    const sel = { left: 40, top: 40, right: 240, bottom: 200 };
    await select(doc, "rect", sel);
    const prov = mockProvider();
    const out = await run(prov, { mode: "fill", prompt: "selftest transparent" });
    await snapshot(doc, "transparentEmptyArea");
    const req = prov.requests[0];
    // the empty area is sent as neutral grey
    near([req.image.rgb[0], req.image.rgb[1], req.image.rgb[2]], [128, 128, 128], 2, "transparent area sent as grey");
    near(await probe(doc, 140, 120), gradAt(140, 120, out.crop, prov.outSize.W, prov.outSize.H), 12, "fill inside transparent area");
    const outside = await probe(doc, 300, 120);
    expect(outside[3] === 0, `outside the selection stays transparent (alpha ${outside[3]})`);
    near(await probe(doc, 500, 400), RED, 12, "content island untouched");
    return { crop: out.crop };
  },

  async highRes300ppi() {
    return (await fillScenario("highRes300ppi", { width: 3000, height: 2000, resolution: 300 }, { left: 1300, top: 800, right: 1700, bottom: 1200 })).notes;
  },

  async bits16() {
    const r = await fillScenario("bits16", { bits16: true }, { left: 500, top: 300, right: 700, bottom: 500 });
    return { ...r.notes, bitsPerChannel: String(r.doc.bitsPerChannel) };
  },

  async geminiSizesOddOutput() {
    // fixed-ratio sizing, and a service that returns a different size than asked
    return (await fillScenario("geminiSizesOddOutput", { width: 1600, height: 900 }, { left: 700, top: 300, right: 1000, bottom: 600 }, { base: gemini, scale: 0.75 })).notes;
  },

  async expandRight() {
    const doc = await newDoc();
      const h0 = historyCount(doc);
    const prov = mockProvider();
    const trace = [];
    const out = await run(prov, { mode: "expand", prompt: "", expand: { percent: 25, sides: { right: true } }, trace });
    await snapshot(doc, "expandRight-raw");
    expect(Math.round(doc.width) === 1500 && Math.round(doc.height) === 800, `canvas is ${doc.width}x${doc.height}, expected 1500x800`);
    const req = prov.requests[0];
    const crop = out.crop;
    const ix = Math.floor(((1450 - crop.left) * req.image.width) / (crop.right - crop.left));
    const iy = Math.floor(((400 - crop.top) * req.image.height) / (crop.bottom - crop.top));
    const o = iy * req.image.width + ix;
    expect(req.mask[o] === 255, "new canvas area not marked in mask");
    near([req.image.rgb[o * 3], req.image.rgb[o * 3 + 1], req.image.rgb[o * 3 + 2]], [128, 128, 128], 2, "new area sent as neutral grey");
    near(await probe(doc, 300, 400), RED, 12, "original left untouched");
    near(await probe(doc, 1100, 400), BLUE, 12, "original right untouched");
    near(await probe(doc, 1400, 400), gradAt(1400, 400, crop, prov.outSize.W, prov.outSize.H), 12, "new area filled");
    expect(historyCount(doc) === h0 + 1, `history grew by ${historyCount(doc) - h0}, expected 1`);
    await snapshot(doc, "expandRight");
    await undoTo(doc, h0);
    expect(Math.round(doc.width) === 1200, `undo left canvas at ${doc.width}`);
    return { crop };
  },

  async expandAllTransparent() {
    const doc = await newDoc({ transparent: true });
      const prov = mockProvider();
    const out = await run(prov, { mode: "expand", prompt: "", expand: { percent: 20, sides: { left: true, right: true, top: true, bottom: true } } });
    expect(Math.round(doc.width) === 1680 && Math.round(doc.height) === 1120, `canvas is ${doc.width}x${doc.height}, expected 1680x1120`);
    // original now sits at (240,160)-(1440,960); its red/blue split is at x=840
    near(await probe(doc, 700, 560), RED, 12, "original left half untouched");
    near(await probe(doc, 1000, 560), BLUE, 12, "original right half untouched");
    for (const [x, y] of [[60, 60], [1620, 1060], [840, 40]]) near(await probe(doc, x, y), gradAt(x, y, out.crop, prov.outSize.W, prov.outSize.H), 12, `new border at (${x},${y})`);
    await snapshot(doc, "expandAllTransparent");
    return { crop: out.crop };
  },

  async rollbackOnBadImage() {
    const doc = await newDoc();
      const sel = { left: 500, top: 300, right: 700, bottom: 500 };
    await select(doc, "rect", sel);
    const h0 = historyCount(doc);
    const layers0 = Array.from(doc.layers).length;
    let failed = false;
    try {
      await run(mockProvider({ garbage: true }), { mode: "fill", prompt: "x" });
    } catch (e) {
      failed = e.message;
    }
    expect(failed, "a broken image did not raise an error");
    expect(historyCount(doc) === h0, `history changed by ${historyCount(doc) - h0} after a failed run`);
    expect(Array.from(doc.layers).length === layers0, "layers left behind after a failed run");
    const b = await ps.getSelectionBounds(doc.id);
    expect(b && Math.round(b.left) === 500 && Math.round(b.right) === 700, `selection changed after a failed run: ${JSON.stringify(b)}`);
    return { error: failed };
  },

  async cancel() {
    const doc = await newDoc();
      await select(doc, "rect", { left: 500, top: 300, right: 700, bottom: 500 });
    const h0 = historyCount(doc);
    const prov = mockProvider();
    let msg = "";
    try {
      await run(prov, { mode: "fill", prompt: "x", cancelled: () => prov.requests.length > 0 });
    } catch (e) {
      msg = e.message;
    }
    expect(/Cancelled/.test(msg), `expected a cancel, got "${msg}"`);
    expect(historyCount(doc) === h0, "cancel changed the document");
    return { message: msg };
  },

  async noSelection() {
    const doc = await newDoc();
    await select(doc, "none");
    let msg = "";
    try {
      await run(mockProvider(), { mode: "fill", prompt: "x" });
    } catch (e) {
      msg = e.message;
    }
    expect(/Make a selection first/.test(msg), `got "${msg}"`);
    return { message: msg };
  },

  async networkOpenAI() {
    // Free: an invalid key is rejected before any image is generated.
    const w = 64, h = 64;
    try {
      await openai.generate({ fetch: (u, i) => fetch(u, i), apiKey: "sk-openfill-selftest-invalid", model: "gpt-image-2", image: { rgb: new Uint8Array(w * h * 3), width: w, height: h }, mask: new Uint8Array(w * h).fill(255), task: "test", n: 1, target: { width: 1024, height: 1024 } });
    } catch (e) {
      expect(e.status === 401 && /rejected the API key/.test(e.message), `unexpected: ${e.status} ${e.message} ${e.detail || ""}`);
      return { status: e.status, message: e.message };
    }
    throw new Error("OpenAI accepted an invalid key?");
  },

  async networkGemini() {
    const w = 64, h = 64;
    const target = gemini.fitSize("gemini-nano-banana-2.1", 1024, 1024, "1K");
    try {
      await gemini.generate({ fetch: (u, i) => fetch(u, i), apiKey: "openfill-selftest-invalid", model: "gemini-nano-banana-2.1", image: { rgb: new Uint8Array(w * h * 3), width: w, height: h }, mask: new Uint8Array(w * h).fill(255), task: "test", n: 1, target });
    } catch (e) {
      expect(/rejected the Gemini API key/.test(e.message), `unexpected: ${e.status} ${e.message} ${e.detail || ""}`);
      return { status: e.status, message: e.message };
    }
    throw new Error("Gemini accepted an invalid key?");
  },
};

/** Opt-in, paid: real Fill, Remove and Expand with the saved key (1K, lowest quality). */
async function live(providerId) {
  const provider = providerId === "gemini" ? gemini : openai;
  const apiKey = await settings.getKey(provider.id);
  expect(apiKey, `no ${provider.name} key saved in the panel`);
  const base = { ps, provider, fetch: (u, i) => fetch(u, i), apiKey, model: provider.defaultModel, n: 1, quality: "low", maxTier: "1K" };
  const report = {};
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      report[name] = { ok: true, seconds: Math.round((Date.now() - t0) / 1000), target: out.target, results: out.results.length, crop: out.crop };
    } catch (e) {
      report[name] = { ok: false, seconds: Math.round((Date.now() - t0) / 1000), error: String((e && e.message) || e), detail: e && e.detail };
    }
  };
  await step("fill", async () => {
    const doc = await newDoc();
    await select(doc, "rect", { left: 450, top: 250, right: 750, bottom: 550 });
    const h0 = historyCount(doc);
    const out = await runGeneration({ ...base, mode: "fill", prompt: "a small green potted plant" });
    expect(historyCount(doc) === h0 + 1, "fill did not add exactly one undo step");
    await snapshot(doc, `live-${provider.id}-fill`);
    return out;
  });
  await step("remove", async () => {
    const doc = await newDoc();
    await select(doc, "rect", { left: 560, top: 300, right: 640, bottom: 500 });
    const out = await runGeneration({ ...base, mode: "remove" });
    await snapshot(doc, `live-${provider.id}-remove`);
    return out;
  });
  await step("expand", async () => {
    const doc = await newDoc();
    const out = await runGeneration({ ...base, mode: "expand", prompt: "", expand: { percent: 25, sides: { left: true, right: true } } });
    expect(Math.round(doc.width) === 1800, `canvas ${doc.width} wide, expected 1800`);
    await snapshot(doc, `live-${provider.id}-expand`);
    return out;
  });
  const failed = Object.entries(report).filter(([, v]) => !v.ok);
  if (failed.length) throw new Error(`${failed.length} live step(s) failed: ${JSON.stringify(report)}`);
  return report;
}

async function runAll(opts = {}) {
  const startedAt = new Date().toISOString();
  const original = app.activeDocument;
  const results = [];
  const names = opts.live ? [] : opts.only && opts.only.length ? opts.only : Object.keys(SCENARIOS);
  const all = opts.live ? [[`live-${opts.live}`, () => live(opts.live)]] : names.map((n) => [n, SCENARIOS[n]]);
  for (const [name, fn] of all) {
    const t0 = Date.now();
    try {
      const notes = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, notes });
      console.log(`[OpenFill self-test] PASS ${name}`);
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e), stack: String((e && e.stack) || "").split("\n").slice(0, 6).join(" | ") });
      console.log(`[OpenFill self-test] FAIL ${name}: ${e && e.message}`);
    }
    // Throwaway documents are closed after each scenario.
    while (made.length) {
      const d = made.pop();
      try {
        await ps.modal("OpenFill self-test: close", async () => d.closeWithoutSaving());
      } catch (_) {
        /* already closed */
      }
    }
  }
  try {
    if (original) await ps.modal("OpenFill self-test: restore", async () => (app.activeDocument = original));
  } catch (_) {
    /* original was closed by the user */
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { version: app.version },
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

async function getOrCreateFolder(parent, name) {
  try {
    return await parent.getEntry(name);
  } catch (_) {
    return parent.createFolder(name);
  }
}

let running = false;

/** Poll the data folder for selftest.json; run once per file. */
function watch() {
  setInterval(async () => {
    if (running) return;
    try {
      const data = await lfs.getDataFolder();
      const entries = await data.getEntries();
      const flag = entries.find((e) => e.name === "selftest.json");
      if (!flag) return;
      running = true;
      let opts = {};
      try {
        opts = JSON.parse((await flag.read()) || "{}");
      } catch (_) {
        opts = {};
      }
      await flag.delete();
      outFolder = await getOrCreateFolder(data, "selftest");
      const status = await outFolder.createFile("status.txt", { overwrite: true });
      await status.write(`running since ${new Date().toISOString()}`);
      const report = await runAll(opts);
      const file = await outFolder.createFile("result.json", { overwrite: true });
      await file.write(JSON.stringify(report, null, 2));
      await status.write(`done ${report.finishedAt}: ${report.passed} passed, ${report.failed} failed`);
    } catch (e) {
      console.log(`[OpenFill self-test] harness error: ${e && e.message}`);
      try {
        const data = await lfs.getDataFolder();
        const f = await data.createFile("selftest-harness-error.txt", { overwrite: true });
        await f.write(String((e && e.stack) || e));
      } catch (_) {
        /* nothing else to do */
      }
    } finally {
      running = false;
    }
  }, 3000);
}

module.exports = { watch, runAll };
