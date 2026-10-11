// Pure geometry: which part of the document to send, at what size, and how to expand the canvas.
// Rects are {left, top, right, bottom} in document pixels (right/bottom exclusive).

const width = (r) => r.right - r.left;
const height = (r) => r.bottom - r.top;

function clampRect(r, docW, docH) {
  return {
    left: Math.max(0, Math.floor(r.left)),
    top: Math.max(0, Math.floor(r.top)),
    right: Math.min(docW, Math.ceil(r.right)),
    bottom: Math.min(docH, Math.ceil(r.bottom)),
  };
}

// Grow one axis of a span [a, b) to `len`, centred, shifted to stay inside [0, max).
function growSpan(a, b, len, max) {
  len = Math.min(len, max);
  const c = (a + b) / 2;
  let lo = Math.round(c - len / 2);
  lo = Math.max(0, Math.min(lo, max - len));
  return [lo, lo + len];
}

/**
 * Work out the crop sent to the model.
 * The crop contains the selection plus context, matches the target aspect where the
 * document allows, and never exceeds the document.
 *
 * @param {object} p
 * @param {number} p.docWidth
 * @param {number} p.docHeight
 * @param {{left,top,right,bottom}} p.selection   selection bounds
 * @param {(w: number, h: number) => {width, height}} p.fit  provider's output size for a crop of w x h
 * @param {number} [p.context=0.35]             context margin as a fraction of the selection's longest side
 * @param {number} [p.minSide=512]              smallest crop side worth sending
 * @returns {{crop, target, scaleX, scaleY, softness}}
 */
function computeCrop({ docWidth, docHeight, selection, fit, context = 0.35, minSide = 512 }) {
  const sel = clampRect(selection, docWidth, docHeight);
  if (width(sel) <= 0 || height(sel) <= 0) throw new Error("Selection is outside the document");

  const margin = Math.max(16, Math.round(Math.max(width(sel), height(sel)) * context));
  let crop = clampRect(
    { left: sel.left - margin, top: sel.top - margin, right: sel.right + margin, bottom: sel.bottom + margin },
    docWidth,
    docHeight
  );

  // Small selections still get a decent amount of surrounding image.
  if (width(crop) < minSide) [crop.left, crop.right] = growSpan(crop.left, crop.right, minSide, docWidth);
  if (height(crop) < minSide) [crop.top, crop.bottom] = growSpan(crop.top, crop.bottom, minSide, docHeight);

  const target = fit(width(crop), height(crop));
  const aspect = target.width / target.height;

  // Grow the short axis to match the target aspect (never shrink: the selection must stay inside).
  if (width(crop) / height(crop) < aspect) {
    const want = Math.round(height(crop) * aspect);
    [crop.left, crop.right] = growSpan(crop.left, crop.right, want, docWidth);
  } else {
    const want = Math.round(width(crop) / aspect);
    [crop.top, crop.bottom] = growSpan(crop.top, crop.bottom, want, docHeight);
  }

  const scaleX = target.width / width(crop);
  const scaleY = target.height / height(crop);
  // >1 means the model output gets upscaled on placement (result will look softer).
  const softness = Math.max(width(crop) / target.width, height(crop) / target.height);
  return { crop, target, scaleX, scaleY, softness };
}

/** Size of the image actually uploaded: the target's aspect, no larger than maxSide on the long edge. */
function inputSize(target, maxSide = 2048) {
  const k = Math.min(1, maxSide / Math.max(target.width, target.height));
  return { width: Math.max(1, Math.round(target.width * k)), height: Math.max(1, Math.round(target.height * k)) };
}

const ANCHORS = {
  "-1,-1": "TOPLEFT", "0,-1": "TOPCENTER", "1,-1": "TOPRIGHT",
  "-1,0": "MIDDLELEFT", "0,0": "MIDDLECENTER", "1,0": "MIDDLERIGHT",
  "-1,1": "BOTTOMLEFT", "0,1": "BOTTOMCENTER", "1,1": "BOTTOMRIGHT",
};

/**
 * Plan a generative expand.
 * @param {object} p
 * @param {number} p.docWidth
 * @param {number} p.docHeight
 * @param {number} p.percent              how much to add, as % of the current size on each chosen side
 * @param {{left,right,top,bottom}} p.sides booleans
 * @param {number} [p.overlap=24]          px the fill reaches back into the original image for blending
 * @returns {{newWidth, newHeight, anchor, original, keep}} keep = rect left untouched (inset original)
 */
function planExpand({ docWidth, docHeight, percent, sides, overlap = 24 }) {
  if (!(percent > 0)) throw new Error("Expand amount must be more than 0%");
  if (!sides.left && !sides.right && !sides.top && !sides.bottom) throw new Error("Pick at least one side to expand");
  const addX = Math.round((docWidth * percent) / 100);
  const addY = Math.round((docHeight * percent) / 100);
  const l = sides.left ? addX : 0;
  const r = sides.right ? addX : 0;
  const t = sides.top ? addY : 0;
  const b = sides.bottom ? addY : 0;
  // Anchor: where the old image sits. Expanding only right => anchor left.
  const hx = sides.left && sides.right ? 0 : sides.left ? 1 : sides.right ? -1 : 0;
  const vy = sides.top && sides.bottom ? 0 : sides.top ? 1 : sides.bottom ? -1 : 0;
  const original = { left: l, top: t, right: l + docWidth, bottom: t + docHeight };
  const keep = {
    left: original.left + (l ? overlap : 0),
    top: original.top + (t ? overlap : 0),
    right: original.right - (r ? overlap : 0),
    bottom: original.bottom - (b ? overlap : 0),
  };
  return { newWidth: docWidth + l + r, newHeight: docHeight + t + b, anchor: ANCHORS[`${hx},${vy}`], original, keep };
}

module.exports = { computeCrop, inputSize, planExpand, clampRect, width, height };
