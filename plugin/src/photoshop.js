// Everything that touches Photoshop. The pipeline calls these; nothing else imports "photoshop".
// Needs Photoshop 24.4+ (the Imaging API). Network calls never happen inside a modal scope, so
// Photoshop stays usable while a service is generating.

const { app, core, action, imaging, constants } = require("photoshop");
const uxp = require("uxp");
const { to8bit, placeInto, toRGBA, resample, downsampleStrips } = require("./image");

const lfs = uxp.storage.localFileSystem;
const formats = uxp.storage.formats;

const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const num = (v) => (v && typeof v === "object" && "_value" in v ? v._value : v);
const TARGET = { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };
const SELECTION = { _ref: "channel", _property: "selection" };
const SRGB = "sRGB IEC61966-2.1";

class HostError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostError";
  }
}

/**
 * batchPlay that never shows Photoshop's own dialogs and turns refusals into errors.
 * (batchPlay does not throw when a command fails; it returns an {_obj: "error"} descriptor.)
 */
async function bp(descriptors) {
  const results = await action.batchPlay(descriptors, { dialogOptions: "silent" });
  (results || []).forEach((r, i) => {
    if (r && r._obj === "error") {
      throw new HostError(`Photoshop refused "${descriptors[i]._obj}": ${r.message || `error ${r.result}`}`);
    }
  });
  return results;
}

function ensureSupported() {
  if (!imaging || typeof imaging.getPixels !== "function") {
    throw new HostError("OpenFill needs Photoshop 2023 version 24.4 or newer. Update Photoshop and try again.");
  }
}

function findDoc(id) {
  const d = app.documents && Array.from(app.documents).find((x) => x.id === id);
  if (!d) throw new HostError("The document was closed before the result arrived.");
  return d;
}

/**
 * Run fn in a modal scope. With `historyDocId`, every edit inside becomes one named undo step and
 * is rolled back if fn throws.
 */
async function modal(name, fn, { historyDocId } = {}) {
  // Errors thrown inside executeAsModal lose their message on the way out, so the
  // outcome is carried out as a value and the original error is rethrown here.
  const outcome = await core.executeAsModal(
    async (ec) => {
      const hc = ec.hostControl;
      let suspension = null;
      if (historyDocId && hc && typeof hc.suspendHistory === "function") {
        suspension = await hc.suspendHistory({ documentID: historyDocId, name });
      }
      try {
        const value = await fn();
        if (suspension !== null) await hc.resumeHistory(suspension, true);
        return { ok: true, value };
      } catch (error) {
        if (suspension !== null) {
          try {
            await hc.resumeHistory(suspension, false);
          } catch (_) {
            /* keep the original error */
          }
        }
        return { ok: false, error };
      }
    },
    { commandName: name }
  );
  if (outcome && outcome.ok === false) throw outcome.error;
  return outcome ? outcome.value : undefined;
}

async function getDocument() {
  const d = app.activeDocument;
  if (!d) return null;
  return { id: d.id, width: Math.round(num(d.width)), height: Math.round(num(d.height)), resolution: num(d.resolution) };
}

async function getSelectionBounds(docId) {
  let r;
  try {
    [r] = await bp([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: docId }] }]);
  } catch (_) {
    return null; // no selection can come back as a refusal
  }
  const s = r && r.selection;
  if (!s) return null;
  const b = { left: num(s.left), top: num(s.top), right: num(s.right), bottom: num(s.bottom) };
  return b.right > b.left && b.bottom > b.top ? b : null;
}

// Imaging may trim the read to the area that has pixels and reports bounds relative to a pyramid level.
// Map whatever came back onto exactly `bounds` at exactly `size`.
function normalize(data, imageData, returned, level, bounds, size, comps) {
  const w = imageData.width;
  const h = imageData.height;
  const exact = !returned || (Math.abs(returned.left * 2 ** (level || 0) - bounds.left) < 1 && Math.abs(returned.top * 2 ** (level || 0) - bounds.top) < 1);
  if (exact && w === size.width && h === size.height) return { data, width: w, height: h, components: comps };
  let src = bounds;
  if (returned) {
    const k = 2 ** (level || 0);
    const scaled = { left: returned.left * k, top: returned.top * k, right: returned.right * k, bottom: returned.bottom * k };
    const inside = (r) => r.left >= bounds.left - k && r.top >= bounds.top - k && r.right <= bounds.right + k && r.bottom <= bounds.bottom + k;
    src = inside(scaled) ? scaled : inside(returned) ? returned : bounds;
  }
  const out = placeInto(data, w, h, comps, src, bounds, size.width, size.height);
  return out;
}

async function getPixelsAnyDepth(opts) {
  let lastErr;
  // 8-bit first; 16-bit documents can refuse an 8-bit read on some builds, so fall back.
  for (const componentSize of [8, 16, -1]) {
    try {
      return await imaging.getPixels({ ...opts, componentSize });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Photoshop 27.10 returns misaligned data for single very large reads (seen at 24 MP), so no single
// read covers more than this many pixels; bigger areas are read as strips and assembled.
const MAX_READ_PIXELS = 4000000;

/** Read `b` at full resolution, mapped exactly onto b, in strips. RGBA (composite) or 1-byte mask (selection). */
async function readExact(docId, b, gray) {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  const rows = Math.max(1, Math.floor(MAX_READ_PIXELS / w));
  if (rows >= h) return readOne(docId, b, gray);
  const comps = gray ? 1 : 4;
  const out = new Uint8Array(w * h * comps);
  for (let y = 0; y < h; y += rows) {
    const y1 = Math.min(h, y + rows);
    out.set(await readOne(docId, { left: b.left, right: b.right, top: b.top + y, bottom: b.top + y1 }, gray), y * w * comps);
  }
  return out;
}

/** One imaging call for `b` (callers keep it small). */
async function readOne(docId, b, gray) {
  const w = b.right - b.left;
  const h = b.bottom - b.top;
  let res;
  try {
    res = gray
      ? await imaging.getSelection({ documentID: docId, sourceBounds: b })
      : await getPixelsAnyDepth({ documentID: docId, sourceBounds: b, colorSpace: "RGB", colorProfile: SRGB });
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Photoshop refuses reads of areas with nothing in them (no pixels / nothing selected).
    // Bounds here are always inside the document, so that means "empty", not a bug.
    if (/Invalid Source Bounds/i.test(msg)) return new Uint8Array(w * h * (gray ? 1 : 4));
    throw new HostError(`${msg} (reading ${gray ? "selection" : "pixels"} ${b.left},${b.top} to ${b.right},${b.bottom})`);
  }
  try {
    const data = to8bit(await res.imageData.getData({ chunky: true }));
    const n = normalize(data, res.imageData, res.sourceBounds, res.level, b, { width: w, height: h }, gray ? 1 : res.imageData.components);
    return gray ? n.data : toRGBA(n.data, w, h, n.components);
  } finally {
    res.imageData.dispose();
  }
}

/**
 * Read `bounds` at `size`. Photoshop's own scaled reads come back shifted by a few pixels when
 * shrinking (seen on 27.10), so pixels are always read at full resolution, in strips, and scaled here.
 */
async function readScaled(docId, bounds, size, gray) {
  const b = { left: Math.round(bounds.left), top: Math.round(bounds.top), right: Math.round(bounds.right), bottom: Math.round(bounds.bottom) };
  const W = b.right - b.left;
  const H = b.bottom - b.top;
  const comps = gray ? 1 : 4;
  const dw = Math.min(W, size.width);
  const dh = Math.min(H, size.height);
  let img;
  if (dw === W && dh === H) img = await readExact(docId, b, gray);
  else {
    const strip = (y0, y1) => readExact(docId, { left: b.left, right: b.right, top: b.top + y0, bottom: b.top + y1 }, gray);
    img = await downsampleStrips(strip, W, H, comps, dw, dh);
  }
  if (dw !== size.width || dh !== size.height) img = resample(img, dw, dh, comps, size.width, size.height);
  return { data: img, width: size.width, height: size.height, components: comps };
}

/** Composite pixels of `bounds` (document px) at `size`. 8-bit RGBA. */
async function readComposite(docId, bounds, size) {
  return readScaled(docId, bounds, size, false);
}

/**
 * Selection mask of `bounds`; at `size`, or full resolution when size is null. 1 byte per pixel.
 * Photoshop refuses selection reads that miss the selection, so only the selection's own bounding
 * box is read (once, full resolution); everything else is unselected. Shrinking happens in memory.
 */
async function readSelection(docId, bounds, size) {
  const b = { left: Math.round(bounds.left), top: Math.round(bounds.top), right: Math.round(bounds.right), bottom: Math.round(bounds.bottom) };
  const W = b.right - b.left;
  const H = b.bottom - b.top;
  const full = new Uint8Array(W * H);
  const sel = await getSelectionBounds(docId);
  if (sel) {
    const i = {
      left: Math.max(b.left, Math.floor(sel.left)),
      top: Math.max(b.top, Math.floor(sel.top)),
      right: Math.min(b.right, Math.ceil(sel.right)),
      bottom: Math.min(b.bottom, Math.ceil(sel.bottom)),
    };
    if (i.right > i.left && i.bottom > i.top) {
      const part = await readExact(docId, i, true);
      const iw = i.right - i.left;
      for (let y = 0; y < i.bottom - i.top; y++) {
        full.set(part.subarray(y * iw, (y + 1) * iw), (y + i.top - b.top) * W + (i.left - b.left));
      }
    }
  }
  if (!size || (size.width === W && size.height === H)) return { data: full, width: W, height: H };
  const dw = Math.min(W, size.width);
  const dh = Math.min(H, size.height);
  let img = dw === W && dh === H ? full : await downsampleStrips(async (y0, y1) => full.subarray(y0 * W, y1 * W), W, H, 1, dw, dh);
  if (dw !== size.width || dh !== size.height) img = resample(img, dw, dh, 1, size.width, size.height);
  return { data: img, width: size.width, height: size.height };
}

async function writeTemp(bytes, ext) {
  const folder = await lfs.getTemporaryFolder();
  const name = `openfill-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { format: formats.binary });
  return file;
}

function layerBounds(layer) {
  const b = layer.bounds;
  return { left: num(b.left), top: num(b.top), right: num(b.right), bottom: num(b.bottom) };
}

/** Place one image file as an embedded smart object and fit it exactly onto `crop`. Returns the layer. */
async function placeFitted(doc, file, crop, trace) {
  const t = (step, extra) => trace && trace.push({ step, ...extra });
  const token = lfs.createSessionToken(file);
  await bp([
    {
      _obj: "placeEvent",
      null: { _path: token, _kind: "local" },
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: { _obj: "offset", horizontal: px(0), vertical: px(0) },
    },
  ]);
  const layer = doc.activeLayers[0];
  let b = layerBounds(layer);
  t("placed", { id: layer.id, name: layer.name, kind: String(layer.kind), bounds: b, crop });
  const sx = ((crop.right - crop.left) / (b.right - b.left)) * 100;
  const sy = ((crop.bottom - crop.top) / (b.bottom - b.top)) * 100;
  if (Math.abs(sx - 100) > 0.01 || Math.abs(sy - 100) > 0.01) {
    await layer.scale(sx, sy, constants.AnchorPosition.TOPLEFT);
    b = layerBounds(layer);
    t("scaled", { sx, sy, bounds: b });
  }
  const dx = crop.left - b.left;
  const dy = crop.top - b.top;
  if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
    await layer.translate(dx, dy);
    t("moved", { dx, dy, bounds: layerBounds(layer) });
  }
  return layer;
}

async function selectRect(r) {
  await bp([{ _obj: "set", _target: [SELECTION], to: { _obj: "rectangle", top: px(r.top), left: px(r.left), bottom: px(r.bottom), right: px(r.right) } }]);
}

async function putSelectionPixels(docId, s) {
  const imageData = await imaging.createImageDataFromBuffer(s.data, {
    width: s.width,
    height: s.height,
    components: 1,
    chunky: true,
    colorSpace: "Grayscale",
    colorProfile: "Gray Gamma 2.2",
  });
  try {
    await imaging.putSelection({ documentID: docId, imageData, replace: true, targetBounds: { left: s.left, top: s.top } });
  } finally {
    imageData.dispose();
  }
}

/**
 * Apply a finished generation to the document. Call inside modal(..., { historyDocId }).
 * @param {object} o
 * @param {number} o.docId
 * @param {Array<{bytes, mime}>} o.results
 * @param {{left,top,right,bottom}} o.crop   where the results go (document px, after any expand)
 * @param {string} o.name                    group name
 * @param {number} o.feather                 mask feather in px
 * @param {object} o.selection               {type:"pixels", data,width,height,left,top} or {type:"expand", plan}
 */
async function commit(o) {
  const doc = findDoc(o.docId);
  if (app.activeDocument.id !== doc.id) app.activeDocument = doc;

  if (o.selection.type === "expand") {
    const plan = o.selection.plan;
    await doc.resizeCanvas(plan.newWidth, plan.newHeight, constants.AnchorPosition[plan.anchor]);
    if (Math.round(num(doc.width)) !== plan.newWidth || Math.round(num(doc.height)) !== plan.newHeight) {
      throw new HostError(`Canvas resize gave ${num(doc.width)}x${num(doc.height)}, expected ${plan.newWidth}x${plan.newHeight}.`);
    }
  }

  // Transforms with an active selection only move the selected pixels, so place with nothing selected.
  await bp([{ _obj: "set", _target: [SELECTION], to: { _enum: "ordinal", _value: "none" } }]);

  const files = [];
  try {
    const layers = [];
    for (let i = 0; i < o.results.length; i++) {
      const r = o.results[i];
      const ext = /jpe?g/.test(r.mime) ? "jpg" : /webp/.test(r.mime) ? "webp" : "png";
      const file = await writeTemp(r.bytes, ext);
      files.push(file);
      const layer = await placeFitted(doc, file, o.crop, o.trace);
      layer.name = o.results.length > 1 ? `Variation ${i + 1}` : o.name;
      layers.push(layer);
    }

    await bp([
      { _obj: "select", _target: [{ _ref: "layer", _id: layers[0].id }], makeVisible: false },
      ...layers.slice(1).map((l) => ({
        _obj: "select",
        _target: [{ _ref: "layer", _id: l.id }],
        selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" },
        makeVisible: false,
      })),
      { _obj: "make", _target: [{ _ref: "layerSection" }], from: TARGET, name: o.name },
    ]);
    const group = doc.activeLayers[0];
    group.name = o.name;

    // Recreate the exact selection, then turn it into the group's mask.
    if (o.selection.type === "expand") {
      await selectRect(o.selection.plan.keep);
      await bp([{ _obj: "inverse" }]);
    } else {
      await putSelectionPixels(doc.id, o.selection);
    }
    await bp([{ _obj: "make", new: { _class: "channel" }, at: { _ref: "channel", _enum: "channel", _value: "mask" }, using: { _enum: "userMaskEnabled", _value: "revealSelection" } }]);
    try {
      group.layerMaskFeather = o.feather;
    } catch (_) {
      /* feather is cosmetic; the mask itself is correct */
    }
    for (let i = 1; i < layers.length; i++) layers[i].visible = false;
    if (o.trace) o.trace.push({ step: "done", group: group.id, groupBounds: layerBounds(group), doc: [num(doc.width), num(doc.height)] });
    return { docId: doc.id, groupId: group.id, layerIds: layers.map((l) => l.id) };
  } finally {
    for (const f of files) {
      try {
        await f.delete();
      } catch (_) {
        /* the temp folder is cleared when the plugin unloads */
      }
    }
  }
}

async function showVariation(placed, index) {
  return modal(
    "OpenFill: choose variation",
    () => bp(placed.layerIds.map((id, i) => ({ _obj: i === index ? "show" : "hide", null: [{ _ref: "layer", _id: id }] }))),
    { historyDocId: placed.docId }
  );
}

module.exports = {
  HostError,
  bp,
  ensureSupported,
  modal,
  getDocument,
  getSelectionBounds,
  readComposite,
  readSelection,
  commit,
  showVariation,
};
