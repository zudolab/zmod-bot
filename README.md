# zmod-bot

A Slack bot that composes Mercari Shops purchase-reply messages for Takazudo Modular, a Japanese
modular synthesizer shop. It replaces the `/l-reply-purchase` Claude Code skill: mention the bot
with a product name or URL in Slack, get back a ready-to-copy Japanese customer message.

Runs as a single Cloudflare Worker — no framework, no `@slack/*` package, no LLM SDK, no Durable
Objects. See `CLAUDE.md` for the full list of non-negotiable architecture decisions and why each
one exists.

## What it does

- Listens for `app_mention` events over the Slack Events API.
- Resolves the mentioned product (name, alias, or URL) to a **product reference** stored in D1.
- Composes a reply: a byte-exact deterministic skeleton (greeting, shipping line, arrival sentence,
  evaluation clause, closing) plus an LLM-composed product-resources section. If the LLM output
  fails any guard (budget, deadline, or output shape), the same reference is rendered
  deterministically instead — a reply is always produced, never a silent failure.
- Posts the reply back in-thread as Block Kit `rich_text_preformatted`, so what the human copies out
  of Slack is byte-identical to what the generator produced (the message is pasted verbatim into
  Mercari Shops).
- Can create, refresh, inspect, and roll back product references from Slack (`@bot ref …`), gated to
  admin users, with every write going through an approve/reject preview.
- Has a `polish` mode: paste arbitrary Japanese customer-message text after `@bot polish` and get a
  more business-polite version back, same structure, same URLs, same line breaks.

## Architecture

```
Slack  --POST /slack/events-------->  zmod-bot Worker  --> D1 (refs + versions + drafts + receipts + jobs)
       --POST /slack/interactions-->      |
       <--chat.postMessage--------------- |--> env.AI (Workers AI)   hot path: assemble a resource section
                                          |--> api.anthropic.com     authoring path: write/refresh a reference
                                          `--> takazudomodular.com/api  product facts for authoring
```

Two LLM providers sit behind one internal interface, selected per task by a `wrangler.jsonc` var —
see `docs/operations.md` for the full table:

| Task | Frequency | Provider (default) | Why |
|---|---|---|---|
| Assemble the resource section from an existing reference | every reply | Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) | Reflows prose that already exists in the reference |
| Author a brand-new reference / refresh a stale one | rare | Claude API | Needs to read the live site and write polite Japanese from scratch |
| Polish arbitrary pasted Japanese | occasional | Workers AI (either, `var`-selected) | — |

**Durable intent before the ack.** A `POST /slack/events` that Slack must retry (a D1 write failure)
returns a retryable 5xx; every event the bot intentionally ignores still returns 200 (a non-2xx
would just spend one of Slack's three retries reaching the same conclusion). Once an event is
recorded, delivery is attempted immediately via `ctx.waitUntil` as an optimization, but the actual
contract is the cron sweep — every 5 minutes, `runScheduledSweep` claims pending/failed jobs and
retries them regardless of whether the immediate attempt ever ran. See `src/jobs/queue.ts` and
`docs/operations.md` for the job state machine and retry policy.

## Module map

```
src/index.ts     Worker entry — routes fetch() to the router, scheduled() to the cron sweep
src/router.ts    Minimal typed URLPattern router (no framework)
src/health.ts    GET /health — a real D1 round-trip + migration bookkeeping
src/env.ts       The Env binding/secret/var interface — see docs/operations.md for the full table
src/db/          D1 row types (schema.ts), repositories (repos.ts), test-only D1 stub
src/refs/        Reference parser, ProductRef domain model, alias resolver, ref command handlers
src/slack/       Signature verification, events ingress, Web API client, Block Kit builders,
                 command grammar, interactions (button clicks / modals)
src/reply/       Fixed-clause templates, deterministic renderer, compose orchestration, polish mode
src/llm/         Provider interface, Workers AI + Claude adapters, the budget/deadline/output guards
src/jobs/        Job state machine, delivery worker, retention sweep
src/ops/         Structured logging + credential-redaction helpers
data/seed/       Immutable bootstrap corpus (34 product references) — applied once by
                 migrations/0002_seed_product_refs.sql, never read at runtime (see data/seed/README.md)
migrations/      D1 migrations, applied by CI before every deploy
docs/            This runbook, the Slack app manifest, operations reference, and smoke test
```

## Running locally

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in real values — this file is gitignored, never commit it
pnpm dev                          # wrangler dev
```

`wrangler dev` runs against a **local**, ephemeral D1 instance (Miniflare) unless you pass
`--remote`. Migrations are not applied automatically for local dev — run them once against the
local database before your first `pnpm dev`:

```bash
npx wrangler d1 migrations apply zmod-bot --local
```

This includes the seed migration, so local dev gets the same 34 references production does. For the
full first-time setup (creating the real D1 database, the Slack app, and every secret), see
**`docs/setup.md`** — order matters there.

## Testing

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

Tests run in plain Node — no `wrangler dev`, no browser. Most I/O boundaries (`fetch`, `sleep`,
`now`, the `waitUntil` scheduler) are dependency-injected, so handler logic is tested with plain
fakes. D1 storage semantics specifically (`ON CONFLICT DO NOTHING` → `meta.changes === 0`,
`db.batch()` atomicity, the claim-token fenced `UPDATE`) are tested against a real Miniflare-backed
D1 binding with `migrations/` applied (`tests/helpers/test-env.ts`) rather than a hand-rolled stub —
see `CLAUDE.md` "Conventions" for why.

**No test here has ever exercised a real model call** — every guard test uses a fake `AI` binding.
`docs/smoke-test.md` covers what only a deployed Worker with real credentials can prove.

## Documentation

- **`docs/setup.md`** — the ordered, first-time setup runbook (D1, Slack app, secrets, deploy, Event
  Subscriptions). Start here for a fresh deployment.
- **`docs/slack-manifest.yml`** — the Slack app manifest referenced by setup step 2.
- **`docs/operations.md`** — the secret/var reference table, the job state machine, reading
  `usage_log`, retention windows, token rotation, and the reference-authoring workflow.
- **`docs/smoke-test.md`** — the checks that require a live deployment: a real provider call, real
  token throughput, whether `AbortController` actually cancels a Workers AI call, and the
  byte-exactness check between what the bot posts and what a human copies out of Slack.

## Status

Feature-complete for purchase-reply composition, polish mode, and reference read/rollback commands.
`ref new` / `ref refresh` (LLM-authored new/refreshed references) are tracked separately — see
`docs/operations.md` for their current status before relying on them.

This repo is currently **public**. No secrets, tokens, account ids, or customer data belong in it —
see `CLAUDE.md` "Setup state". Reservation-reply support is out of scope until the repo is private
(its template embeds a real bank account number).
