# Operations

Reference for running zmod-bot day to day: what every secret/var does, how to read the job queue
and `usage_log`, retention, and token rotation.

## Secrets and vars

Every name below is read somewhere under `src/**` (`src/env.ts`'s `Env` interface is the type-level
list; `tests/env-wrangler-drift.test.ts` fails CI if this table's two sources — `src/env.ts` and
`wrangler.jsonc`'s `secrets.required`/`vars` — ever disagree with each other or with what the code
actually reads).

### Secrets (`wrangler secret put <NAME>`, never committed)

| Name | Where it comes from | What breaks without it |
|---|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`), after Install to Workspace | Every Slack Web API call (`chat.postMessage`, `chat.postEphemeral`, `chat.update`, `views.open`) gets a `401` from Slack. Jobs still get created and retried (see "Job states" below), but delivery never succeeds — a job exhausts its 5 attempts and lands `dead`. |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → App Credentials → Signing Secret | `src/slack/verify.ts` throws on a blank secret, which both `POST /slack/events` and `POST /slack/interactions` turn into a `500 server misconfigured` for **every** request — including Slack's own `url_verification` challenge, so Event Subscriptions can't even be enabled (see `docs/setup.md` step 10). With a *wrong* (not blank) secret, every request instead gets `401 invalid signature`. |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys | The Claude adapter (`src/llm/claude.ts`) throws `LlmConfigurationError` on every call. For `compose`/`polish`, this is caught by the guard envelope and downgrades to the deterministic fallback (a reply/polish is still produced — see "Reading `usage_log`" below). Reference authoring (`ref new`/`ref refresh`, once wired — see "Reference authoring" below) has **no fallback**: per issue #17's design, an authoring failure is reported to the operator, not silently downgraded, because there is no deterministic way to invent a reference. |

### Vars (`wrangler.jsonc`'s `vars` block, plain values, safe to commit — none of these are credentials)

| Name | Where it comes from | What breaks without it |
|---|---|---|
| `SLACK_BOT_USER_ID` | `auth.test` with the bot token (`docs/setup.md` step 4) — the bot's own Slack user id | `src/slack/events.ts` compares every mention's `event.user` against this to reject the bot's own messages and prevent a self-trigger loop. Left blank, the check simply never matches (no known message has an empty user id), so the practical risk today is low — but any future feature that has the bot post something Slack treats as a mention-worthy message would loop indefinitely. Set it correctly. |
| `SLACK_ALLOWED_CHANNEL_IDS` | Comma-separated Slack channel ids (`parseCommaSeparated`, `src/env.ts`) | **Left empty, the bot acts in every channel it's invited to** — this is the documented default, not a misconfiguration (`src/slack/events.ts` `isAllowedChannel`). Set it if you want to restrict the bot to specific channels. |
| `SLACK_ADMIN_USER_IDS` | Comma-separated Slack user ids | **Left empty, nobody can run `ref new`/`ref refresh`/`ref restore` or click an approve/reject/create-reference button** — every one of those gets "この操作には管理者権限が必要です" (`isAdminUser`, `src/slack/commands.ts`). Reference management is effectively disabled without this set. |
| `COMPOSE_PROVIDER` | `"workers-ai"` \| `"claude"` | Selects the provider for assembling a reply's resource section. An unrecognized value logs a warning and **fails open to `"workers-ai"`** (`src/reply/compose.ts` `selectComposeProvider`) — a typo here degrades silently rather than breaking replies. |
| `AUTHOR_PROVIDER` | `"workers-ai"` \| `"claude"` | Selects the provider for `ref new`/`ref refresh`. Same fail-open behavior as `COMPOSE_PROVIDER`. **Declared but not yet read by any shipped code path** — see "Reference authoring" below. |
| `POLISH_PROVIDER` | `"workers-ai"` \| `"claude"` | Selects the provider for `@bot polish`. Same fail-open behavior. |
| `CLAUDE_MODEL` | An Anthropic model id, e.g. `claude-sonnet-5` | Blank (the shipped default) falls back to `src/llm/claude.ts`'s `DEFAULT_CLAUDE_MODEL` (`claude-haiku-4-5`) — the one place that default lives. Set this to raise the tier without a code change. |
| `SITE_API_BASE` | `https://takazudomodular.com` (shipped default — leave as-is in production) | The base URL reference authoring is designed to fetch product facts from (`GET {SITE_API_BASE}/api/products`, `/api/search` — see issue #17). **Not yet read by any shipped code path** — same caveat as `AUTHOR_PROVIDER`. |

### Bindings (`wrangler.jsonc`, not secrets or vars)

| Binding | Declared in | Notes |
|---|---|---|
| `DB` | `d1_databases` | The D1 database created in `docs/setup.md` step 1. |
| `AI` | `ai` | Workers AI. **Deliberately no `gateway: { id }` option** — see "AI Gateway is deliberately not wired up" below. |

## Job states

```
pending -> composing -> delivering -> done
                     \-> failed  -----------> dead
   ^                       |
   `-----------------------' (re-claimed after backoff)
```

(`src/jobs/queue.ts` `JOB_STATE_TRANSITIONS`.) `failed` is not a dead end and not a synonym for
`pending` — a failed job re-enters the exact same claimable pool a fresh `pending` job sits in
(`src/db/repos.ts` `claimJobs` claims `state IN ('pending', 'failed')`); what keeps it from being
picked up immediately is `claim_expires_at`, pushed forward by the backoff below. There is no
separate "retry" write.

Every reply/polish/ref request from Slack becomes one `jobs` row at intake, before the bot ever
acks Slack — see the epic's "durable intent before the ack." The cron trigger
(`wrangler.jsonc` `triggers.crons`, **every 5 minutes**) runs `runScheduledSweep`, which claims up
to 10 pending/failed jobs per tick, attempts delivery, and then runs the retention sweep (below).
An immediate delivery attempt also fires right after ack via `ctx.waitUntil` — that's an
optimization on top of the cron sweep, not a second contract; if it fails or the Worker gets killed
before it finishes, the cron sweep still delivers the job on its next tick.

**Retry policy** (`src/jobs/queue.ts` `DEFAULT_RETRY_POLICY`): up to 5 attempts, with backoff
doubling from a 2-minute floor, capped at 30 minutes:

| Attempt | Backoff before reclaimable |
|---|---|
| 1 | 2 min |
| 2 | 4 min |
| 3 | 8 min |
| 4 | 16 min |
| 5 | — lands `dead` immediately, no further retry |

`dead` jobs are **not** auto-deleted (see "Retention" below) — `last_error` on a dead job is exactly
what an operator needs to investigate, and auto-deleting it would erase the trail.

### Inspecting a stuck job

```bash
# Anything not done, most recent first
npx wrangler d1 execute zmod-bot --remote --command \
  "SELECT id, kind, state, attempts, last_error, channel_id, created_at, updated_at FROM jobs WHERE state != 'done' ORDER BY updated_at DESC LIMIT 20;"

# A specific job
npx wrangler d1 execute zmod-bot --remote --command \
  "SELECT * FROM jobs WHERE id = 123;"

# Everything that's exhausted its retries
npx wrangler d1 execute zmod-bot --remote --command \
  "SELECT id, kind, channel_id, actor_user_id, last_error, updated_at FROM jobs WHERE state = 'dead' ORDER BY updated_at DESC;"
```

`raw_text` on a `jobs` row is the original Slack mention text — useful for reproducing what the bot
was asked to do, but per `CLAUDE.md` treat it as customer-facing text: don't paste it into a public
channel or issue without checking it first.

## Reading `usage_log`

Every LLM call this bot makes — including ones that fell back — writes one row here
(`src/db/repos.ts` `appendUsageLog`), whether from `composeReply` (`src/reply/compose.ts`) or
`polishText` (`src/reply/polish.ts`):

```sql
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT,              -- NULL for polish (no product involved)
  task TEXT NOT NULL,     -- 'compose' | 'author' | 'polish'
  provider TEXT NOT NULL, -- 'workers-ai' | 'claude'
  model TEXT,             -- the model that actually served the call, if one completed
  fallback TEXT,          -- NULL on the happy path, else a reason token — see below
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL
);
```

```bash
# Fallback rate for compose, last 24h
npx wrangler d1 execute zmod-bot --remote --command \
  "SELECT fallback, COUNT(*) AS n FROM usage_log WHERE task = 'compose' AND created_at > (unixepoch()*1000 - 86400000) GROUP BY fallback ORDER BY n DESC;"
```

**`fallback` is a closed set of reason tokens, safe to group by** — `rate_limited`,
`budget_exceeded`, `circuit_open`, `timeout`, `provider_error`, `schema_invalid`,
`empty_response`, `url_mismatch`, `truncated` (`src/llm/guards.ts` `FallbackReason`). The
richer, free-text explanation of *why* a specific call tripped a guard (`ComposeFallback.detail` —
e.g. `"2 invented, 1 missing of 4"`) is **never written to this column**; it only ever reaches a
Worker log line, and per `src/llm/guards.ts`'s own module comment it must never become a metric
label — grouping on free text defeats the point of having a bounded token in the first place. If
you need the detail for a specific incident, pull it from the Worker's `wrangler tail` output around
that timestamp, not from `usage_log`.

**A row with `fallback = NULL` is the happy path** — the model's output passed every guard. A row
where `fallback` is one of the `PRE_CALL_FALLBACK_REASONS` (`budget_exceeded`, `circuit_open`)
means the provider was never called at all — see "Reading the budget guard correctly" below.

**No `usage_log` row at all for a given reply is not a bug.** Three references in the seed corpus
(`ai-mult`, `oxi-pipe-mk2`, `x0x-heart`) carry nothing but editorial `Notes` — there is no
product-resources section for a model to assemble, so `composeReply` skips the provider entirely and
logs nothing (`src/reply/compose.ts`: "no resources section, skipping the provider"). If you're
correlating `jobs` against `usage_log` and find a `done` reply job with no matching row, check
whether its reference is one of these editorial-only ones before assuming a write was lost.

### Reading the budget guard correctly

`checkBudgetGuard` counts calls per UTC day per task (`compose` / `polish`, 300/day each by
default — `DEFAULT_COMPOSE_DAILY_CAP` / `DEFAULT_POLISH_DAILY_CAP`), and **excludes** rows whose
`fallback` is in `PRE_CALL_FALLBACK_REASONS` from that count — because those rows represent calls
that never reached the provider and so never spent anything against the budget. Today that set is
`["budget_exceeded", "circuit_open"]`.

**`circuit_open` is a reserved token with no emitter.** Nothing in this codebase implements a
circuit breaker yet — the token exists purely so `PRE_CALL_FALLBACK_REASONS` can name it in
advance. **If a circuit breaker is added later, it must be added to `PRE_CALL_FALLBACK_REASONS` in
the exact same commit that lands it.** If it's forgotten, every breaker-tripped fallback row still
counts as a "real" call in the budget query above — the daily cap starts tripping against calls that
never happened, and a legitimate customer reply falls back to the deterministic renderer for no
reason a dashboard can explain, because the rows that caused it look like the same
`budget_exceeded` situation the guard is supposed to protect against.

## Retention

The cron sweep (`src/jobs/retention.ts` `runRetentionSweep`, invoked from the same 5-minute tick as
delivery) deletes, bounded at 500 rows per table per tick:

| Table | Retention | Why |
|---|---|---|
| `slack_event_receipts` | 24 hours | Slack's own retry window tops out around 5 minutes — this is enormous margin, kept short so the de-dup table doesn't grow forever. |
| `jobs` (state = `done` only) | 7 days | Enough window to investigate a "did my reply actually send" question after the fact. |
| `ref_drafts` (past `expires_at`) | Immediate (next tick after expiry) | Drafts are single-use previews, not history — `product_ref_versions` is the permanent record once approved. |
| `usage_log` | 90 days | Long enough for a monthly fallback-rate review; short enough that the table doesn't grow unbounded. |

**`dead` jobs are never auto-deleted** — see "Job states" above.

## Rotating credentials

**Slack bot token**: Slack app → OAuth & Permissions → Rotate (or reinstall the app to the
workspace to force a new token), then `npx wrangler secret put SLACK_BOT_TOKEN` with the new value.
The old token stops working the moment you rotate it in Slack, so do this promptly after generating
the new one — there's a window where in-flight jobs using the old token will fail and retry (see
"Job states"), which is harmless but generates noise.

**Anthropic API key**: console.anthropic.com → API Keys → create a new key, `npx wrangler secret put
ANTHROPIC_API_KEY` with it, then revoke the old key from the console once you've confirmed the new
one works (a `ref refresh` or a `@bot polish` with `POLISH_PROVIDER=claude` set are quick ways to
force a real Claude call).

Neither rotation requires a redeploy — `wrangler secret put` updates the running Worker's binding
directly.

## Restoring a bad reference edit

Every write to `product_refs` — seed, an approved `ref new`, an approved `ref refresh`, or a
restore itself — appends a row to `product_ref_versions` rather than overwriting history
(`src/refs/commands.ts` module comment: "this module is the undo mechanism"). Nothing is ever
deleted or rewritten there.

```
@bot ref history <slug or product name>
```

Lists recent versions (capped at 20, `REF_HISTORY_LIMIT`) with their `source` (`seed` / `authored` /
`refreshed` / `restored`), timestamp, and editor. Then:

```
@bot ref restore <slug or product name> <version number>
```

Admin-only, checked twice — once against whoever typed the command, again against whoever clicks
approve (`src/refs/commands.ts`: "the person who clicks is not necessarily the person who typed").
This does **not** rewrite the target version in place — it creates a **new** version whose body is a
copy of the one you asked to restore, going through the same approve/reject preview as any other
write (`base_version` pinned to the reference's *current* version at request time, so a concurrent
edit landing while you're reviewing the preview gets caught and refused rather than silently
overwritten). Approve it from the Slack message the bot posts, the same way you'd approve a
`ref refresh`.

## Reference authoring — current status

`ref new` (write a brand-new reference from scratch) and `ref refresh` (fold new videos/guides into
an existing one) are designed in issue #17 — LLM-generated draft, machine-checked against the
existing corpus format, admin-approved through the same draft/preview flow as everything else in
this section — but **as of this doc, both commands and the "create a reference" button on a
resolver-miss reply return a placeholder message rather than doing that work**
(`src/refs/commands.ts`, `src/slack/interactions.ts`). If you invoke either and get back "まだ実装され
ていません", that's expected given the current build state, not a misconfiguration — check whether
issue #17 has since merged before assuming this doc is wrong. `AUTHOR_PROVIDER` and `SITE_API_BASE`
above exist for this feature and are unused until it lands.

## AI Gateway is deliberately not wired up

`wrangler.jsonc`'s `ai` binding has no `gateway: { id }` option, and `src/llm/workers-ai.ts` passes
nothing but `{ signal }` in the options it hands to `env.AI.run`. **Do not add a named gateway id
here before provisioning that gateway in the Cloudflare dashboard.** An AI Gateway id that doesn't
exist yet makes `env.AI.run` fail with Cloudflare error 2001 on **every** call — not a warning, not
a degraded mode, every single request. This exact mistake dark-shipped a sibling project. If you
want AI Gateway's logging/caching/rate-limiting later: create the gateway in the dashboard first,
confirm it exists, *then* add `gateway: { id: "<name>" }` to `wrangler.jsonc`'s `ai` block and
redeploy.
