// Google Gemini adapter: generateContent with the image plus a black/white mask image.
// Gemini has no true mask parameter; the mask is a hint and OpenFill clips the result in Photoshop.

const { toBase64, fromBase64 } = require("../bytes");
const { encodePng } = require("../png");
const { binarize } = require("../image");
const { postJson, ProviderError } = require("./http");

const HOST = "generativelanguage.googleapis.com";
const urlFor = (model) => `https://${HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

// Output pixel sizes at 1K; 2K and 4K are exact 2x / 4x.
const RATIOS_1K = {
  "1:1": [1024, 1024],
  "2:3": [848, 1264], "3:2": [1264, 848],
  "3:4": [896, 1200], "4:3": [1200, 896],
  "4:5": [928, 1152], "5:4": [1152, 928],
  "9:16": [768, 1376], "16:9": [1376, 768],
  "21:9": [1584, 672],
  "1:4": [512, 2048], "4:1": [2048, 512],
  "1:8": [384, 3072], "8:1": [3072, 384],
};
const WIDE = ["1:4", "4:1", "1:8", "8:1"];
const R14 = Object.keys(RATIOS_1K);
const R10 = R14.filter((r) => !WIDE.includes(r));

const MODELS = [
  { id: "gemini-nano-banana-2.1", label: "Nano Banana 2.1 (best)", ratios: R14, tiers: ["1K", "2K", "4K"] },
  { id: "gemini-3-pro-image", label: "Nano Banana Pro", ratios: R10, tiers: ["1K", "2K", "4K"] },
  { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite (fast)", ratios: R14, tiers: ["1K"] },
];
const TIER_MULT = { "1K": 1, "2K": 2, "4K": 4 };
const TIER_ORDER = ["1K", "2K", "4K"];

function modelInfo(model) {
  // Unknown (custom) models get the widest common set.
  return MODELS.find((m) => m.id === model) || { id: model, ratios: R10, tiers: ["1K", "2K", "4K"] };
}

/** Closest supported ratio, and the smallest size tier (up to maxTier) that covers the crop. */
function fitSize(model, w, h, maxTier = "2K") {
  const info = modelInfo(model);
  const want = Math.log(w / h);
  let ratio = info.ratios[0];
  let bestErr = Infinity;
  for (const r of info.ratios) {
    const [rw, rh] = RATIOS_1K[r];
    const err = Math.abs(Math.log(rw / rh) - want);
    if (err < bestErr) { bestErr = err; ratio = r; }
  }
  const cap = TIER_ORDER.indexOf(maxTier) >= 0 ? TIER_ORDER.indexOf(maxTier) : 1;
  const allowed = info.tiers.filter((t) => TIER_ORDER.indexOf(t) <= cap);
  const tiers = allowed.length ? allowed : [info.tiers[0]];
  const [bw, bh] = RATIOS_1K[ratio];
  const longest = Math.max(w, h);
  let tier = tiers[tiers.length - 1];
  for (const t of tiers) {
    if (Math.max(bw, bh) * TIER_MULT[t] * 1.25 >= longest) { tier = t; break; }
  }
  return { width: bw * TIER_MULT[tier], height: bh * TIER_MULT[tier], aspectRatio: ratio, imageSize: tier };
}

function promptFor(task) {
  return (
    "You are given two images of the same size. Image 1 is a picture. Image 2 is a mask: white marks the area to change, black marks the area to keep. " +
    task +
    " Change only the white area of image 1. Keep every black area identical, with the same framing, size, perspective and lighting. " +
    "Return the full edited image 1 only: no mask, borders, text or watermarks."
  );
}

function classify(status, json, text) {
  const e = (json && json.error) || {};
  const msg = e.message || (text || "").slice(0, 200) || `HTTP ${status}`;
  const reasons = JSON.stringify(e.details || []);
  if (/API_KEY_INVALID/.test(reasons) || /API key not valid/i.test(msg)) {
    return new ProviderError("Google rejected the Gemini API key. Check it in Settings.", { status, code: "bad_key" });
  }
  if (status === 400 && e.status === "FAILED_PRECONDITION") {
    return new ProviderError("Gemini's free tier isn't available for this account or region. Enable billing in Google AI Studio.", { status, code: e.status });
  }
  if (status === 402) return new ProviderError("Your Gemini prepaid credits are used up.", { status, code: "credits" });
  if (status === 403) return new ProviderError(`Gemini refused the request: ${msg}`, { status, code: e.status });
  if (status === 404) return new ProviderError(`Gemini doesn't know that model. ${msg}`, { status, code: e.status });
  if (status === 429) {
    // Google explains quota refusals in the message and in a RetryInfo detail ("10334s").
    const retry = (e.details || []).find((d) => d && /RetryInfo/.test(d["@type"] || ""));
    const delayS = retry ? parseFloat(String(retry.retryDelay || "0")) : 0;
    if (/limit: 0/.test(msg) && /free_tier|FreeTier/i.test(msg + reasons)) {
      return new ProviderError(
        "Your Gemini key is on Google's free tier, which allows 0 image generations. Turn on billing for the key's project in Google AI Studio (aistudio.google.com > Get API key > Set up billing), then try again.",
        { status, code: "free_tier_no_image_quota", detail: msg }
      );
    }
    if (delayS > 30) {
      const h = Math.floor(delayS / 3600);
      const m = Math.ceil((delayS % 3600) / 60);
      return new ProviderError(`Gemini quota used up. Google says try again in ${h ? `${h}h ` : ""}${m}m.`, { status, code: "quota", detail: msg });
    }
    return new ProviderError("Gemini rate limit reached. Retrying shortly...", { status, code: e.status, retryable: true, retryAfterMs: delayS * 1000, detail: msg });
  }
  if (status >= 500) return new ProviderError("Gemini is having trouble right now. Try again shortly.", { status, code: e.status, retryable: true });
  return new ProviderError(`Gemini: ${msg}`, { status, code: e.status || "" });
}

const BLOCKED = /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/;

function extractImage(json) {
  const cand = (json.candidates || [])[0];
  if (!cand) {
    const reason = json.promptFeedback && json.promptFeedback.blockReason;
    throw new ProviderError(
      reason ? `Gemini's safety filter blocked this prompt (${reason}). Try different wording or selection.` : "Gemini returned nothing. Try again.",
      { code: reason || "empty" }
    );
  }
  const parts = (cand.content && cand.content.parts) || [];
  let found = null;
  for (const p of parts) {
    const d = p.inlineData || p.inline_data;
    if (d && d.data && !p.thought) found = d;
  }
  if (found) return { bytes: fromBase64(found.data), mime: found.mimeType || found.mime_type || "image/png" };
  const fr = cand.finishReason || "";
  if (BLOCKED.test(fr)) {
    throw new ProviderError(`Gemini's safety filter blocked the result (${fr}). Try different wording or selection.`, { code: fr });
  }
  throw new ProviderError("Gemini didn't return an image. Try rephrasing the prompt.", { code: fr || "no_image" });
}

// Which config field the API accepted last time, per model ("responseFormat" or "imageConfig").
const configStyle = {};

function buildBody(text, imgB64, maskB64, size, style) {
  const image = { aspectRatio: size.aspectRatio, imageSize: size.imageSize };
  const generationConfig = { responseModalities: ["IMAGE"] };
  if (style === "imageConfig") generationConfig.imageConfig = image;
  else generationConfig.responseFormat = { image };
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text },
          { inline_data: { mime_type: "image/png", data: imgB64 } },
          { inline_data: { mime_type: "image/png", data: maskB64 } },
        ],
      },
    ],
    generationConfig,
  };
}

async function generateOne(req, text, imgB64, maskB64, size) {
  // imageConfig {aspectRatio: "16:9", imageSize: "2K"} is what the API accepts (verified 2026-10-12);
  // responseFormat.image wants enum values instead, so it is only a fallback.
  const style = configStyle[req.model] || "imageConfig";
  const call = (s) =>
    postJson({
      fetch: req.fetch,
      url: urlFor(req.model),
      headers: { "x-goog-api-key": req.apiKey },
      body: buildBody(text, imgB64, maskB64, size, s),
      classify,
      host: HOST,
    });
  let json;
  try {
    json = await call(style);
    configStyle[req.model] = style;
  } catch (e) {
    // Two documented spellings for size config; fall back to the other on a schema error.
    const schemaError = e instanceof ProviderError && e.status === 400 && /responseFormat|response_format|imageConfig|image_config|Unknown name|Invalid JSON payload/i.test(e.message);
    if (!schemaError) throw e;
    const other = style === "imageConfig" ? "responseFormat" : "imageConfig";
    json = await call(other);
    configStyle[req.model] = other;
  }
  return extractImage(json);
}

/** Same request shape as openai.generate. Variations run as parallel requests. */
async function generate(req) {
  if (!req.apiKey) throw new ProviderError("Add your Gemini API key in Settings first.", { code: "no_key" });
  const { width, height } = req.image;
  const imgB64 = toBase64(encodePng(req.image.rgb, width, height, 3));
  const maskB64 = toBase64(encodePng(binarize(req.mask), width, height, 1));
  const size = req.target.aspectRatio ? req.target : fitSize(req.model, req.target.width, req.target.height, "2K");
  const text = promptFor(req.task);
  const n = Math.max(1, Math.min(4, req.n || 1));
  const settled = await Promise.allSettled(Array.from({ length: n }, () => generateOne(req, text, imgB64, maskB64, size)));
  const ok = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  if (!ok.length) throw settled[0].reason;
  return ok;
}

module.exports = {
  id: "gemini",
  name: "Google Gemini",
  host: HOST,
  keyHelp: "aistudio.google.com/apikey",
  models: MODELS.map(({ id, label }) => ({ id, label })),
  defaultModel: MODELS[0].id,
  qualities: null,
  fitSize,
  generate,
  _classify: classify,
  _extractImage: extractImage,
  _configStyle: configStyle,
};
