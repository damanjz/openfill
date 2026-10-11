## What and why

<!-- One or two sentences: what this changes and the problem it solves. Link the issue if there is one. -->

## How it was checked

- [ ] `npm test` passes locally
- [ ] Touches Photoshop code (`plugin/src/photoshop.js`, `pipeline.js`, `main.js`): ran the in-Photoshop self-test and pasted the `status.txt` line below, with the Photoshop version
- [ ] Changes the panel: screenshots before and after, light and dark Photoshop themes
- [ ] Touches a provider: tested against the real API, or explained why not

Self-test result / Photoshop version:

```
```

## Ground rules

- [ ] No new runtime dependencies (the plugin ships with zero)
- [ ] No API keys, personal data or logs containing them
- [ ] Code reads like the code around it; one change per pull request

<!-- Every pull request gets an automated test run, a code review, and the maintainer's approval before it can merge. -->
