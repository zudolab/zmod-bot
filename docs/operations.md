# Operations

Reference for running zmod-bot day to day: what every secret/var does, how to operate both policy
routes, read the job queue and `usage_log`, retention, and token rotation. The integrated stash route
is documented here as an operating contract; it has not been provisioned or live-verified yet.

## Secrets and vars

Every existing runtime name below is read somewhere under `src/**` (`src/env.ts`'s `Env` interface is the type-level
list; `tests/env-wrangler-drift.test.ts` fails CI if this table's two sources — `src/env.ts` and
`wrangler.jsonc`'s `secrets.required`/`vars` — ever disagree with each other or with what the code
actually reads). The `STASH_*` names are declared so the optional stash route can be configured after
the last setup step; they are not evidence that a stash has been provisioned.

### Secrets (`wrangler secret put <NAME>`, never committed)

| Name | Where it comes from | What breaks without it |
|---|---|---|
| `SLACK_BOT_TOKEN` | Slack app → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`), after Install to Workspace | Every Slack Web API call (`chat.postMessage`, `chat.postEphemeral`, `chat.update`, `views.open`) gets a `401` from Slack. Jobs still get created and retried (see "Job states" below), but delivery never succeeds — a job exhausts its 5 attempts and lands `dead`. |
| `SLACK_SIGNING_SECRET` | Slack app → Basic Information → App Credentials → Signing Secret | `src/slack/verify.ts` throws on a blank secret, which both `POST /slack/events` and `POST /slack/interactions` turn into a `500 server misconfigured` for **every** request — including Slack's own `url_verification` challenge, so Event Subscriptions can't even be enabled (see `docs/setup.md` step 10). With a *wrong* (not blank) secret, every request instead gets `401 invalid signature`. |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys | The Claude adapter (`src/llm/claude.ts`) throws `LlmConfigurationError` on every call. For `compose`/`polish`, this is caught by the guard envelope and downgrades to the deterministic fallback (a reply/polish is still produced — see "Reading `usage_log`" below). Reference authoring (`ref new`/`ref refresh`) has **no fallback**: per issue #17's design, an authoring failure is reported to the operator, not silently downgraded, because there is no deterministic way to invent a reference. |
| `STASH_READ_TOKEN` | Per-stash read token supplied by the stash service (`zhs_...`); mint it without an expiry by omitting both `expiresAt` and `ttlSeconds`. Use a per-stash token, never an admin token. Configure it only in the final, owner-only stash provisioning step. | Stash-backed reads cannot authenticate. |
| `STASH_WRITE_TOKEN` | Per-stash write token supplied by the stash service (`zhs_...`); mint it without an expiry by omitting both `expiresAt` and `ttlSeconds`. Use a per-stash token, never an admin token. Configure it only in the final, owner-only stash provisioning step. | Stash-backed writes cannot authenticate. |
| `GITHUB_TOKEN` | A fine-grained PAT created for this repository only; **Contents: Read and write** + **Pull requests: Read and write**, and nothing else. Configure with `npx wrangler secret put GITHUB_TOKEN` only after the repository-private release gate in `docs/setup.md`. | The GitHub fallback fails before any GitHub request. Do not set this while the repository is public. Rotate it immediately if it is exposed; the policy loop does not log the token or upstream response bodies. |

### Vars (`wrangler.jsonc`'s `vars` block, plain values, safe to commit — none of these are credentials)

| Name | Where it comes from | What breaks without it |
|---|---|---|
| `SLACK_BOT_USER_ID` | `auth.test` with the bot token (`docs/setup.md` step 4) — the bot's own Slack user id | `src/slack/events.ts` compares every mention's `event.user` against this to reject the bot's own messages and prevent a self-trigger loop. Left blank, the check simply never matches (no known message has an empty user id), so the practical risk today is low — but any future feature that has the bot post something Slack treats as a mention-worthy message would loop indefinitely. Set it correctly. |
| `SLACK_ALLOWED_CHANNEL_IDS` | Comma-separated Slack channel ids (`parseCommaSeparated`, `src/env.ts`) | **Left empty, the bot acts in every channel it's invited to** — this is the documented default, not a misconfiguration (`src/slack/events.ts` `isAllowedChannel`). Set it if you want to restrict the bot to specific channels. |
| `SLACK_ADMIN_USER_IDS` | Comma-separated Slack user ids | **Left empty, nobody can run `ref new`/`ref refresh`/`ref restore` or click an approve/reject/create-reference button** — every one of those gets "この操作には管理者権限が必要です" (`isAdminUser`, `src/slack/commands.ts`). Reference management is effectively disabled without this set. |
| `COMPOSE_PROVIDER` | `"workers-ai"` \| `"claude"` | Selects the provider for assembling a reply's resource section. An unrecognized value logs a warning and **fails open to `"workers-ai"`** (`src/reply/compose.ts` `selectComposeProvider`) — a typo here degrades silently rather than breaking replies. |
| `AUTHOR_PROVIDER` | `"workers-ai"` \| `"claude"` | Selects the provider for `ref new`/`ref refresh`. An unrecognized value logs a warning and falls back to Claude. |
| `POLISH_PROVIDER` | `"workers-ai"` \| `"claude"` | Selects the provider for `@bot polish`. Same fail-open behavior. |
| `POLICY_PROVIDER` | Blank/absent or `"claude"` \| `"workers-ai"` | Selects the policy-document editor. Blank/absent defaults to Claude; an unrecognized value logs a warning and falls back to Claude. This chooses the adapter only, not the model tier. |
| `CLAUDE_MODEL` | An Anthropic model id, e.g. `claude-sonnet-5` | Blank (the shipped default) falls back to `src/llm/claude.ts`'s `DEFAULT_CLAUDE_MODEL` (`claude-haiku-4-5`) — the one place that default lives. Set this to raise the tier without a code change. |
| `POLICY_MODEL` | An Anthropic model id for policy edits | Blank/absent falls back to `CLAUDE_MODEL`, then to the Claude adapter's `DEFAULT_CLAUDE_MODEL`. It is ignored when `POLICY_PROVIDER=workers-ai`. |
| `SITE_API_BASE` | `https://takazudomodular.com` (shipped default — leave as-is in production) | Base URL for the reference-authoring catalog/product-page/search fetches (`GET {SITE_API_BASE}/api/products`, `/api/search`, and product detail paths). A bad or unreachable site produces an authoring refusal; it never invents a reference. |
| `STASH_BASE_URL` | Operator-set HTTPS origin for the provisioned stash service | Stash requests cannot reach the configured service. Leave blank until the final stash provisioning step. |
| `STASH_NAME` | Operator-set name of the stash this Worker uses | Stash requests cannot select their target. Leave blank until the final stash provisioning step. |
| `GITHUB_REPO` | The private repository in `owner/name` form, for example `zudolab/zmod-bot` | Missing or malformed configuration stops the GitHub fallback before any GitHub request. Set it only after the private-repository release gate. |

Provisioning is deliberately last. When the owner eventually provisions the stash, record the
Cloudflare account that hosts it, the exact stash name, and the base URL in the operator's private
deployment record; the Worker uses only `STASH_BASE_URL` and `STASH_NAME` at runtime. The stash route
uses one dedicated policy document, read/write per-stash tokens, no admin token, and no expiry fields.
The repository may remain public for this route. Real stash behavior, convergence, and latency have
not been verified; keep the owner-only `[DEFERRED — BLOCKED ON PROVISIONING]` item open (issue #60).

### Bindings (`wrangler.jsonc`, not secrets or vars)

| Binding | Declared in | Notes |
|---|---|---|
| `DB` | `d1_databases` | The D1 database created in `docs/setup.md` step 1. |
| `AI` | `ai` | Workers AI. **Deliberately no `gateway: { id }` option** — see "AI Gateway is deliberately not wired up" below. |

## Policy routes

An administrator's policy command has two deliberately separate routes. The ordinary
`@bot policy <変更内容>` command selects the stash route only when both `STASH_BASE_URL` and
`STASH_WRITE_TOKEN` are non-empty. If either selector is empty, that ordinary change request uses the
retained GitHub fallback. `@bot policy history` and `@bot policy rollback <version>` are stash-only:
when their stash write configuration is absent they refuse in Japanese and are never reinterpreted as
GitHub edits.

| | Stash route | GitHub fallback |
|---|---|---|
| Document and credentials | One dedicated stash document, `policy/reply-guidance.md`; read/write-only per-stash tokens scoped to that stash, with no admin token and no expiry fields. | The repository's policy document, accessed with the repository-scoped `GITHUB_TOKEN` PAT. |
| Repository posture | The repository may remain public because policy content stays in the dedicated stash. | Keep the repository private before configuring the PAT or enabling policy edits. |
| Review and activation | Candidate is shown as the actual stash diff inline in Slack; it becomes live only after an administrator approves it. | Candidate is reviewed in a GitHub pull request; it becomes live only after merge and deployment. |
| History and rollback | `policy history` shows bounded version metadata. `policy rollback` uses the current `expectedVersion` and creates a new version pointing at the selected old content. | Review and merge a `git revert`, then deploy; GitHub history remains the rollback record. |

### Stash route: live-on-approve review

The stash path is an admin-only, stash-only flow. Its dedicated stash contains only
`policy/reply-guidance.md`, so the blast radius is limited to mutable policy wording and cannot
mutate product references, source, migrations, or generated artifacts. Before the editor runs, the
worker acquires the exact-path proposal lease, scans every `status=all` change-set page, and locally
filters the computed open set. A live proposal by another owner or an existing open policy change
set is a refusal; it does not create another editor run or change set. The named bounds are a
90-second lease, a 15-second scan, a 5-second bound for each stash operation, and the existing
30-second editor bound. Expired leases can be reclaimed, but a stale generation cannot continue to
create a change set.

The editor receives the authoritative stash document and its version. The existing policy validator
still protects the immutable header, required headings, byte limit, URLs, customer data, and fixed
reply clauses. A valid candidate creates exactly one `policy/reply-guidance.md` put entry with the
exact `baseVersion`, Markdown content type, a stable `policy-job-<jobId>` key, and an explicit UTC
`now + 72 hours` expiry. The worker then fetches the bounded remote diff and posts that diff inline in
Slack with approve/reject buttons. The buttons carry only an opaque change-set id.

Approval is the live activation point. The first decision is fenced durably; competing clicks do not
apply twice. A remote conflict is terminal for that approval and permits only one later reject epoch;
other terminal outcomes close the decision permanently. Successful approval or rollback invalidates
the live-policy cache. A rollback never rewrites history: it creates a new version whose content
points back to the selected old version and is fenced by the head `expectedVersion`.

The live reader converges within the same isolate's 30-second cache window, bounds a stash read at
1,500 ms, and falls back in order to D1's last-known-good document and then the compiled policy. A
policy read or stash outage does not gate `/health`; health is not a policy health gate. The shared
stash limit is 60 writes per 60 seconds for non-admin stash tokens, and policy proposals have a
separate cap of 20 per UTC day. These are implementation contracts, not evidence of a live test.

Provisioning this route remains the final, owner-only setup action. No stash has been provisioned or
live-verified in this run; do not describe it as deployed, stable, latency-tested, or smoke-tested.
The open `[DEFERRED — BLOCKED ON PROVISIONING]` item (issue #60) remains owner-only.

## GitHub fallback policy PR loop

The fallback is an admin-only, review-first path. It does not edit the running Worker or merge
anything automatically. It is selected for an ordinary policy change only when the stash endpoint or
write token is empty:

1. An administrator mentions `@bot policy <change request>` in Slack. A non-admin receives an
   immediate refusal and no receipt or job is created. An admin request is written as a Slack event
   receipt and `policy_update` job in one D1 batch before Slack receives `200`.
2. The delivery pass (immediately after the acknowledgement when possible, and from the five-minute
   cron sweep) reads `policy/reply-guidance.md` from the repository's default branch.
3. The configured policy editor receives the complete document and operator request. The provider
   fallback chain is `POLICY_PROVIDER` (blank/absent → Claude) then, for Claude, `POLICY_MODEL` →
   `CLAUDE_MODEL` → the adapter default.
4. The candidate must preserve the immutable header and required headings, fit the UTF-8 size cap,
   contain no code fence/control characters/new URL/fixed customer-reply clause, and be a complete
   document. A rejected candidate posts a reason token to Slack and makes **zero GitHub writes**.
5. A valid candidate is written only to `policy-update/job-<job-id>` and only at
   `policy/reply-guidance.md`; the client then opens a pull request. The Slack reply contains the
   pull-request link. Re-running a failed job discovers the existing branch/content/PR and converges
   instead of creating another PR.

There is a single-open-policy-PR rule across all GitHub fallback policy jobs. If another `policy-update/*` pull
request is open, the new request makes no branch, content, or PR mutation and posts the existing PR
link as a conflict. Review and merge the open PR first, or clear the stale PR as described below.

### Review checklist before merge

The reviewer should confirm all of the following before merging a policy PR:

- The diff contains only `policy/reply-guidance.md`; no workflow, source, migration, generated file,
  or unrelated product-reference changes are present.
- The immutable HTML-comment header is byte-for-byte unchanged and the required headings remain in
  their original order.
- No URL was added or changed, no customer data appears, and no fixed greeting/shipping/arrival/
  evaluation/DIY/Discord/closing clause was copied into the document.
- The new guidance reads as production copy for Japanese customer replies, not as instructions to
  an operator or a model-debugging transcript.
- The PR title/body contain no unescaped Slack/GitHub mentions that could notify unrelated people.

After review, merge the PR into the repository's default branch. A deploy then runs
`pnpm policy:build` and embeds the merged Markdown into the Worker; the generated
`src/policy/generated.ts` file is intentionally ignored and must not be committed. The change is
not live until that deployment succeeds.

### Rollback and stale-PR recovery

To roll back a bad policy that has already merged, use GitHub's normal history rather than editing
the generated file:

```bash
git revert <merged-policy-commit>
git push origin <default-branch>
```

The deploy workflow rebuilds the policy and makes the reverted document live. A revert is itself a
reviewable commit; do not force-push or hand-edit `src/policy/generated.ts`.

If a bot PR is stale (for example, its job died after the branch or PR was created), inspect the
open PR list and the job row first. Close the stale `policy-update/*` PR, delete its bot branch in
GitHub, and submit the policy request again after confirming no other policy PR is open. Deleting
the branch is important: it prevents a new job from inheriting an old, reviewed-against-the-wrong-
base branch. If the original job is still `failed` and its backoff has elapsed, a cron retry is safe
and will reuse the existing PR instead; do not create a second request while that retry is pending.

### Policy-vs-engine boundary and future escalation

The document is for mutable wording guidance: Japanese tone/register, paragraph/link presentation,
and small additions under the existing headings. It cannot change fixed reply clauses, product
reference facts/URLs, resolver or command grammar, arrival/shipping logic, validation rails, or any
external API behavior. Those changes require a normal code PR with tests and review.

If an operator asks for a behavior the policy document cannot express, do not try to smuggle code
instructions or URLs into the policy. Open a GitHub issue describing the desired behavior, affected
examples, and acceptance checks; a coding agent can then implement it in a normal branch/PR. This
issue-escalation path is future operational guidance only — the bot deliberately does not create or
assign coding-agent issues today.

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

**GitHub PAT**: generate a replacement fine-grained token with the same repository-only scope
(Contents and Pull requests read/write), run `npx wrangler secret put GITHUB_TOKEN`, and revoke the
old token from GitHub after a policy smoke test succeeds. Keep the repository private throughout;
never temporarily broaden the token to work around a failed request.

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

## Reference authoring

`ref new` (write a brand-new reference from scratch) and `ref refresh` (fold new videos and guides
into an existing one) are implemented, along with the **"create a reference" button** on a
resolver-miss reply — clicking it (admin only) runs the same pipeline, so a first-time purchase does
not need a separate admin ritual. `AUTHOR_PROVIDER` and `SITE_API_BASE` are read by this path.

Nothing here writes to `product_refs` directly. Authoring produces a `ref_drafts` row and a preview;
an admin clicking approve is what commits it, and the approve path re-parses the body and re-derives
its aliases at that point.

**A guard trip writes nothing and says why.** Unlike the reply and polish paths, authoring has **no
deterministic fallback** — there is no way to invent a reference that does not exist, and a
half-invented one is worse than none. The operator sees the reason token (`url_mismatch`,
`schema_invalid`, `truncated`, `budget_exceeded`, `provider_error`), a mechanical detail, and an
explicit 「何も書き込んでいません」. The remedy is always to re-run or hand-write.

**Every preview states a coverage caveat, and it is not boilerplate.** No endpoint exposes
manuals-per-product or guide-series-per-product (both are SSR-only on the website), so the human
reviewing the draft is the only check on whether the resource list is complete. The preview also
flags a degraded source, a truncated read, refused aliases, a changed `product_url`, and that
`category` was the model's choice — that last one matters more than it looks, because `general` vs
`small` selects the ヤマト or ネコポス shipping line in every reply the reference later produces.

Operational limits:

- **Budget: 50 author calls per UTC day**, counted under task `author` — a separate counter from
  compose and polish. A budget trip is recorded in `usage_log` even though no provider call happened.
- **`AUTHOR_DEADLINE_MS` is 60s and unmeasured.** The smoke test should record real end-to-end time
  and correct it.
- **Drafts expire after 30 minutes.** An expired preview must be re-run, not clicked.

One known limitation, deliberate rather than an oversight:

- **A refresh that needs a category change is a dead end today.** The draft check refuses any change
  to `category`, and if the catalog has since gained a DIY variant the constraint demands one — so
  both fire and nothing can be drafted. There is no `ref edit`; the operator's only route is a
  manual body change.

After approving an authored reference, the bot now automatically posts the reply the originating
mention asked for, into that mention's own thread — see "Resume after reference authoring is
at-most-once" under "Thread context inheritance" below for exactly what that does and does not
guarantee.

## Thread context inheritance

A follow-up mention in the same Slack thread that carries only modifiers or an arrival date and
names no product (`@bot --discord`, `@bot 明日`) reuses the product, variant, and arrival date the
thread already resolved, instead of making the operator retype the product name every turn
(epic #22). Implementation: `src/jobs/thread-context.ts` (the lookup, shared by the delivery path
and the picker-click path so they cannot disagree), `src/jobs/worker.ts` `finishResolvedReply` (what
gets recorded and how it's applied). The operator-facing shape is in `@bot help`'s usage text.

What carries forward, and what does not:

- **Product slug and built/kit variant** carry forward unchanged.
- **Arrival date** carries forward only when the follow-up names none of its own — naming one (e.g.
  `@bot --discord 明後日`) overrides the inherited one.
- **Flags (`--discord` / `--direct`) never accumulate.** Each mention's flags come wholly from that
  mention's own text, so `@bot --discord` on turn 3 of a thread turns discord on and direct off
  regardless of what turn 2 carried.
- **A mention that names a product always resolves fresh**, inheriting nothing, even mid-thread.

Only the most recent prior **reply**-kind job in the same `(channel, thread_ts)` that resolved a
product is consulted — a `polish` or `ref` job in the same thread is never mistaken for reply
context, and a top-level mention (no `thread_ts`) is always alone in a thread of its own, so it
never inherits anything.

**7-day degradation.** A resolved thread's memory lives in `jobs.resolved_context`, and `done` jobs
are deleted 7 days after completion by the retention sweep (`src/jobs/retention.ts:40` — see
"Retention" above). A modifier-only follow-up in a thread whose last resolved reply has aged out
therefore finds nothing to inherit and silently degrades to the bot's pre-inheritance behaviour: the
「製品名またはURLを指定してください。」error plus the usage text, exactly as if the thread had never
resolved anything. This is not a bug — an old thread simply stops being conversational, and the
recovery is to mention the product by name again.

**Resume after reference authoring is at-most-once.** When a mention resolves to no reference and an
admin authors one and approves the draft, the bot posts the reply that mention originally asked for
into the mention's own thread (issue #26, `resumeOriginReply` in `src/slack/interactions.ts`) — the
operator no longer needs to mention the product again. This delivery has **no retry**:
`commitRefDraft` stamps the draft's `consumed_at` inside the same `db.batch()` as the reference
write, so a Worker crash or a terminal Slack failure *after* that commit loses the reply with
nothing left to retry it — a repeat click on approve refuses outright, because `consumed_at` is
already stamped. The operator's recovery is the same one-line fix as any other lost delivery:
mention the product again, which now resolves to a `match` and produces a normal reply.

## AI Gateway is deliberately not wired up

`wrangler.jsonc`'s `ai` binding has no `gateway: { id }` option, and `src/llm/workers-ai.ts` passes
nothing but `{ signal }` in the options it hands to `env.AI.run`. **Do not add a named gateway id
here before provisioning that gateway in the Cloudflare dashboard.** An AI Gateway id that doesn't
exist yet makes `env.AI.run` fail with Cloudflare error 2001 on **every** call — not a warning, not
a degraded mode, every single request. This exact mistake dark-shipped a sibling project. If you
want AI Gateway's logging/caching/rate-limiting later: create the gateway in the dashboard first,
confirm it exists, *then* add `gateway: { id: "<name>" }` to `wrangler.jsonc`'s `ai` block and
redeploy.
