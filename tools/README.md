# tools

Repository tooling for a TypeScript app.

## doclinks — keeping docs and code in step

[`doclinks.mjs`](doclinks.mjs) maintains **`docs/links.json`**, a committed database of how the docs and
the code cite each other, and uses it to tell you — and any agent working here — which docs a change
affects, and which code a doc change affects.

The current-tree view includes tracked files and nonignored untracked files, so a new document,
registered name, source citation or coverage rule can be checked before staging. Ignored untracked
captures and local configuration remain outside that view; deleted tracked paths are absent.
Commit-pinned citations still resolve against their named commit. The git status, diff and staged
review commands retain their existing meaning.

### The database

| section | who edits it | what it holds |
|---|---|---|
| `curated.docs` | you | the registry of doc names → paths. Code cites docs by name (`SPEC-app §2`, `README`); this is where a name resolves. **A renamed or moved doc changes here, once.** |
| `curated.live` | you | which docs describe the tree *now* and are held to the checks. Everything else is record. |
| `curated.covers` | you | doc → the code it describes (globs). Changing covered code names the doc for review. Keep these narrow: a doc that covers everything is a reminder nobody reads. |
| `curated.retired` | you | files deleted on purpose (globs allowed) that live docs may still name, each with why. |
| `curated.reviewed` | `reviewed` | doc → the commit it was last checked against with no change needed, and why. Clears the "older than the code it covers" warning until the code moves again. |
| `curated.notDocs` | you | strings that look like doc names and are not (e.g. a `SPEC-` string that is not a doc). |
| `derived` | `build` only | every code→doc citation with its sections, every doc→code citation, and a fingerprint of each anchored line. |

### Citing, so the database can follow

- **In a doc, naming code:** `<file>.ts@<name>` (also `.tsx .js .jsx .mjs .css .sh .py .jsonc`) — `name` is a `// @anchor name` comment placed on the line above
  the code, or a declaration (`function name`, `const name =`, `interface name`, a method). Never `<file>.ts:120`: the first line
  added above it makes it wrong, silently.
- **In a doc that records the past:** `<file>.ts:120@<sha>` — line 120 *as it was at that commit*. It never
  drifts, and `check` verifies the commit and line exist.
- **In code, naming a doc:** name the doc and the section — `SPEC-app §2`, `SPEC-api §3.1`. A bare `§3.2`
  is ambiguous and is not tracked.

### Commands (repo root)

```
node tools/doclinks.mjs build             # refresh derived — run after changing citations or anchors
node tools/doclinks.mjs check [--memory]  # errors exit 1; --memory also checks the agent memory dir
node tools/doclinks.mjs impacted [files]  # what to review, with prose naming edited symbols; default = your uncommitted changes
node tools/doclinks.mjs reviewed <docs> --why "..."   # checked at HEAD, no change needed — clears drift
```

### Where it runs

| trigger | what happens |
|---|---|
| **`npm run doclinks`** (`check`) | **fails** on broken citations: a missing file, an unresolved anchor, a bad pin, a bare line citation in a live doc, a broken link, an unregistered doc name. **Warns** on drift: anchored code changed, `derived` stale, a doc older than code it covers |
| **Claude Code** (`.claude/settings.json`) | after an edit, the agent is told which docs are linked *to what it touched*; at the end of a turn (`scripts/on-stop.sh`) it is stopped once and shown any linked live docs it changed code under without reviewing — **before** the auto-deploy commits, so the review sees the turn's changes |
| **git** (`.githooks/pre-commit`) | lists linked docs missing from the commit, and check errors — warns, never blocks |

For code edits, impact reports include short doc sentences that name the enclosing symbol at the changed
lines. The hook uses the replacement text; `impacted` and commit hooks use changed diff lines. This is a
small brace-based scan of function, class, method and initializer bodies, not a JavaScript parser. It can
miss unusual or computed declarations, and reports excerpts only for docs already linked by an anchor,
coverage rule, or code citation.

Enable the git hook once per clone: `git config core.hooksPath .githooks` (already set in this clone).
