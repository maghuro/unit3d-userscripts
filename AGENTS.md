# Repository instructions for coding agents

These instructions apply to the whole repository. Read them before editing code.
Keep changes focused on the affected component; this repository contains
multiple userscripts, not just BONanza.

## DarkPeers BONanza Giveaway (important)

- **Single source of truth:** `userscripts/giveaway/src/*.js` (15 ordered
  fragments). Never edit
  `userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js` directly.
  That file is **generated and committed** to Git for Tampermonkey.
- To modify the script, edit the relevant fragment. The file
  `scripts/build-bonanza.mjs` defines the **exact concatenation order**.
  Fragments are not independent JavaScript modules and must keep the
  existing single-IIFE runtime intact.
- Update metadata, version notes and `@version` in
  `userscripts/giveaway/src/00-preamble.js`, not in the generated file.
  When bumping the version, adjust tests that assert the precise version.
  Do not change `@namespace` or the update/download URLs unintentionally.
- From the repository root, **after every source change**, run:
  
  ```bash
  node scripts/build-bonanza.mjs
  node scripts/build-bonanza.mjs --check
  node --check userscripts/giveaway/DarkPeers_BONanza_Giveaway.user.js
  node --test tests/bonanza-*.test.mjs
  git diff --check
  ```

- Commit both the changed fragments and the regenerated
  `DarkPeers_BONanza_Giveaway.user.js` (plus any tests/docs) in the same PR.
  A source-only commit will fail CI because the generated file is stale.
  Do not patch the generated file by hand, even to repair a review finding:
  fix the source, then rebuild.
- The **Validate BONanza** GitHub Action verifies the tracked bundle, checks
  syntax and runs tests on PRs and relevant pushes to `main`. It does not
  commit the generated file for you.
- On relevant pushes to `main`, **Publish BONanza to Gist** rebuilds,
  fails if the committed bundle differs, and then publishes the userscript
  plus a generated `.meta.js` update manifest. No deployment occurs merely
  from opening a PR. Do not manually publish or maintain the Gist.
- The script can transfer real BON. Preserve safety gates around ownership,
  recovery, gift history, settlement and transfers. Add regression tests for
  affected behavior, and use rehearsal mode for validation that would
  otherwise post public chat messages or move real currency/points. Never
  initiate a live payout for a routine code test.

Full source layout and examples:
[`userscripts/giveaway/src/README.md`](userscripts/giveaway/src/README.md).

If repository conventions or workflows change, update **both** this file
and the component's README in the same PR so future agents get accurate
instructions.
