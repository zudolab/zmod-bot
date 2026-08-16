# CLAUDE.md

Slack bot that composes Mercari Shops purchase-reply messages for Takazudo Modular, running as a
single Cloudflare Worker. It replaces the `/l-reply-purchase` Claude Code skill: mention the bot with
a product name or URL, get back a ready-to-copy Japanese customer message.

Build plan and the full sub-issue breakdown: issue #1.

## Non-negotiables

- **No `@slack/*` package and no LLM SDK.** Everything is raw `fetch` + `crypto.subtle`. This is a
  deliberate architecture decision, not an oversight — a sibling project runs exactly this shape in
  production with zero Slack dependencies.
- **No Cloudflare Agents SDK, no Flue, no Durable Objects.** A sibling project built the Agents SDK
  path for a comparable feature and it shipped dark. This bot is request → text → post.
- **The fixed clauses of a reply never go near a model.** Greeting, shipping line, arrival sentence,
  evaluation clause, DIY block and closing are byte-exact constants. Only the product-resources
  section is composed.
- **What the human copies out of Slack must equal what the generator produced.** The reply is pasted
  verbatim into Mercari Shops. Post it as Block Kit `rich_text_preformatted` (literal content), never
  as mrkdwn — mrkdwn round-trips `&` / `<` / `>` through HTML entities.
- **D1 is the runtime store for product references.** `data/seed/` is an immutable bootstrap fixture,
  applied once by the seed migration; nothing under `src/**` may import from it.
- **Durable intent before the ack.** Write the receipt + job row in one `db.batch()` and *then*
  return 200. If that write fails, return a retryable 5xx — a 200 with nothing recorded loses the
  event silently. Immediate delivery is an optimization; the cron sweep is the contract.
- **Every ignored Slack event returns 200.** A non-2xx for an event we simply do not want spends one
  of Slack's three retries to reach the identical conclusion.
- **Always pass `max_tokens` to `env.AI.run`.** Llama on Workers AI silently defaults to 256 output
  tokens and returns truncated output rather than an error. A round-number `completion_tokens` is the
  tell.
- **Do not wire `gateway: { id }` into `AI.run`.** An unprovisioned named AI Gateway returns
  Cloudflare error 2001 on every call — this exact mistake dark-shipped a sibling project.
- **Never log a prompt body, a reference body, polish input, or a credential.** They are
  customer-facing business text.

## Conventions

- **Dependency injection at every I/O boundary** — `fetch`, `sleep`, `now`, and the `waitUntil`
  scheduler are injected options. This is what lets the whole system be tested without a Workers
  runtime; there is no Miniflare and no Playwright in this repo.
- **Read `result.meta.changes` on every conditional D1 write.** `success: true` with `changes: 0` is
  how a lost race presents, and it is not an error. Only use `SELECT changes()` inside a `db.batch()`.
- Package manager: **pnpm**. Tests: **vitest**. `pnpm typecheck && pnpm test` must pass before any PR.
- Migrations are **additive-only**.
- File naming: kebab-case.
- Commit messages start with a scope prefix: `[worker]`, `[slack]`, `[refs]`, `[llm]`, `[db]`,
  `[data]`, `[docs]`, `[misc]`.

## Repo layout

```
src/index.ts     Worker entry (fetch + scheduled)
src/router.ts    URLPattern router — no framework
src/db/          schema, repositories, SQLite test shim
src/refs/        reference parser, domain model, resolver
src/slack/       verify, events, api, blocks, interactions, commands
src/reply/       templates, deterministic renderer, compose orchestration
src/llm/         provider interface, Workers AI + Claude adapters, guards
src/jobs/        job queue state machine, delivery worker
data/seed/       immutable bootstrap corpus (34 product references)
migrations/      D1 migrations, applied by CI before deploy
docs/            setup runbook, operations, Slack manifest, smoke test
```

## Setup state

The repo is **public** for now. No secrets, tokens, account ids or customer data belong in it.
Reservation-reply support is deliberately out of scope until the repo is private — its template
embeds a real bank account number.
