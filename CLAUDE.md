# Demo app

A blank full-stack web app. Build whatever is asked for here.

## Stack
- Frontend: React 19 + TypeScript + Vite, styled with Tailwind CSS v4 (`@import "tailwindcss"` in `src/index.css`). Entry: `src/main.tsx` → `src/App.tsx`.
- Backend: a Cloudflare Worker in `worker/index.ts`. Handle `/api/*` routes there; everything else is served from the built frontend (SPA fallback is on).
- Config: `wrangler.jsonc` (Worker name `common-ground`). Add bindings (KV, D1, R2, Workers AI, Durable Objects) there, then run `npm run cf-typegen`.
- Workers AI is already bound as `env.AI`. Call it from the Worker, never the browser:
  `await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages })` returns `{ response }`.
  Pass `stream: true` to get an SSE stream you can return directly. Check the `cloudflare` skill or the
  [model catalog](https://developers.cloudflare.com/workers-ai/models/) for current model IDs (text,
  image generation, speech-to-text, embeddings). It also runs remotely under `npm run dev`.

## Deploying is automatic
When you finish a turn, a Stop hook (`scripts/deploy.sh`) commits your changes, builds, and deploys to
`https://common-ground.<your-subdomain>.workers.dev`. Don't run `wrangler deploy` yourself.
If the build fails, the hook hands you the error. Fix it and the deploy runs again.
Run `npm run build` before finishing so a broken build doesn't reach the hook.

## Skills
- Use the `frontend-design` skill for any UI or visual design work. Aim for something distinctive, not a generic template.
- Use the Cloudflare skills (`cloudflare`, `wrangler`, `workers-best-practices`, …) for Worker APIs, bindings, and storage.
- Use Playwright to check the result in a real browser (local `npm run dev`, or the live URL after deploy).

## Rules
- Never read or print `.env`. Credentials are loaded by the deploy script.
- Replace the placeholder in `src/App.tsx`. `/api/health` can go too.

## Docs and code stay linked (doclinks)
`docs/links.json` (maintained by `tools/doclinks.mjs`) records which docs describe which code. Hooks tell
you which docs are linked to what you edit, and stop you once at the end of a turn if a linked doc
wasn't reviewed. See the `doclinks` skill. In short: write specs as `docs/SPEC-<topic>.md` with numbered
sections, cite code from docs as `<file>.ts@<symbol>` (never `<file>.ts:120`), cite docs from code as
`SPEC-<topic> §N`, and run `node tools/doclinks.mjs build` after changing citations.
`node tools/doclinks.mjs check` must report 0 errors.
