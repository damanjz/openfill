# OpenFill: spec

Date: 2026-10-12. Status: v0.1.0 beta. Verified in Photoshop 27.10 by the in-Photoshop self-test (23 scenarios); a paid end-to-end generation is still pending.

## Goal
Free, open-source (MIT) Photoshop plugin: Generative Fill, Remove, Expand and Variations using the user's own OpenAI or Google Gemini API key. No server, no Creative Cloud app required.

## Decisions (Daman, 2026-10-12)
| Topic | Decision |
|---|---|
| Audience | Public, open source, MIT |
| Models | OpenAI GPT Image and Google Gemini (Nano Banana) only |
| v1 features | Fill, Remove, Expand, Variations (1-4) |
| Billing | Bring your own key; no backend |
| Photoshop | 2023 to 2026 (v24.4 to v27.x), one build. 24.4 is the first release with the Imaging API |
| Install | .ccx for Creative Cloud users; `-windows.zip` with Install OpenFill.bat (per-user `%APPDATA%\Adobe\UXP`, PS.json merged and backed up) for installs without the Creative Cloud app |
| Store | GitHub releases |

## How a generation works
Three phases, so Photoshop is never locked during the network call:
1. **Read** (short modal scope, no document change): selection bounds; crop = selection + 35% context, at least 512px a side, grown to the model's output aspect, clamped to the document; composite pixels and selection at upload size (long edge max 2048), read at full resolution in strips of at most 4 MP and shrunk in JS (Photoshop's own scaled reads come back shifted); a full-resolution copy of the selection. Expand works on a virtual larger canvas: the original is read and padded, the mask is the new border plus a 24px overlap.
2. **Generate** (no modal scope): image + mask (grown about 1% so the model can blend) to the provider. Cancel discards the result.
3. **Commit** (one modal scope, one undo step, rolled back on error): expand canvas if needed, deselect, place each result as a smart object fitted to the crop, group, restore the exact selection (Imaging `putSelection`, or keep-rect + inverse for expand), make it the group's mask, feather, show the first variation.

## Providers
| | OpenAI | Gemini |
|---|---|---|
| Endpoint | `POST /v1/images/edits` (JSON body) | `POST /v1beta/models/{model}:generateContent` |
| Default model | `gpt-image-2.5-sunburst` | `gemini-nano-banana-2.1` |
| Mask | PNG alpha mask, transparent = edit | Second image, white = edit (a hint only) |
| Output size | Any WxH, multiples of 16, ratio 1:3-3:1, capped by the Resolution setting | 14 fixed ratios x 1K/2K/4K via `imageConfig` |
| Variations | `n` in one call | Parallel calls |
| Custom model ID | Yes | Yes |

Neither service follows the mask pixel-exactly, so the Photoshop layer mask does the final clipping.

## Code map
| File | Job |
|---|---|
| `plugin/manifest.json` | UXP manifest v5, host PS min 24.4.0, network domains |
| `plugin/main.js` | Panel UI and wiring |
| `plugin/src/pipeline.js` | One generation end to end (host-independent) |
| `plugin/src/photoshop.js` | All Photoshop calls (imaging API, batchPlay, DOM) |
| `plugin/src/providers/*.js` | One file per AI service, same interface |
| `plugin/src/geometry.js` | Crop and expand maths |
| `plugin/src/png.js`, `image.js`, `bytes.js` | PNG encoder, resize/mask helpers, base64 |
| `plugin/src/settings.js` | Keys in UXP secure storage, prefs in localStorage |
| `plugin/src/selftest.js` | In-Photoshop self-test (dev only, left out of releases) |
| `scripts/package.js` | Builds `dist/openfill-<ver>.ccx` and `-windows.zip` |
| `installer/` | Manual install without Creative Cloud |
| `test/` | Node tests (`npm test`), fake Photoshop and fake APIs |

## Known limits
- The services return at most about 4K. Filling a large part of a big image is upscaled and looks softer; the panel says so.
- Cancel cannot recall a request already sent; the service may still bill it.
- Manual installer is Windows only; macOS users use the .ccx.
- Verified live against both APIs: requests reach them and their error replies are mapped (Gemini accepts `imageConfig`; `responseFormat.image` wants enum values). Not yet verified: a paid image coming back.

## Test plan
- `npm test` (43 tests): geometry, PNG encoder (checked against zlib), base64, strip downsampling, provider requests and error mapping (with real captured error bodies), pipeline and Photoshop layer with fakes, require paths.
- In-Photoshop self-test (dev only): fill, variations + switching, ellipse, remove, corner, select-all, 24 MP photo, transparent area, 300 ppi, 16-bit, odd output sizes, expand right / all sides, rollback, cancel, no selection, panel pickers, live network checks. 23/23 on Photoshop 27.10.
- Still to do: a paid generation per service; Photoshop 2023 (24.4+) to 2025.
