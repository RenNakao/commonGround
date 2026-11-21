# commonGround

A blank app for showing an AI agent building and shipping software live.
Every time the agent finishes a turn, the app is committed, built, and deployed to
`https://common-ground.<your-subdomain>.workers.dev`.

## Run the demo
```bash
cd commonGround     # project settings, skills, and hooks only load from here
claude
```
Then describe an app. The URL updates when each turn ends.

## How it works
| Piece | Where |
|---|---|
| React + Vite + Tailwind frontend | `src/` |
| Cloudflare Worker API | `worker/index.ts`, `wrangler.jsonc` |
| Turn-end Stop hook: doclinks review, then auto-deploy | `.claude/settings.json` → `scripts/on-stop.sh` → `scripts/deploy.sh` |
| doclinks: keeps docs and code citing each other (PostToolUse + Stop + git pre-commit) | `tools/doclinks.mjs`, `docs/links.json`, `.githooks/`, skill `.claude/skills/doclinks` |
| Project plugins: frontend-design, cloudflare, playwright | `.claude/settings.json` `enabledPlugins` |
| Agent instructions | `CLAUDE.md` |

`scripts/deploy.sh` auto-commits, then skips the deploy if HEAD hasn't changed since the last one
(so turns that only answer questions don't redeploy). If the build fails, it returns the error to
the agent once so the agent can fix it. Logs go to `.wrangler/deploy.log`. To deploy by hand, run
`npm run ship`. To force a deploy, run `FORCE=1 npm run ship`.

Before deploying, the Stop hook runs doclinks (see
[`tools/README.md`](tools/README.md)). If a doc linked to the changed code wasn't reviewed, or
`npm run doclinks` has errors, the agent is stopped once to deal with it. The deploy then runs at the
next stop. Each new clone needs `git config core.hooksPath .githooks`.

## Credentials
`.env` (gitignored; template in `.env.example`) holds `CLOUDFLARE_ACCOUNT_ID` and an optional
`CLOUDFLARE_API_TOKEN`. If there's no token, wrangler uses the OAuth login in
`~/.config/.wrangler`. A token from the "Edit Cloudflare Workers" template is safer for an
unattended demo.

## Reset between rehearsals
```bash
git reset --hard scaffold && FORCE=1 npm run ship
```
