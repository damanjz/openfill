const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const openai = require("../plugin/src/providers/openai");
const gemini = require("../plugin/src/providers/gemini");
const { encodePng } = require("../plugin/src/png");
const { toBase64, fromBase64 } = require("../plugin/src/bytes");
const { runGeneration, layerName, UserError } = require("../plugin/src/pipeline");
const { taskFor } = require("../plugin/src/prompts");

const tinyPng = (w = 4, h = 4) => encodePng(new Uint8Array(w * h * 3).fill(90), w, h, 3);

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const { status = 200, json, headers = {} } = await handler(url, init, calls.length);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] },
      text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
    };
  };
  fn.calls = calls;
  return fn;
}

function req(extra = {}) {
  const w = 64, h = 32;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = i % w > 20 && i % w < 40 ? 255 : 0;
  return {
    apiKey: "sk-test",
    image: { rgb: new Uint8Array(w * h * 3).fill(120), width: w, height: h },
    mask,
    task: taskFor("fill", "a red door"),
    n: 2,
    target: { width: 1536, height: 768 },
    ...extra,
  };
}

function pngAlphaAt(pngBytes) {
  // decode our own RGBA PNG and return alpha channel values
  const buf = Buffer.from(pngBytes);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const idat = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    if (buf.toString("ascii", o + 4, o + 8) === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < stride; x++) {
    const left = x >= 4 ? px[y * stride + x - 4] : 0;
    px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + left) & 255;
  }
  return { w, h, alpha: (x, y) => px[(y * w + x) * 4 + 3] };
}

// ---------------- OpenAI ----------------

test("openai fitSize obeys every documented rule across aspects and tiers", () => {
  for (const tier of ["1K", "2K", "4K"]) {
    for (let a = 0.1; a <= 10; a *= 1.07) {
      for (const base of [300, 1500, 7000]) {
        const w = Math.round(base * Math.sqrt(a)), h = Math.round(base / Math.sqrt(a));
        const s = openai._fitSize(w, h, tier);
        const tag = `${w}x${h} ${tier} -> ${s.width}x${s.height}`;
        assert.equal(s.width % 16, 0, tag);
        assert.equal(s.height % 16, 0, tag);
        assert.ok(s.width / s.height <= 3 + 1e-9 && s.height / s.width <= 3 + 1e-9, tag);
        assert.ok(s.width <= 3840 && s.height <= 3840, tag);
        assert.ok(s.width * s.height >= 655360, tag);
        const maxP = { "1K": 1048576, "2K": 3686400, "4K": 8294400 }[tier];
        assert.ok(s.width * s.height <= maxP, tag);
        // aspect stays close for in-range inputs
        if (a >= 1 / 3 && a <= 3) assert.ok(Math.abs(Math.log(s.width / s.height) - Math.log(w / h)) < 0.06, tag);
      }
    }
  }
});

test("openai sends a JSON edit with image, inverted alpha mask, size, n", async () => {
  const fetch = fakeFetch(() => ({ json: { data: [{ b64_json: toBase64(tinyPng()) }, { b64_json: toBase64(tinyPng()) }] } }));
  const out = await openai.generate(req({ fetch, model: "gpt-image-2.5-sunburst", quality: "high" }));
  assert.equal(out.length, 2);
  assert.equal(out[0].mime, "image/png");
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, "https://api.openai.com/v1/images/edits");
  assert.equal(init.headers.Authorization, "Bearer sk-test");
  assert.equal(body.model, "gpt-image-2.5-sunburst");
  assert.equal(body.n, 2);
  assert.equal(body.size, "1536x768");
  assert.equal(body.quality, "high");
  assert.ok(body.prompt.includes("a red door"));
  assert.ok(body.images[0].image_url.startsWith("data:image/png;base64,"));
  const mask = pngAlphaAt(fromBase64(body.mask.image_url.split(",")[1]));
  assert.equal(mask.w, 64);
  assert.equal(mask.h, 32);
  assert.equal(mask.alpha(30, 10), 0, "selected pixel is transparent (edit)");
  assert.equal(mask.alpha(5, 10), 255, "unselected pixel is opaque (keep)");
});

test("openai maps errors to plain messages and retries transient ones", async () => {
  const cases = [
    [401, { error: { message: "Incorrect API key" } }, /rejected the API key/],
    [400, { error: { type: "image_generation_user_error", code: "moderation_blocked" } }, /safety filter/],
    // exact reply captured from OpenAI on 2026-10-12
    [429, { error: { code: "credit_balance_exhausted", type: "insufficient_quota", message: "You have no credits remaining." } }, /no credits left.*billing/],
    [429, { error: { code: "project_spend_limit_exceeded", type: "insufficient_quota" } }, /spend limit.*limits/],
    [403, { error: { message: "Your organization must be verified to use the model" } }, /verified/],
    [400, { error: { message: "Invalid size" } }, /OpenAI: Invalid size/],
  ];
  for (const [status, json, re] of cases) {
    const fetch = fakeFetch(() => ({ status, json }));
    await assert.rejects(openai.generate(req({ fetch, model: "gpt-image-2" })), re);
    assert.equal(fetch.calls.length, 1, `no retry for ${status}`);
  }
  // 503 then success
  const fetch = fakeFetch((u, i, n) => (n === 1 ? { status: 503, json: { error: { message: "busy" } }, headers: { "retry-after": "0.01" } } : { json: { data: [{ b64_json: toBase64(tinyPng()) }] } }));
  const out = await openai.generate(req({ fetch, model: "gpt-image-2" }));
  assert.equal(out.length, 1);
  assert.equal(fetch.calls.length, 2);
  await assert.rejects(openai.generate(req({ fetch, model: "x", apiKey: "" })), /Add your OpenAI API key/);
});

// ---------------- Gemini ----------------

test("gemini fitSize picks the closest ratio and smallest covering tier", () => {
  assert.deepEqual(gemini.fitSize("gemini-nano-banana-2.1", 1000, 1000, "2K"), { width: 1024, height: 1024, aspectRatio: "1:1", imageSize: "1K" });
  assert.deepEqual(gemini.fitSize("gemini-nano-banana-2.1", 3000, 1700, "2K"), { width: 2752, height: 1536, aspectRatio: "16:9", imageSize: "2K" });
  assert.deepEqual(gemini.fitSize("gemini-nano-banana-2.1", 6000, 3400, "4K"), { width: 5504, height: 3072, aspectRatio: "16:9", imageSize: "4K" });
  assert.equal(gemini.fitSize("gemini-nano-banana-2.1", 8000, 1000, "1K").aspectRatio, "8:1");
  assert.equal(gemini.fitSize("gemini-3-pro-image", 8000, 1000, "1K").aspectRatio, "21:9", "pro has no 8:1");
  assert.equal(gemini.fitSize("gemini-3.1-flash-lite-image", 6000, 4000, "4K").imageSize, "1K", "lite is 1K only");
});

const geminiOk = (n) => ({
  json: {
    candidates: [{ content: { parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: toBase64(tinyPng(n, n)) } }] }, finishReason: "STOP" }],
  },
});

test("gemini sends image + mask, runs variations in parallel, reads inlineData", async () => {
  const fetch = fakeFetch(() => geminiOk(4));
  const target = gemini.fitSize("gemini-nano-banana-2.1", 1376, 768, "2K");
  const out = await gemini.generate(req({ fetch, model: "gemini-nano-banana-2.1", target, n: 3 }));
  assert.equal(out.length, 3);
  assert.equal(fetch.calls.length, 3);
  const { url, init, body } = fetch.calls[0];
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent");
  assert.equal(init.headers["x-goog-api-key"], "sk-test");
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.ok(parts[0].text.includes("a red door") && parts[0].text.includes("white marks the area to change"));
  assert.equal(parts[1].inline_data.mime_type, "image/png");
  assert.deepEqual(body.generationConfig.responseModalities, ["IMAGE"]);
  assert.deepEqual(body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "1K" });
});

test("gemini falls back to responseFormat when imageConfig is rejected, and remembers", async () => {
  delete gemini._configStyle["m-fallback"];
  const fetch = fakeFetch((u, init) => {
    const b = JSON.parse(init.body);
    if (b.generationConfig.imageConfig) return { status: 400, json: { error: { code: 400, status: "INVALID_ARGUMENT", message: 'Invalid JSON payload received. Unknown name "imageConfig"' } } };
    return geminiOk(4);
  });
  const target = gemini.fitSize("m-fallback", 1024, 1024, "1K");
  await gemini.generate(req({ fetch, model: "m-fallback", target, n: 1 }));
  assert.equal(fetch.calls.length, 2);
  assert.ok(fetch.calls[1].body.generationConfig.responseFormat);
  await gemini.generate(req({ fetch, model: "m-fallback", target, n: 1 }));
  assert.equal(fetch.calls.length, 3, "second run goes straight to the accepted form");
});

test("gemini surfaces blocks, bad keys and partial variation failures", async () => {
  assert.throws(() => gemini._extractImage({ promptFeedback: { blockReason: "SAFETY" } }), /safety filter blocked this prompt \(SAFETY\)/);
  assert.throws(() => gemini._extractImage({ candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }] }), /blocked the result/);
  assert.throws(() => gemini._extractImage({ candidates: [{ content: { parts: [{ text: "no" }] }, finishReason: "STOP" }] }), /didn't return an image/);
  // thought images are skipped
  const thought = { inlineData: { mimeType: "image/png", data: toBase64(tinyPng(2, 2)) }, thought: true };
  const final = { inlineData: { mimeType: "image/jpeg", data: toBase64(tinyPng(3, 3)) } };
  assert.equal(gemini._extractImage({ candidates: [{ content: { parts: [thought, final] } }] }).mime, "image/jpeg");

  const bad = fakeFetch(() => ({ status: 400, json: { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } } }));
  const target = gemini.fitSize("gemini-nano-banana-2.1", 1024, 1024, "1K");
  await assert.rejects(gemini.generate(req({ fetch: bad, model: "gemini-nano-banana-2.1", target, n: 1 })), /rejected the Gemini API key/);

  const flaky = fakeFetch((u, i, n) => (n === 2 ? { json: { promptFeedback: { blockReason: "OTHER" } } } : geminiOk(4)));
  const out = await gemini.generate(req({ fetch: flaky, model: "gemini-nano-banana-2.1", target, n: 3 }));
  assert.equal(out.length, 2, "one blocked variation is dropped, the rest return");
});

// ---------------- Pipeline ----------------

const { borderBounds } = require("../plugin/src/pipeline");

function fakePs({ doc = { id: 1, width: 4000, height: 3000, resolution: 300 }, selection = { left: 1000, top: 1000, right: 1400, bottom: 1300 } } = {}) {
  const log = [];
  return {
    log,
    async modal(name, fn, opts) { log.push(["modal", name, opts || {}]); return fn(); },
    async getDocument() { return doc; },
    async getSelectionBounds() { return selection; },
    // returns one pixel narrower than asked, to exercise the resample path
    async readComposite(id, bounds, size) { log.push(["read", bounds, size]); return { data: new Uint8Array((size.width - 1) * size.height * 4).fill(200), width: size.width - 1, height: size.height, components: 4 }; },
    async readSelection(id, bounds, size) {
      const w = size ? size.width : bounds.right - bounds.left;
      const h = size ? size.height : bounds.bottom - bounds.top;
      log.push(["readSelection", size ? "scaled" : "full", w, h]);
      const m = new Uint8Array(w * h); m.fill(255, 0, Math.min(m.length, 5000));
      return { data: m, width: w, height: h };
    },
    async commit(o) { log.push(["commit", o]); return { docId: o.docId, groupId: 9, layerIds: o.results.map((_, i) => 10 + i) }; },
  };
}

const fakeProvider = (out = 2) => ({
  name: "Fake",
  fitSize: (m, w, h) => openai._fitSize(w, h, "2K"),
  async generate(r) { this.seen = r; return Array.from({ length: out }, () => ({ bytes: tinyPng(), mime: "image/png" })); },
});

test("pipeline fill: read in one modal, network outside, commit as one undo step", async () => {
  const ps = fakePs();
  const provider = fakeProvider(2);
  const stages = [];
  const r = await runGeneration({ ps, provider, apiKey: "k", model: "m", mode: "fill", prompt: "a cat", n: 2, progress: (s) => stages.push(s) });
  const seen = provider.seen;
  assert.equal(seen.n, 2);
  assert.equal(seen.image.rgb.length, seen.image.width * seen.image.height * 3, "resampled to exact input size, RGB");
  assert.equal(seen.mask.length, seen.image.width * seen.image.height);
  assert.ok(seen.task.includes("a cat"));
  const modals = ps.log.filter((l) => l[0] === "modal");
  assert.equal(modals.length, 2);
  assert.equal(modals[0][2].historyDocId, undefined, "read scope makes no history");
  assert.equal(modals[1][1], "OpenFill: a cat");
  assert.equal(modals[1][2].historyDocId, 1, "commit is one undo step on the right document");
  const commit = ps.log.find((l) => l[0] === "commit")[1];
  assert.equal(commit.results.length, 2);
  assert.equal(commit.selection.type, "pixels");
  assert.equal(commit.selection.width, r.crop.right - r.crop.left, "full-resolution selection kept for the mask");
  assert.equal(commit.selection.left, r.crop.left);
  assert.ok(commit.feather >= 2);
  assert.deepEqual(stages, ["Reading the image", "Generating with Fake", "Placing the result"]);
});

test("pipeline expand reads only the original image and commits a canvas plan", async () => {
  const ps = fakePs();
  const provider = fakeProvider(1);
  await runGeneration({ ps, provider, apiKey: "k", model: "m", mode: "expand", expand: { percent: 20, sides: { right: true } } });
  const read = ps.log.find((l) => l[0] === "read");
  const b = read[1];
  assert.ok(b.left >= 0 && b.top >= 0 && b.right <= 4000 && b.bottom <= 3000, `reads inside the original document: ${JSON.stringify(b)}`);
  assert.ok(!ps.log.some((l) => l[0] === "readSelection"), "expand needs no selection");
  const commit = ps.log.find((l) => l[0] === "commit")[1];
  assert.equal(commit.selection.type, "expand");
  assert.equal(commit.selection.plan.newWidth, 4800);
  assert.ok(commit.crop.right === 4800, "result reaches the new right edge");
  // mask: new area selected, original mostly kept
  const m = provider.seen.mask;
  const w = provider.seen.image.width;
  assert.equal(m[w - 1], 255);
  assert.equal(m[0], 0);
});

test("borderBounds covers exactly the new area", () => {
  assert.deepEqual(borderBounds(1500, 800, { left: 0, top: 0, right: 976, bottom: 800 }), { left: 976, right: 1500, top: 0, bottom: 800 });
  assert.deepEqual(borderBounds(1000, 1200, { left: 0, top: 224, right: 1000, bottom: 1200 }), { left: 0, right: 1000, top: 0, bottom: 224 });
  assert.deepEqual(borderBounds(1500, 1200, { left: 274, top: 224, right: 1226, bottom: 976 }), { left: 0, right: 1500, top: 0, bottom: 1200 });
});

test("pipeline errors are user-friendly and leave the document alone", async () => {
  const provider = fakeProvider(1);
  const none = fakePs({ selection: null });
  await assert.rejects(runGeneration({ ps: none, provider, apiKey: "k", model: "m", mode: "remove" }), (e) => e instanceof UserError && /object to remove/.test(e.message));
  const c = fakePs();
  await assert.rejects(runGeneration({ ps: c, provider, apiKey: "k", model: "m", mode: "fill", cancelled: () => true }), /Cancelled/);
  assert.ok(!c.log.some((l) => l[0] === "commit"), "cancel never touches the document");
  await assert.rejects(runGeneration({ ps: fakePs(), provider, apiKey: "k", model: "m", mode: "expand", expand: { percent: 10, sides: {} } }), (e) => e instanceof UserError && /at least one side/.test(e.message));
  const old = { ...fakePs(), ensureSupported() { throw new Error("needs 24.4"); } };
  await assert.rejects(runGeneration({ ps: old, provider, apiKey: "k", model: "m", mode: "fill" }), (e) => e instanceof UserError && /24.4/.test(e.message));
  const failing = { ...fakeProvider(1), async generate() { throw new Error("network down"); } };
  const f = fakePs();
  await assert.rejects(runGeneration({ ps: f, provider: failing, apiKey: "k", model: "m", mode: "fill" }), /network down/);
  assert.ok(!f.log.some((l) => l[0] === "commit"));
});

test("layer names are short and readable", () => {
  assert.equal(layerName("remove", "x"), "OpenFill: Remove");
  assert.equal(layerName("expand", ""), "OpenFill: Expand");
  assert.equal(layerName("fill", "  a   very long prompt that keeps going and going forever "), "OpenFill: a very long prompt that keeps going and…");
});

test("gemini quota refusals: free tier says so and never retries; long waits are reported; short waits retry", async () => {
  // Body shape captured from Google on 2026-10-12 (free-tier key, image model).
  const freeTier = {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: [
        "You exceeded your current quota, please check your plan and billing details.",
        "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-nano-banana-2.1",
        "Please retry in 2h52m14.9s.",
      ].join("\n"),
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "10334s" },
      ],
    },
  };
  const target = gemini.fitSize("gemini-nano-banana-2.1", 1024, 1024, "1K");
  const f1 = fakeFetch(() => ({ status: 429, json: freeTier }));
  await assert.rejects(gemini.generate(req({ fetch: f1, model: "gemini-nano-banana-2.1", target, n: 1 })), /free tier, which allows 0 image generations.*billing/);
  assert.equal(f1.calls.length, 1, "no retries on a free-tier refusal");

  const paidDaily = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_requests, limit: 250", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "5400s" }] } };
  const f2 = fakeFetch(() => ({ status: 429, json: paidDaily }));
  await assert.rejects(gemini.generate(req({ fetch: f2, model: "gemini-nano-banana-2.1", target, n: 1 })), /try again in 1h 30m/);
  assert.equal(f2.calls.length, 1);

  const brief = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Rate limited", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.01s" }] } };
  const f3 = fakeFetch((u, i, n) => (n === 1 ? { status: 429, json: brief } : geminiOk(4)));
  const out = await gemini.generate(req({ fetch: f3, model: "gemini-nano-banana-2.1", target, n: 1 }));
  assert.equal(out.length, 1);
  assert.equal(f3.calls.length, 2, "short wait retried once, then succeeded");
});
