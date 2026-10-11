// Panel controller: wires the UI to settings, the pipeline and Photoshop.

const ps = require("./src/photoshop");
const { PROVIDERS, getProvider } = require("./src/providers/index");
const { runGeneration, UserError } = require("./src/pipeline");
const settings = require("./src/settings");
const { toBase64 } = require("./src/bytes");

const $ = (id) => document.getElementById(id);
const CUSTOM = "__custom__";
const TIERS = [
  { id: "1K", label: "1K (fast)" },
  { id: "2K", label: "2K" },
  { id: "4K", label: "4K (slow, costly)" },
];

let prefs = settings.loadPrefs();
let busy = false;
let lastRun = null; // { placed, count, active }

// ---------- pickers ----------
// Photoshop's sp-picker breaks ("locks") if its own menu is rebuilt while it is closing, so a picker's
// items are never changed after creation. Lists that depend on the service are replaced with a fresh
// picker element, after the event that triggered it has finished.

const N_ITEMS = [1, 2, 3, 4].map((n) => ({ id: n, label: String(n) }));

function makePicker(id, items, selected, onChange) {
  const old = $(id);
  const picker = document.createElement("sp-picker");
  picker.id = id;
  picker.setAttribute("size", "s");
  const menu = document.createElement("sp-menu");
  menu.setAttribute("slot", "options");
  items.forEach((it) => {
    const mi = document.createElement("sp-menu-item");
    mi.setAttribute("value", String(it.id));
    mi.textContent = it.label;
    if (it.id === selected) mi.setAttribute("selected", "");
    menu.appendChild(mi);
  });
  picker.appendChild(menu);
  picker.addEventListener("change", () => {
    const i = picker.selectedIndex;
    if (i >= 0 && i < items.length) onChange(items[i].id);
  });
  old.parentNode.replaceChild(picker, old);
  const idx = items.findIndex((it) => it.id === selected);
  if (idx >= 0) picker.selectedIndex = idx;
  return picker;
}

function modelItems(provider) {
  return [...provider.models.map((m) => ({ id: m.id, label: m.label })), { id: CUSTOM, label: "Custom model ID..." }];
}

function currentModel() {
  const id = prefs.models[prefs.provider];
  if (id === CUSTOM) return (prefs.customModel[prefs.provider] || "").trim();
  return id;
}

function buildStaticPickers() {
  makePicker("provider", PROVIDERS.map((p) => ({ id: p.id, label: p.name })), prefs.provider, (id) => {
    if (id === prefs.provider) return;
    prefs.provider = id;
    persist();
    setTimeout(buildServicePickers, 0); // after the service picker has closed
  });
  makePicker("n", N_ITEMS, prefs.n, (n) => {
    prefs.n = n;
    persist();
  });
  makePicker("maxTier", TIERS, prefs.maxTier, (t) => {
    prefs.maxTier = t;
    persist();
  });
}

/** Model and quality lists depend on the service. */
function buildServicePickers() {
  const provider = getProvider(prefs.provider);
  if (!provider.models.some((m) => m.id === prefs.models[provider.id]) && prefs.models[provider.id] !== CUSTOM) {
    prefs.models[provider.id] = provider.defaultModel;
  }
  makePicker("model", modelItems(provider), prefs.models[provider.id], (id) => {
    prefs.models[provider.id] = id;
    persist();
    $("customModelRow").hidden = id !== CUSTOM;
  });
  $("customModelRow").hidden = prefs.models[provider.id] !== CUSTOM;
  $("customModel").value = prefs.customModel[provider.id] || "";
  $("qualityCell").hidden = !provider.qualities;
  if (provider.qualities) {
    if (!provider.qualities.includes(prefs.quality)) prefs.quality = provider.qualities[0];
    makePicker("quality", provider.qualities.map((q) => ({ id: q, label: q[0].toUpperCase() + q.slice(1) })), prefs.quality, (q) => {
      prefs.quality = q;
      persist();
    });
  }
}

// ---------- render ----------

function renderMode() {
  document.querySelectorAll(".mode").forEach((b) => {
    if (b.dataset.mode === prefs.mode) b.setAttribute("selected", "");
    else b.removeAttribute("selected");
  });
  $("promptRow").hidden = prefs.mode === "remove";
  $("removeHint").hidden = prefs.mode !== "remove";
  $("expandRow").hidden = prefs.mode !== "expand";
  $("promptLabel").textContent = prefs.mode === "expand" ? "Prompt (optional)" : "Prompt";
  if (!busy) $("generate").textContent = { fill: "Generate", remove: "Remove", expand: "Expand" }[prefs.mode];
}

function renderExpand() {
  $("expandPercent").value = String(prefs.expandPercent);
  document.querySelectorAll("[data-side]").forEach((c) => {
    c.checked = !!prefs.expandSides[c.dataset.side];
  });
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text || "";
  el.className = kind === "error" ? "status error" : "status";
}

function setBusy(b) {
  busy = b;
  const g = $("generate");
  g.textContent = b ? "Cancel" : { fill: "Generate", remove: "Remove", expand: "Expand" }[prefs.mode];
  g.setAttribute("variant", b ? "secondary" : "cta");
  document.querySelectorAll(".mode").forEach((m) => (b ? m.setAttribute("disabled", "") : m.removeAttribute("disabled")));
}

function persist() {
  settings.savePrefs(prefs);
}

// ---------- results ----------

function dataUrl(r) {
  return `data:${r.mime || "image/png"};base64,${toBase64(r.bytes)}`;
}

function renderThumbs(results) {
  const box = $("thumbs");
  box.innerHTML = "";
  $("results").hidden = results.length < 2;
  results.forEach((r, i) => {
    const div = document.createElement("div");
    div.className = i === lastRun.active ? "thumb active" : "thumb";
    const img = document.createElement("img");
    img.src = dataUrl(r);
    div.appendChild(img);
    div.addEventListener("click", () => chooseVariation(i));
    box.appendChild(div);
  });
}

async function chooseVariation(i) {
  if (!lastRun || busy || i === lastRun.active) return;
  try {
    await ps.showVariation(lastRun.placed, i);
    lastRun.active = i;
    document.querySelectorAll(".thumb").forEach((t, k) => (t.className = k === i ? "thumb active" : "thumb"));
  } catch (e) {
    setStatus(`Couldn't switch variation: ${e.message || e}`, "error");
  }
}

// ---------- generate ----------

let cancelRequested = false;

async function generate() {
  if (busy) {
    // While running, the button is Cancel. The request already sent can't be recalled,
    // but its result is thrown away and the document is left untouched.
    cancelRequested = true;
    setStatus("Cancelling... the document will not be changed.");
    return;
  }
  const provider = getProvider(prefs.provider);
  const model = currentModel();
  if (!model) return setStatus("Enter a model ID first.", "error");
  const apiKey = await settings.getKey(provider.id);
  if (!apiKey) {
    $("settings").hidden = false;
    return setStatus(`Add your ${provider.name} API key below first.`, "error");
  }
  const prompt = $("prompt").value || "";
  if (prompt.length > 4000) return setStatus("Prompt is too long (4,000 characters max).", "error");

  cancelRequested = false;
  setBusy(true);
  const started = Date.now();
  let stage = "Starting";
  const tick = () => {
    if (!cancelRequested) setStatus(`${stage}... ${Math.round((Date.now() - started) / 1000)}s`);
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const out = await runGeneration({
      ps,
      provider,
      fetch: (url, init) => fetch(url, init),
      apiKey,
      model,
      mode: prefs.mode,
      prompt,
      n: prefs.n,
      quality: prefs.quality,
      maxTier: prefs.maxTier,
      expand: { percent: prefs.expandPercent, sides: prefs.expandSides },
      progress: (label) => {
        stage = label;
        tick();
      },
      cancelled: () => cancelRequested,
    });
    lastRun = { placed: out.placed, count: out.results.length, active: 0 };
    renderThumbs(out.results);
    let msg = `Done in ${Math.round((Date.now() - started) / 1000)}s.`;
    if (out.results.length < prefs.n) msg += ` ${prefs.n - out.results.length} variation(s) were blocked or failed.`;
    if (out.softness > 1.6) msg += ` Large area: enlarged ${out.softness.toFixed(1)}x, may look soft. Try a higher resolution or a smaller selection.`;
    setStatus(msg);
  } catch (e) {
    console.error(e);
    const known = e instanceof UserError || e.name === "ProviderError" || e instanceof ps.HostError;
    setStatus(known ? e.message : `Something went wrong: ${e.message || e}`, "error");
  } finally {
    clearInterval(timer);
    setBusy(false);
  }
}

// ---------- events ----------

function bind() {
  document.querySelectorAll(".mode").forEach((b) =>
    b.addEventListener("click", () => {
      if (busy) return;
      prefs.mode = b.dataset.mode;
      persist();
      renderMode();
    })
  );
  $("customModel").addEventListener("input", () => {
    prefs.customModel[prefs.provider] = $("customModel").value;
    persist();
  });
  $("expandPercent").addEventListener("input", () => {
    const v = Number($("expandPercent").value);
    if (v > 0 && v <= 200) {
      prefs.expandPercent = v;
      persist();
    }
  });
  document.querySelectorAll("[data-side]").forEach((c) =>
    c.addEventListener("change", () => {
      prefs.expandSides[c.dataset.side] = !!c.checked;
      persist();
    })
  );
  $("generate").addEventListener("click", generate);
  $("toggleSettings").addEventListener("click", () => {
    $("settings").hidden = !$("settings").hidden;
  });
  $("saveKeys").addEventListener("click", async () => {
    try {
      let where = "secure";
      let saved = 0;
      for (const p of PROVIDERS) {
        const v = $(`key-${p.id}`).value;
        if (v && v.trim()) {
          where = await settings.setKey(p.id, v);
          saved++;
        }
      }
      await showSavedKeys();
      $("keyStatus").textContent = saved ? (where === "secure" ? "Saved to secure storage." : "Saved on this computer.") : "Nothing to save: paste a key first.";
    } catch (e) {
      $("keyStatus").textContent = `Couldn't save: ${e.message || e}`;
    }
  });
}

async function showSavedKeys() {
  for (const p of PROVIDERS) {
    const k = await settings.getKey(p.id);
    // Never put the real key back in the field; show a masked hint instead.
    $(`key-${p.id}`).value = "";
    $(`key-${p.id}`).setAttribute("placeholder", k ? `Saved (...${k.slice(-4)})` : p.id === "openai" ? "sk-..." : "AIza...");
  }
}

buildStaticPickers();
buildServicePickers();
bind();
renderMode();
renderExpand();
showSavedKeys();

// Developer self-test hook. selftest.js is left out of release builds, so this is a no-op for users.
try {
  require("./src/selftest").watch();
} catch (_) {
  /* release build */
}
