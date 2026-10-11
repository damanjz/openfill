// OpenAI Images API adapter: POST /v1/images/edits with a JSON body (image + alpha mask as data URLs).

const { toBase64, fromBase64 } = require("../bytes");
const { encodePng } = require("../png");
const { alphaEditMask } = require("../image");
const { postJson, ProviderError } = require("./http");

const HOST = "api.openai.com";
const URL = `https://${HOST}/v1/images/edits`;

const MODELS = [
  { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst (best edits)" },
  { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare (fast)" },
  { id: "gpt-image-2", label: "GPT Image 2" },
];

const QUALITIES = ["auto", "low", "medium", "high"];

// gpt-image-2 and later accept any WxH: multiples of 16, ratio within 1:3..3:1,
// edges <= 3840, 655,360..8,294,400 pixels. Above 2560x1440 is marked experimental.
const MIN_PIXELS = 655360;
const TIER_MAX_PIXELS = { "1K": 1024 * 1024, "2K": 2560 * 1440, "4K": 8294400 };
const MAX_EDGE = 3840;

function fitSize(w, h, tier = "2K") {
  const maxP = TIER_MAX_PIXELS[tier] || TIER_MAX_PIXELS["2K"];
  const r = Math.min(3, Math.max(1 / 3, w / h));
  const want = Math.min(Math.max(w * h, MIN_PIXELS), maxP);
  // Try every legal height; keep the size closest in aspect first, then in pixel count.
  let best = null;
  let bestScore = Infinity;
  for (let H = 16; H <= MAX_EDGE; H += 16) {
    for (const W of [Math.floor((H * r) / 16) * 16, Math.ceil((H * r) / 16) * 16]) {
      if (W < 16 || W > MAX_EDGE || W > 3 * H || H > 3 * W) continue;
      const p = W * H;
      if (p < MIN_PIXELS || p > maxP) continue;
      const score = 4 * Math.abs(Math.log(W / H / r)) + Math.abs(Math.log(p / want));
      if (score < bestScore) {
        bestScore = score;
        best = { width: W, height: H };
      }
    }
  }
  return best;
}

function promptFor(task) {
  return (
    "Edit only the transparent area of the mask on the image. " +
    task +
    " Keep everything outside that area unchanged, with the same framing, perspective and lighting. No borders, text or watermarks."
  );
}

function classify(status, json, text) {
  const e = (json && json.error) || {};
  const msg = e.message || (text || "").slice(0, 200) || `HTTP ${status}`;
  const code = e.code || e.type || "";
  const detail = `${status} ${e.type || ""} ${e.code || ""}: ${msg}`.trim();
  if (status === 401) return new ProviderError("OpenAI rejected the API key. Check it in Settings.", { status, code, detail });
  if (code === "moderation_blocked") {
    return new ProviderError("OpenAI's safety filter blocked this request. Try a different prompt or selection.", { status, code, detail });
  }
  if (status === 403) {
    if (/verif/i.test(msg)) {
      return new ProviderError("Your OpenAI organization must be verified to use image models (OpenAI dashboard > Settings > Organization > Verify).", { status, code, detail });
    }
    return new ProviderError(`OpenAI refused the request: ${msg}`, { status, code, detail });
  }
  if (status === 429) {
    const billing = /credit_balance_exhausted|spend_limit|usage_limit|insufficient_quota/.test(`${e.code} ${e.type}`);
    if (/credit_balance_exhausted|insufficient_quota/.test(`${e.code} ${e.type}`) && !/spend_limit|usage_limit/.test(`${e.code}`)) {
      return new ProviderError("Your OpenAI account has no credits left. Add credits at platform.openai.com/settings/organization/billing, then try again.", { status, code, detail });
    }
    if (billing) return new ProviderError("Your OpenAI account has hit its spend limit. Raise it at platform.openai.com/settings/organization/limits, then try again.", { status, code, detail });
    return new ProviderError("OpenAI rate limit reached. Wait a minute and try again.", { status, code, retryable: true, detail });
  }
  if (status >= 500) return new ProviderError("OpenAI is having trouble right now. Try again shortly.", { status, code, retryable: true, detail });
  if (status === 404) return new ProviderError(`OpenAI doesn't know that model. ${msg}`, { status, code, detail });
  return new ProviderError(`OpenAI: ${msg}`, { status, code, detail });
}

/**
 * @param {object} req
 * @param {string} req.apiKey
 * @param {string} req.model
 * @param {{rgb: Uint8Array, width: number, height: number}} req.image  model input (RGB)
 * @param {Uint8Array} req.mask  width*height, >0 = area to change
 * @param {string} req.task      mode task text from prompts.js
 * @param {number} req.n         variations (1-4)
 * @param {{width: number, height: number}} req.target  output size
 * @param {string} [req.quality]
 * @param {Function} req.fetch
 * @returns {Promise<Array<{bytes: Uint8Array, mime: string}>>}
 */
async function generate(req) {
  if (!req.apiKey) throw new ProviderError("Add your OpenAI API key in Settings first.", { code: "no_key" });
  const { width, height } = req.image;
  const imagePng = encodePng(req.image.rgb, width, height, 3);
  const maskPng = encodePng(alphaEditMask(req.mask), width, height, 4);
  const body = {
    model: req.model,
    prompt: promptFor(req.task),
    images: [{ image_url: `data:image/png;base64,${toBase64(imagePng)}` }],
    mask: { image_url: `data:image/png;base64,${toBase64(maskPng)}` },
    n: req.n,
    size: `${req.target.width}x${req.target.height}`,
    quality: QUALITIES.includes(req.quality) ? req.quality : "auto",
    output_format: "png",
  };
  const json = await postJson({
    fetch: req.fetch,
    url: URL,
    headers: { Authorization: `Bearer ${req.apiKey}` },
    body,
    classify,
    host: HOST,
  });
  const items = (json.data || []).filter((d) => d && d.b64_json);
  if (!items.length) throw new ProviderError("OpenAI returned no image. Try again or change the prompt.", { code: "no_image" });
  return items.map((d) => ({ bytes: fromBase64(d.b64_json), mime: "image/png" }));
}

module.exports = {
  id: "openai",
  name: "OpenAI",
  host: HOST,
  keyHelp: "platform.openai.com/api-keys",
  models: MODELS,
  defaultModel: MODELS[0].id,
  qualities: QUALITIES,
  fitSize: (model, w, h, tier) => fitSize(w, h, tier),
  generate,
  // exposed for tests
  _fitSize: fitSize,
  _classify: classify,
};
