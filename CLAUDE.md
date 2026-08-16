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
  scheduler are injected options. This is what lets handler logic be tested without a Workers
  runtime. There is no Playwright and no browser tooling anywhere in this repo.
- **Two test tiers, chosen by what is under test** — the rule is *test YOUR logic, not the
  platform's storage engine* (`/test-wisdom` → `project-recipes/backend-testing.mdx`):
  - **`createMockD1()`** (`src/db/test-support.ts`) — a `Map`-backed stub implementing only the
    `D1Database` methods a test needs. For handler branching and threading. Fast, plain Node.
  - **`createTestEnv()`** (`tests/helpers/test-env.ts`) — a **Miniflare**-backed real D1 binding with
    `migrations/` applied. For **storage semantics**: `ON CONFLICT DO NOTHING` reporting
    `meta.changes === 0`, `db.batch()` atomicity, the claim-token fenced `UPDATE` matching zero rows.

  Do **not** hand-roll a sqlite D1 shim. This project's critical assertions *are* those D1
  semantics, and a shim reproducing `meta.changes` by hand can drift from real D1 — leaving the
  tests agreeing with themselves while production breaks.
- **`exec()` splits on NEWLINES, not semicolons.** A pretty-printed multi-statement migration passed
  straight to D1's `exec()` throws `D1_EXEC_ERROR: incomplete input`. Split on `;`, collapse each
  statement to one line, `exec()` one at a time. Safe here because all 34 seed reference bodies
  contain zero semicolons — verified; keep it that way.
- **Pin crypto and absence assertions to something outside the code under test.** A sign-then-verify
  round trip passes even when the base string is built wrong, and an absence assertion can be tripped
  by its own fixture. Use independently-computed known-answer vectors (see #6), and grep
  `data/seed/products/` for any new absence token before shipping the assertion.
- **Read `result.meta.changes` on every conditional D1 write.** `success: true` with `changes: 0` is
  how a lost race presents, and it is not an error. Only use `SELECT changes()` inside a `db.batch()`.
- Package manager: **pnpm**. Tests: **vitest**. `pnpm typecheck && pnpm test` must pass before any PR.
- Migrations are **additive-only**.
- File naming: kebab-case.
- Commit messages start with a scope prefix: `[worker]`, `[slack]`, `[refs]`, `[llm]`, `[db]`,
  `[data]`, `[docs]`, `[misc]`.

## Working in a worktree (agents: read this before your first Bash call)

Parallel implementation runs in `worktrees/<topic>/`, each on its own `reply-bot/<topic>` branch,
with the primary checkout at the repo root sitting on `base/reply-bot`.

**The Bash working directory does not reliably persist between calls.** A `cd` in one call can be
reset by the next, so a `cd`-less command silently runs against the **primary checkout** — i.e.
against the shared base branch. This has already happened once in this repo. It was harmless that
time; a `git add -A && git commit` run the same way would have committed straight onto
`base/reply-bot`, bypassing the topic branch and the merge gate, and could have swept up a parallel
sibling's in-progress files.

- **Prefix every Bash call with an explicit `cd`** to your worktree. Never rely on a previous one.
- For git, prefer the unambiguous `git -C /abs/path/to/worktrees/<topic> ...`.
- **Before any `git add` / `git commit`**, confirm position:
  `cd <worktree> && pwd && git branch --show-current` — it must print your worktree and
  `reply-bot/<topic>`, never `base/reply-bot`.
- Read other repos (e.g. reference implementations) by absolute path, and `cd` back before writing.

**Do not keep editing after you send your completion report.** A late edit races the manager's merge
and is either lost or double-committed — this has also already happened here.

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
