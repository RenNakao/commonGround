---
name: doclinks
description: Keep docs and code citing each other correctly with tools/doclinks.mjs and docs/links.json. Use when writing or changing a spec/doc, citing code from a doc or a doc from code, adding anchors, moving/renaming docs, or when a doclinks hook reports linked docs to review or check errors.
---

# doclinks: keeping docs and code in step

The link database is `docs/links.json`, maintained by `tools/doclinks.mjs`. Full reference: `tools/README.md`.

## What the hooks do
- **After each Edit/Write:** you're told which docs are linked to what you touched.
- **At the end of a turn:** you're stopped once with any linked live docs you haven't reviewed, any check errors, or a stale `links.json`. This happens *before* the auto-deploy commits.

For each doc you're shown:
- If your change affects what the doc says, update it in the same task.
- If it doesn't, record that instead of editing the doc to silence the warning:
  `node tools/doclinks.mjs reviewed <doc> --why "..."`

## Citing, so it can be checked
- **In a doc, naming code:** `` `src/App.tsx@App` ``. The part after `@` is a declaration name, or a `// @anchor name` comment on the line above the code. **Never `<file>.ts:120`.** It rots the first time a line is added above it.
- **In a doc describing the past:** pin the commit, as in `` `<file>.ts:120@<sha>` ``.
- **In code, naming a doc:** give the doc's name and section, as in `// SPEC-app §2.1`.

## Adding or moving docs
- **New spec:** create `docs/SPEC-<topic>.md` with numbered `##` sections. Then:
  - register it in `curated.docs` (`"SPEC-<topic>": "docs/SPEC-<topic>.md"`),
  - add the code it describes to `curated.covers` (keep the globs narrow).
  `docs/` is already live.
- **Moving or renaming a doc:** update its path in `curated.docs`, once.

## After changing citations, anchors or docs
```bash
node tools/doclinks.mjs build    # refresh the derived half of links.json
node tools/doclinks.mjs check    # must report 0 errors  (npm run doclinks)
node tools/doclinks.mjs impacted # what your uncommitted changes touch
```
The auto-deploy commits `docs/links.json` with everything else.
