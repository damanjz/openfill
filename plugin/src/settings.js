// API keys in UXP secure storage (encrypted by the OS); everything else in localStorage.

const PREFS_KEY = "openfill.prefs.v1";

const DEFAULTS = {
  mode: "fill",
  provider: "openai",
  models: { openai: "gpt-image-2.5-sunburst", gemini: "gemini-nano-banana-2.1" },
  customModel: { openai: "", gemini: "" },
  n: 1,
  quality: "auto",
  maxTier: "2K",
  expandPercent: 25,
  expandSides: { left: true, right: true, top: false, bottom: false },
};

function secure() {
  try {
    const s = require("uxp").storage.secureStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch (_) {
    return null;
  }
}

function bytesToString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  let s = "";
  for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch (_) {
    return s;
  }
}

async function getKey(providerId) {
  const s = secure();
  try {
    // Missing keys reject on older hosts and resolve null on Photoshop 26.10+.
    if (s) {
      const v = bytesToString(await s.getItem(`openfill.key.${providerId}`)).trim();
      if (v) return v;
    }
  } catch (_) {
    /* fall through */
  }
  return (localStorage.getItem(`openfill.key.${providerId}`) || "").trim();
}

async function setKey(providerId, value) {
  const v = (value || "").trim();
  const s = secure();
  if (s) {
    if (v) await s.setItem(`openfill.key.${providerId}`, v);
    else {
      try {
        await s.removeItem(`openfill.key.${providerId}`);
      } catch (_) {
        /* older hosts reject when the key was never stored */
      }
    }
    return "secure";
  }
  // Older hosts without secure storage: keep it local to this machine's plugin data.
  if (v) localStorage.setItem(`openfill.key.${providerId}`, v);
  else localStorage.removeItem(`openfill.key.${providerId}`);
  return "local";
}

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      ...DEFAULTS,
      ...raw,
      models: { ...DEFAULTS.models, ...(raw.models || {}) },
      customModel: { ...DEFAULTS.customModel, ...(raw.customModel || {}) },
      expandSides: { ...DEFAULTS.expandSides, ...(raw.expandSides || {}) },
    };
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (_) {
    /* non-fatal */
  }
}

module.exports = { getKey, setKey, loadPrefs, savePrefs, DEFAULTS };
