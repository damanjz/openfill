// Runs plugin/src/photoshop.js against a scripted fake of the "photoshop" and "uxp" modules.
// This checks our control flow (order of calls, cleanup, rollback, data mapping), not Photoshop itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

function loadWithFakes({ imagingMissing = false, fail8bit = false, trim = null, refuse = null } = {}) {
  const calls = [];
  const state = { selection: { left: 10, top: 20, right: 110, bottom: 220 }, nextId: 100, layers: {}, active: null, deleted: [], history: [], putSelection: null };

  function makeLayer(w, h, kind = "layer") {
    const id = state.nextId++;
    const L = {
      id, kind, name: "", visible: true, layerMaskFeather: 0,
      b: { left: 0, top: 0, right: w, bottom: h },
      async scale(px, py, anchor) {
        calls.push(["scale", id, anchor]);
        const nw = (L.b.right - L.b.left) * px / 100, nh = (L.b.bottom - L.b.top) * py / 100;
        L.b = { left: L.b.left, top: L.b.top, right: L.b.left + nw, bottom: L.b.top + nh };
      },
      async translate(dx, dy) {
        L.b = { left: L.b.left + dx, top: L.b.top + dy, right: L.b.right + dx, bottom: L.b.bottom + dy };
      },
    };
    Object.defineProperty(L, "bounds", { get: () => L.b });
    state.layers[id] = L;
    state.active = L;
    return L;
  }

  const doc = {
    id: 7, width: 2000, height: 1000, resolution: 300,
    get activeLayers() { return [state.active]; },
    async resizeCanvas(w, h, anchor) { calls.push(["resizeCanvas", w, h, anchor]); doc.width = w; doc.height = h; },
  };
  const app = { documents: [doc], activeDocument: doc };

  const photoshop = {
    app,
    constants: { AnchorPosition: { MIDDLECENTER: "mc", MIDDLELEFT: "ml", TOPLEFT: "tl" } },
    core: {
      async executeAsModal(fn, opts) {
        calls.push(["modal", opts.commandName]);
        return fn({
          isCancelled: false,
          reportProgress: () => {},
          hostControl: {
            async suspendHistory(o) { state.history.push(["suspend", o.documentID, o.name]); return 42; },
            async resumeHistory(id, commit) { state.history.push(["resume", id, commit]); },
          },
        });
      },
    },
    imaging: imagingMissing ? undefined : {
      async getPixels(o) {
        calls.push(["getPixels", o.componentSize, o.sourceBounds, o.targetSize]);
        if (fail8bit && o.componentSize === 8) throw new Error("Photoshop error code -1");
        const sixteen = o.componentSize === 16;
        calls.push(["getPixelsSize", o.targetSize || null]);
        let width = o.sourceBounds.right - o.sourceBounds.left;
        let height = o.sourceBounds.bottom - o.sourceBounds.top;
        let sourceBounds = o.sourceBounds;
        if (trim) { width = trim.w; height = trim.h; sourceBounds = trim.bounds; }
        const n = width * height * 3;
        const data = sixteen ? new Uint16Array(n).fill(32768) : new Uint8Array(n).fill(77);
        return { sourceBounds, level: trim ? trim.level : 0, imageData: { width, height, components: 3, getData: async () => data, dispose: () => calls.push(["dispose"]) } };
      },
      async getSelection(o) {
        const width = o.targetSize ? o.targetSize.width : o.sourceBounds.right - o.sourceBounds.left;
        const height = o.targetSize ? o.targetSize.height : o.sourceBounds.bottom - o.sourceBounds.top;
        return { sourceBounds: o.sourceBounds, imageData: { width, height, components: 1, getData: async () => new Uint8Array(width * height).fill(255), dispose: () => {} } };
      },
      async createImageDataFromBuffer(buf, o) {
        calls.push(["createImageData", buf.length, o]);
        return { ...o, dispose: () => calls.push(["disposeSel"]) };
      },
      async putSelection(o) { state.putSelection = o; calls.push(["putSelection", o.targetBounds]); },
    },
    action: {
      async batchPlay(descs, opts) {
        const out = [];
        for (const d of descs) {
          calls.push(["bp", d._obj, d, opts]);
          if (refuse && d._obj === refuse) {
            // what Photoshop returns (it does not throw) when a command is unavailable
            out.push({ _obj: "error", result: -25920, message: `The command “${d._obj}” is not currently available.` });
            continue;
          }
          if (d._obj === "get") out.push({ selection: state.selection && { left: { _unit: "pixelsUnit", _value: state.selection.left }, top: state.selection.top, right: state.selection.right, bottom: state.selection.bottom } });
          else if (d._obj === "placeEvent") { makeLayer(1536, 1024); out.push({}); }
          else if (d._obj === "make" && d._target && d._target[0]._ref === "layerSection") { makeLayer(0, 0, "group"); out.push({}); }
          else out.push({});
        }
        return out;
      },
    },
  };

  const uxp = {
    storage: {
      formats: { binary: "binary" },
      localFileSystem: {
        async getTemporaryFolder() {
          return {
            async createFile(name) {
              return {
                name,
                async write(buf, o) { calls.push(["write", name, buf.byteLength, o.format]); },
                async delete() { state.deleted.push(name); },
              };
            },
          };
        },
        createSessionToken: (f) => `token:${f.name}`,
      },
    },
  };

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "photoshop") return photoshop;
    if (request === "uxp") return uxp;
    return origLoad.apply(this, arguments);
  };
  const file = path.join(__dirname, "..", "plugin", "src", "photoshop.js");
  delete require.cache[file];
  try {
    return { ps: require(file), calls, state, doc, app };
  } finally {
    Module._load = origLoad;
  }
}

const png = (n) => ({ bytes: new Uint8Array(n), mime: "image/png" });
const bpOps = (calls) => calls.filter((c) => c[0] === "bp").map((c) => c[1]);

test("ensureSupported refuses hosts without the Imaging API", () => {
  assert.throws(() => loadWithFakes({ imagingMissing: true }).ps.ensureSupported(), /24\.4/);
  assert.doesNotThrow(() => loadWithFakes().ps.ensureSupported());
});

test("getSelectionBounds unwraps unit values; null when nothing selected", async () => {
  const { ps, state } = loadWithFakes();
  assert.deepEqual(await ps.getSelectionBounds(7), { left: 10, top: 20, right: 110, bottom: 220 });
  state.selection = null;
  assert.equal(await ps.getSelectionBounds(7), null);
});

test("commit (fill): deselect, place and fit each result, group, restore exact selection, mask", async () => {
  const { ps, calls, state } = loadWithFakes();
  const crop = { left: 100, top: 50, right: 868, bottom: 562 };
  const sel = { type: "pixels", data: new Uint8Array(768 * 512).fill(255), width: 768, height: 512, left: 100, top: 50 };
  const placed = await ps.commit({ docId: 7, results: [png(10), png(20), png(30)], crop, name: "OpenFill: test", feather: 4, selection: sel });
  const ops = bpOps(calls);
  assert.equal(ops[0], "set", "deselect first");
  assert.equal(calls.find((c) => c[1] === "set")[2].to._value, "none");
  assert.equal(ops.filter((o) => o === "placeEvent").length, 3);
  for (const id of placed.layerIds) assert.deepEqual(state.layers[id].b, crop, "each layer fitted exactly to the crop");
  assert.ok(calls.filter((c) => c[0] === "scale").every((c) => c[2] === "tl"), "scaled from the top-left");
  const group = state.layers[placed.groupId];
  assert.equal(group.kind, "group");
  assert.equal(group.name, "OpenFill: test");
  assert.equal(group.layerMaskFeather, 4);
  assert.deepEqual(state.putSelection.targetBounds, { left: 100, top: 50 });
  const created = calls.find((c) => c[0] === "createImageData");
  assert.equal(created[1], 768 * 512);
  assert.equal(created[2].colorSpace, "Grayscale");
  // selection restored before the mask is made
  const putIdx = calls.findIndex((c) => c[0] === "putSelection");
  const maskIdx = calls.findIndex((c) => c[1] === "make" && c[2].using);
  assert.ok(putIdx >= 0 && maskIdx > putIdx);
  assert.deepEqual(placed.layerIds.map((id) => state.layers[id].name), ["Variation 1", "Variation 2", "Variation 3"]);
  assert.deepEqual(placed.layerIds.map((id) => state.layers[id].visible), [true, false, false]);
  assert.equal(state.deleted.length, 3, "temp files removed");
  assert.equal(placed.docId, 7);
});

test("commit (expand): resizes canvas, then selects the border for the mask", async () => {
  const { ps, calls, doc } = loadWithFakes();
  const plan = { newWidth: 3000, newHeight: 1000, anchor: "MIDDLECENTER", keep: { left: 524, top: 0, right: 2476, bottom: 1000 } };
  await ps.commit({ docId: 7, results: [png(10)], crop: { left: 0, top: 0, right: 3000, bottom: 1000 }, name: "OpenFill: Expand", feather: 8, selection: { type: "expand", plan } });
  assert.deepEqual(calls.find((c) => c[0] === "resizeCanvas"), ["resizeCanvas", 3000, 1000, "mc"]);
  assert.equal(doc.width, 3000);
  const ops = bpOps(calls);
  const rect = calls.filter((c) => c[1] === "set" && c[2].to && c[2].to._obj === "rectangle")[0][2].to;
  assert.equal(rect.left._value, 524);
  assert.equal(rect.right._value, 2476);
  assert.ok(ops.indexOf("inverse") > ops.lastIndexOf("placeEvent"), "border selected after placing");
  assert.ok(!calls.some((c) => c[0] === "putSelection"));
});

test("commit refuses a closed document and cleans temp files on failure", async () => {
  const { ps, app, state } = loadWithFakes();
  app.documents = [];
  await assert.rejects(ps.commit({ docId: 7, results: [png(1)], crop: { left: 0, top: 0, right: 1, bottom: 1 }, name: "x", feather: 2, selection: { type: "pixels" } }), /closed/);
  const f = loadWithFakes();
  const bad = { bytes: { buffer: null }, mime: "image/png" };
  await assert.rejects(f.ps.commit({ docId: 7, results: [png(5), bad], crop: { left: 0, top: 0, right: 10, bottom: 10 }, name: "x", feather: 2, selection: { type: "pixels" } }));
  assert.equal(f.state.deleted.length, 1);
});

test("modal commits history on success, rolls back on failure, skips history for reads", async () => {
  const { ps, state } = loadWithFakes();
  assert.equal(await ps.modal("OpenFill fill", async () => 5, { historyDocId: 7 }), 5);
  assert.deepEqual(state.history.slice(0, 2), [["suspend", 7, "OpenFill fill"], ["resume", 42, true]]);
  await assert.rejects(ps.modal("OpenFill fill", async () => { throw new Error("boom"); }, { historyDocId: 7 }), /boom/);
  assert.deepEqual(state.history.at(-1), ["resume", 42, false]);
  const before = state.history.length;
  await ps.modal("OpenFill: read", async () => 1);
  assert.equal(state.history.length, before, "reads make no history step");
});

test("readComposite falls back to 16-bit, converts to 8-bit, never asks Photoshop to scale", async () => {
  const { ps, calls } = loadWithFakes({ fail8bit: true });
  const r = await ps.readComposite(7, { left: 0, top: 0, right: 100, bottom: 50 }, { width: 64, height: 32 });
  assert.deepEqual(calls.filter((c) => c[0] === "getPixels").map((c) => c[1]).slice(0, 2), [8, 16]);
  assert.ok(calls.filter((c) => c[0] === "getPixelsSize").every((c) => c[1] === null), "no targetSize passed to Photoshop");
  assert.ok(r.data instanceof Uint8Array);
  assert.equal(r.width, 64);
  assert.equal(r.components, 4);
  assert.equal(r.data[0], 255, "Photoshop 16-bit white (32768) becomes 255");
  assert.ok(calls.some((c) => c[0] === "dispose"));
});

test("readComposite maps a trimmed read back onto the requested area", async () => {
  // asked for 0..100 x 0..50 at 100x50; Photoshop returned only the right half (pixels exist only there)
  const { ps } = loadWithFakes({ trim: { w: 50, h: 50, bounds: { left: 50, top: 0, right: 100, bottom: 50 }, level: 0 } });
  const r = await ps.readComposite(7, { left: 0, top: 0, right: 100, bottom: 50 }, { width: 100, height: 50 });
  assert.equal(r.width, 100);
  assert.equal(r.components, 4);
  assert.equal(r.data.length, 100 * 50 * 4);
  assert.equal(r.data[3], 0, "left half transparent");
  assert.equal(r.data[(10 * 100 + 75) * 4], 77, "right half has the pixels");
  assert.equal(r.data[(10 * 100 + 75) * 4 + 3], 255);
});

test("readSelection full resolution when no size given", async () => {
  const { ps } = loadWithFakes();
  const r = await ps.readSelection(7, { left: 10, top: 10, right: 40, bottom: 30 }, null);
  assert.equal(r.width, 30);
  assert.equal(r.height, 20);
  assert.equal(r.data.length, 600);
});

test("showVariation shows one layer and hides the rest as one undo step", async () => {
  const { ps, calls, state } = loadWithFakes();
  await ps.showVariation({ docId: 7, layerIds: [1, 2, 3] }, 1);
  const vis = calls.filter((c) => c[1] === "show" || c[1] === "hide").map((c) => [c[1], c[2].null[0]._id]);
  assert.deepEqual(vis, [["hide", 1], ["show", 2], ["hide", 3]]);
  assert.deepEqual(state.history.at(-1), ["resume", 42, true]);
});

test("refused commands become errors, never Photoshop dialogs", async () => {
  const { ps, calls, state } = loadWithFakes({ refuse: "placeEvent" });
  const sel = { type: "pixels", data: new Uint8Array(4), width: 2, height: 2, left: 0, top: 0 };
  await assert.rejects(
    ps.commit({ docId: 7, results: [png(10)], crop: { left: 0, top: 0, right: 2, bottom: 2 }, name: "x", feather: 2, selection: sel }),
    (e) => e.name === "HostError" && /Photoshop refused "placeEvent": The command/.test(e.message)
  );
  assert.equal(state.deleted.length, 1, "temp file still removed");
  assert.ok(calls.filter((c) => c[0] === "bp").every((c) => c[3] && c[3].dialogOptions === "silent"), "every batchPlay call is silent");
  const g = loadWithFakes({ refuse: "get" });
  assert.equal(await g.ps.getSelectionBounds(7), null, "a refused selection read means no selection");
});

test("large reads are split so no single Photoshop read exceeds 4 MP", async () => {
  const { ps, calls } = loadWithFakes();
  const r = await ps.readComposite(7, { left: 0, top: 0, right: 3000, bottom: 2000 }, { width: 3000, height: 2000 });
  assert.equal(r.data.length, 3000 * 2000 * 4);
  const reads = calls.filter((c) => c[0] === "getPixels");
  assert.ok(reads.length >= 2, `${reads.length} reads`);
  for (const c of reads) {
    const b = c[2];
    assert.ok((b.right - b.left) * (b.bottom - b.top) <= 4000000, `read of ${JSON.stringify(b)} too big`);
  }
  // strips tile the area exactly: contiguous rows, full width
  let next = 0;
  for (const c of reads) { assert.equal(c[2].top, next); assert.equal(c[2].left, 0); assert.equal(c[2].right, 3000); next = c[2].bottom; }
  assert.equal(next, 2000);
});
