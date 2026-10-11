// One generation, start to finish, in three phases:
//   1. read   (short modal scope): selection, pixels and masks; the document is not changed
//   2. generate (no modal scope): the network call; Photoshop stays usable
//   3. commit (one modal scope, one undo step): expand canvas if needed, place, group, mask
// Photoshop access goes through `ps` (photoshop.js, or a fake in tests), so this file has no host dependencies.

const { computeCrop, inputSize, planExpand } = require("./geometry");
const { resample, toRGB, dilate, coverage, placeInto, borderMask } = require("./image");
const { taskFor } = require("./prompts");

class UserError extends Error {}

function layerName(mode, prompt) {
  if (mode === "remove") return "OpenFill: Remove";
  const p = (prompt || "").trim().replace(/\s+/g, " ");
  const label = mode === "expand" ? "Expand" : "Fill";
  return p ? `OpenFill: ${p.length > 40 ? p.slice(0, 39) + "…" : p}` : `OpenFill: ${label}`;
}

const asUserError = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw new UserError(e.message);
  }
};

/** Bounding box of (canvas minus keep). */
function borderBounds(w, h, keep) {
  const hasL = keep.left > 0, hasR = keep.right < w, hasT = keep.top > 0, hasB = keep.bottom < h;
  return {
    left: hasL || hasT || hasB ? 0 : keep.right,
    right: hasR || hasT || hasB ? w : keep.left,
    top: hasT || hasL || hasR ? 0 : keep.bottom,
    bottom: hasB || hasL || hasR ? h : keep.top,
  };
}

function intersect(a, b) {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

/** Phase 1 for fill/remove: read inside the current document. */
async function readFill(ps, doc, fit, mode) {
  const selection = await ps.getSelectionBounds(doc.id);
  if (!selection) {
    throw new UserError(mode === "remove" ? "Select the object to remove first." : "Make a selection first (any selection tool).");
  }
  const geo = asUserError(() => computeCrop({ docWidth: doc.width, docHeight: doc.height, selection, fit }));
  const inp = inputSize(geo.target);
  const px = await ps.readComposite(doc.id, geo.crop, inp);
  let rgb = toRGB(px.data, px.width, px.height, px.components);
  if (px.width !== inp.width || px.height !== inp.height) rgb = resample(rgb, px.width, px.height, 3, inp.width, inp.height);
  const small = await ps.readSelection(doc.id, geo.crop, inp);
  let mask = small.data;
  if (small.width !== inp.width || small.height !== inp.height) mask = resample(mask, small.width, small.height, 1, inp.width, inp.height);
  if (coverage(mask) === 0) throw new UserError("The selection is empty.");
  // Full-resolution copy of the selection, so the final layer mask is exact even if the user
  // changes the selection while the service is working.
  const full = await ps.readSelection(doc.id, geo.crop, null);
  return { geo, inp, rgb, mask, restore: { type: "pixels", data: full.data, width: full.width, height: full.height, left: geo.crop.left, top: geo.crop.top } };
}

/** Phase 1 for expand: work on a virtual, larger canvas; the real canvas changes only at commit. */
async function readExpand(ps, doc, fit, expand) {
  const plan = asUserError(() => planExpand({ docWidth: doc.width, docHeight: doc.height, percent: expand.percent, sides: expand.sides }));
  const selection = borderBounds(plan.newWidth, plan.newHeight, plan.keep);
  const geo = asUserError(() => computeCrop({ docWidth: plan.newWidth, docHeight: plan.newHeight, selection, fit }));
  const inp = inputSize(geo.target);
  const inter = intersect(geo.crop, plan.original);
  const cw = geo.crop.right - geo.crop.left;
  const ch = geo.crop.bottom - geo.crop.top;
  let padded;
  if (inter) {
    const src = { left: inter.left - plan.original.left, top: inter.top - plan.original.top, right: inter.right - plan.original.left, bottom: inter.bottom - plan.original.top };
    const size = { width: Math.max(1, Math.round(((inter.right - inter.left) * inp.width) / cw)), height: Math.max(1, Math.round(((inter.bottom - inter.top) * inp.height) / ch)) };
    const px = await ps.readComposite(doc.id, src, size);
    padded = placeInto(px.data, px.width, px.height, px.components, inter, geo.crop, inp.width, inp.height);
  } else {
    padded = { data: new Uint8Array(inp.width * inp.height * 4), width: inp.width, height: inp.height, components: 4 };
  }
  const rgb = toRGB(padded.data, padded.width, padded.height, padded.components);
  const mask = borderMask(geo.crop, plan.keep, inp.width, inp.height);
  return { geo, inp, rgb, mask, restore: { type: "expand", plan } };
}

/**
 * @param {object} o
 * @param {object} o.ps          Photoshop adapter
 * @param {object} o.provider    provider adapter
 * @param {Function} o.fetch
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {"fill"|"remove"|"expand"} o.mode
 * @param {string} [o.prompt]
 * @param {number} [o.n=1]
 * @param {string} [o.quality]
 * @param {string} [o.maxTier="2K"]
 * @param {{percent: number, sides: object}} [o.expand]
 * @param {(label: string) => void} [o.progress]
 * @param {() => boolean} [o.cancelled]
 */
async function runGeneration(o) {
  const { ps, provider, mode } = o;
  const progress = o.progress || (() => {});
  const cancelled = o.cancelled || (() => false);
  const checkCancel = () => {
    if (cancelled()) throw new UserError("Cancelled. Nothing was changed.");
  };

  if (ps.ensureSupported) asUserError(() => ps.ensureSupported());
  const doc = await ps.getDocument();
  if (!doc) throw new UserError("Open a document first.");
  const fit = (w, h) => provider.fitSize(o.model, w, h, o.maxTier || "2K");

  progress("Reading the image");
  const job = await ps.modal("OpenFill: read", () => (mode === "expand" ? readExpand(ps, doc, fit, o.expand) : readFill(ps, doc, fit, mode)));
  checkCancel();

  // A little extra room so the model can blend; the Photoshop layer mask still uses the exact selection.
  const modelMask = dilate(job.mask, job.inp.width, job.inp.height, Math.max(2, Math.round(Math.max(job.inp.width, job.inp.height) * 0.01)));

  progress(`Generating with ${provider.name}`);
  const results = await provider.generate({
    fetch: o.fetch,
    apiKey: o.apiKey,
    model: o.model,
    image: { rgb: job.rgb, width: job.inp.width, height: job.inp.height },
    mask: modelMask,
    task: taskFor(mode, o.prompt),
    n: Math.max(1, Math.min(4, o.n || 1)),
    target: job.geo.target,
    quality: o.quality,
  });
  checkCancel();

  progress("Placing the result");
  const crop = job.geo.crop;
  const feather = Math.max(2, Math.min(24, Math.round(Math.max(crop.right - crop.left, crop.bottom - crop.top) * 0.004)));
  const name = layerName(mode, o.prompt);
  const placed = await ps.modal(name, () => ps.commit({ docId: doc.id, results, crop, name, feather, selection: job.restore, trace: o.trace }), { historyDocId: doc.id });
  return { results, placed, crop, target: job.geo.target, softness: job.geo.softness };
}

module.exports = { runGeneration, layerName, borderBounds, UserError };
