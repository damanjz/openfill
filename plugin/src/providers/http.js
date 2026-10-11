// Shared HTTP for providers: JSON POST, retries on transient errors, friendly error messages.

class ProviderError extends Error {
  constructor(message, { status = 0, code = "", retryable = false, detail = "", retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST JSON and parse JSON. `classify(status, body)` turns an error response into a ProviderError.
 * Retries retryable errors up to `retries` times with exponential backoff + jitter.
 */
async function postJson({ fetch, url, headers, body, classify, retries = 2, host }) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = new ProviderError(`Can't reach ${host}. Check your internet connection.`, {
        code: "network",
        retryable: true,
        detail: String((e && e.message) || e),
      });
      if (attempt++ < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw err;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    if (res.ok && json) return json;
    const err = res.ok
      ? new ProviderError(`${host} sent a response OpenFill couldn't read.`, { status: res.status, detail: text.slice(0, 300) })
      : classify(res.status, json, text);
    if (err.retryable && attempt++ < retries) {
      const after = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
      const wait = err.retryAfterMs > 0 ? err.retryAfterMs : after > 0 ? after * 1000 : backoff(attempt);
      await sleep(Math.min(wait, 30000));
      continue;
    }
    throw err;
  }
}

function backoff(attempt) {
  return Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
}

module.exports = { ProviderError, postJson, sleep };
