# Contributing to OpenFill

Thanks for helping. OpenFill is open to contributions; releases stay with the maintainer, and only work that meets the bar below gets in.

## How a change gets in

1. **Open an issue first** for anything bigger than a small fix, so we agree on the approach before you write code.
2. **Fork, branch, and open a pull request** against `main`. Fill in the checklist in the pull request template.
3. **Automated checks** run on every pull request: 43 unit tests on Windows and Linux, the package build, and the Windows installer. Red checks can't merge.
4. **Code review.** Every pull request gets a full code review (the maintainer works with Claude, an AI assistant, for a line-by-line pass) and the maintainer's own review. Expect questions and requested changes; that's normal.
5. **Maintainer approval merges it.** Nobody else can merge to `main` or publish a release.

Releases (`.ccx` and the Windows zip) are built and published by the maintainer only, after the change has also passed the in-Photoshop self-test.

## The bar

- **It works in real Photoshop.** If you touch `plugin/src/photoshop.js`, `pipeline.js` or `main.js`, run the in-Photoshop self-test (see the README, "Develop") and paste the result and your Photoshop version in the pull request.
- **Tests come with the change.** New behaviour gets a unit test in `test/`; Photoshop behaviour gets a self-test scenario.
- **Zero runtime dependencies.** The plugin is plain CommonJS that runs in Photoshop's UXP on versions 24.4 to 27. No `btoa`, `TextEncoder`, `FormData`, canvas or ES modules in `plugin/`.
- **Match the code around you.** Same naming, comment density and structure. All Photoshop calls stay in `photoshop.js`; one file per AI service in `providers/`.
- **One change per pull request**, with a clear title and a short explanation of why.
- **Never commit keys** or logs that contain them.

## Adding an AI service

Write one file in `plugin/src/providers/` with the same shape as `openai.js` (`id`, `name`, `models`, `fitSize`, `generate`), list it in `providers/index.js`, add its domain to `plugin/manifest.json`, and add tests with recorded responses, including its error replies.

## Development

```bash
npm test          # unit tests
npm run package   # builds dist/
```

Install a development copy into Photoshop with `installer/install.ps1 -Source plugin` (Windows), then open **Plugins > OpenFill**.

## Conduct

Be kind and specific. Critique code, not people.
