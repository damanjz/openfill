# OpenFill

Photoshop UXP plugin: generative fill, remove, expand and variations via the user's own OpenAI or Gemini key. MIT, open source. Spec: `docs/spec.md`. Vault note: [[OpenFill]].

## Commands
- `npm test`: all unit tests (Node built-in runner, no dependencies).
- `npm run package`: builds `dist/openfill-<version>.ccx` and `openfill-<version>-windows.zip` (self-test left out). Keep `version` equal in `package.json` and `plugin/manifest.json`.
- `node scripts/icons.js`: regenerates panel icons.

## In-Photoshop self-test (dev builds only; release packages leave out `src/selftest.js`)
- Install the dev build: `installer/install.ps1 -Source plugin`. Open the OpenFill panel in Photoshop.
- Write `{}` (or `{"only":["fill"]}`, or `{"live":"openai"}` for one paid real generation) to `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\27\External\io.github.damanjz.openfill\PluginData\selftest.json`.
- Results: `PluginData\selftest\result.json`, `status.txt` and PNG snapshots. Nobody may touch Photoshop while it runs.

## Photoshop 27.10 facts learned the hard way (2026-10-12)
- PS.json path must use backslashes: `$localPlugins\External\<id>`.
- UXP `require` does not resolve a folder to `index.js`.
- batchPlay returns `{_obj:"error"}` instead of throwing; errors thrown inside executeAsModal lose their message.
- Imaging reads: scaled reads (`targetSize` smaller than source) come back shifted; selection reads that miss the selection fail with "Invalid Source Bounds". OpenFill reads full resolution in strips (max 4 MP each) and scales itself.

## Rules
- Zero runtime dependencies. Plugin code is CommonJS and must run in UXP on Photoshop v24 to v27: no `btoa`, `TextEncoder`, `FormData`, canvas or ES modules.
- All Photoshop calls live in `plugin/src/photoshop.js`; `pipeline.js` stays host-free and tested with fakes.
- One file per AI service in `plugin/src/providers/`, same interface as `openai.js`.

## Done means
- `npm test` green, `npm run package` builds, and the in-Photoshop self-test passes (Photoshop 2026 v27.10 is at `D:\Adobe\Adobe Photoshop 2026` since 2026-10-12).

## Ask Daman first
- git commit/push, GitHub repo creation, releases, installing into Photoshop, anything outside this folder.
