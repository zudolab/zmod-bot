# Smoke test

This is an **owner-only live verification procedure**, not a record that a deployment or smoke test
has happened. The checks need a live Worker with real credentials — nothing here can run against
Miniflare or a fake `AI`/`fetch`. When a live deployment exists, use the applicable checks after every
deploy that touches `src/llm/**`, `src/reply/**`, or `src/slack/verify.ts`/`src/slack/events.ts`, and
as part of first-time setup (`docs/setup.md` step 12 onward).

No stash has been provisioned, no real policy request has been run, and no stash latency or stability
claim is made by this document. The stash checks below remain `[DEFERRED — BLOCKED ON PROVISIONING]`
and owner-only (issue #60). Do not tick them or treat the integrated unit suite as live evidence.

**Every guard test in this repo's unit suite uses a fake `AI` binding.** `pnpm test` proves the
guard *logic* is correct against whatever a fake provider is told to return. It has never once
proven that a real Workers AI completion actually satisfies that logic, that the deadlines are
sized correctly against real latency, or that cancellation actually cancels anything. That's what
this document is for.

## 1. Signature and delivery — `/slack/events`

Requires `SLACK_SIGNING_SECRET`'s real value in your shell (not committed anywhere — pull it from
wherever you stored it in `docs/setup.md` step 3/5).

### Unsigned request → `401`

```bash
curl -i -X POST "https://{worker}/slack/events" \
  -H "Content-Type: application/json" \
  -d '{"type":"event_callback"}'
```

Expect `HTTP/1.1 401` — no `X-Slack-Request-Timestamp`/`X-Slack-Signature` headers at all, so
`verifySlackSignature` rejects it before any JSON is even parsed.

### Signed `url_verification` → succeeds

```bash
SIGNING_SECRET="paste-the-real-value-here"
TS=$(date +%s)
BODY='{"type":"url_verification","challenge":"smoke-test-challenge"}'
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" -hex | sed 's/^.* //')"

curl -i -X POST "https://{worker}/slack/events" \
  -H "Content-Type: application/json" \
  -H "X-Slack-Request-Timestamp: $TS" \
  -H "X-Slack-Signature: $SIG" \
  -d "$BODY"
```

Expect `HTTP/1.1 200` with body `{"challenge":"smoke-test-challenge"}`. This is exactly what Slack
does the instant you enable Event Subscriptions — see why this must pass before `docs/setup.md`
step 10, not before it.

### A redelivered event posts once

Slack retries a delivery it didn't get a fast `200` for, using the **same `event_id`**. Simulate one
locally: sign and POST the same `event_callback`/`app_mention` body twice within the 300-second
replay window `verifySlackSignature` allows.

```bash
EVENT_ID="Ev_smoketest_$(date +%s)"
BODY=$(cat <<JSON
{"type":"event_callback","event_id":"$EVENT_ID","event":{"type":"app_mention","event_ts":"$TS.000001","channel":"C_YOUR_ALLOWED_CHANNEL","user":"U_YOUR_USER_ID","text":"<@$SLACK_BOT_USER_ID> help","ts":"$TS.000001"}}
JSON
)
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" -hex | sed 's/^.* //')"

# Send it twice, identically.
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://{worker}/slack/events" \
  -H "Content-Type: application/json" -H "X-Slack-Request-Timestamp: $TS" -H "X-Slack-Signature: $SIG" -d "$BODY"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://{worker}/slack/events" \
  -H "Content-Type: application/json" -H "X-Slack-Request-Timestamp: $TS" -H "X-Slack-Signature: $SIG" -d "$BODY"
```

Both requests return `200`. Then confirm only one `jobs` row exists and only one Slack message
went out:

```bash
npx wrangler d1 execute zmod-bot --remote --command \
  "SELECT COUNT(*) FROM jobs WHERE event_id = '$EVENT_ID';"   # expect 1
```

and check the target Slack channel for exactly one "使い方" reply, not two. This is
`slack_event_receipts`'s `UNIQUE(event_id)` + the single `db.batch()` in `recordIncomingEvent`
doing its job — the second POST's insert conflicts, returns `null`, and no second job is ever
created.

## 2. Policy routes — planned owner-only checks (not executed)

The two policy routes are checked side by side only after their respective prerequisites are complete.
The procedures in this section are not evidence that either route has succeeded. The command has no
`--dry-run` flag; the GitHub procedure below creates a review-only PR that you deliberately do **not**
merge.

### Non-admin refusal

From a Slack user who is not in `SLACK_ADMIN_USER_IDS`, mention the bot in an allowed channel:

```
@zmod-bot policy 返信を少し簡潔にする
```

Expect a threaded reply saying `この操作には管理者権限が必要です。`. Confirm there is no new
`policy_update` job, no stash lease/change set, and no GitHub branch, commit, or pull request. This
refusal happens before the durable job write; a failed refusal post is logged and does not create
remote state.

### GitHub fallback admin dry run

As an admin, make one small, reversible request:

```
@zmod-bot policy 必要な場合のみ、簡潔な補足を加えます。
```

Expect a `200` Slack acknowledgement, then a reply containing a GitHub pull-request URL. Verify
that the PR branch is named `policy-update/job-<id>`, its diff contains only
`policy/reply-guidance.md`, and no merge has happened. If the editor returns `変更なし`, the bot
posts `変更なしと判断しました。` and makes no GitHub write; retry with a wording request only if
you need to exercise PR creation. Use the review checklist in `docs/operations.md`, then close and
delete this smoke-test branch/PR without merging it.

### Stash route — deferred until owner-only provisioning

`[DEFERRED — BLOCKED ON PROVISIONING]` No stash request has been run. Provision one dedicated stash
document at `policy/reply-guidance.md`, record its exact name, base URL, and hosting Cloudflare
account, and configure only per-stash `STASH_READ_TOKEN` and `STASH_WRITE_TOKEN` without expiry
fields (`expiresAt`/`ttlSeconds` omitted). Never use an admin token. The repository may remain public
for this route; its policy content does not go through GitHub.

After that owner-only prerequisite, use an admin mention such as:

```
@zmod-bot policy 必要な場合のみ、簡潔な補足を加えます。
```

Expect the actual stash diff to appear inline in Slack with approve/reject buttons, and no GitHub
branch, commit, or pull request. Approval is the live activation point. Verify that competing clicks
are fenced so only the first decision applies, that a remote approval conflict is terminal with only
one later reject available, and that other terminal outcomes stay closed. Then, using the stash-only
commands, verify that `policy history` renders bounded safe version metadata and that
`policy rollback <version>` reads the authoritative head, uses that head as `expectedVersion`, and
creates a new version pointing to the selected old content without rewriting history.

Also verify the documented safety bounds: a 30-second isolate cache, a 1,500 ms live read deadline,
D1 last-known-good fallback followed by the compiled policy floor, and no policy health gating of
`/health`. The shared non-admin stash limit is 60 writes per 60 seconds; policy proposals are capped
at 20 per UTC day. None of these stash checks has been run yet.

## 3. A real provider call, end to end (planned; not yet run)

This is a planned check the guard suite makes necessary but cannot make sufficient by itself: **a real
Llama completion, run through the exact same guards a fake completion is tested against.** It is not
live evidence from this worktree.

In the real workspace, `@bot <product>` for:

- **`zudo-rail`** — has two literal blocks the model must reproduce byte-exact (a Lite-variant
  renewal notice and a fragility notice), one of them variant-gated (only appears for a "Lite"
  purchase). Try both `@bot zudo-rail` and `@bot zudo-rail lite 60 set1` to exercise both paths.
- **`oxi-one`** — a multi-section reference (`Manual`, `Guides`, `Extra Resources`) whose last
  section carries a `Separator intro:` — the model has to both assemble three sections' worth of
  links and prose *and* emit the `===` separator line above the one that needs it
  (`src/reply/compose.ts`'s prompt instructions, `RESOURCE_SEPARATOR`).

For each, confirm in the posted reply:

- Every URL that appears in the reference's resource section appears in the reply, and no others
  (an invented or dropped link is exactly what `checkOutputGuard`'s `url_mismatch` exists to catch —
  seeing it ship means the guard didn't trip when it should have, which is worth investigating on
  its own).
- The literal blocks (zudo-rail's two notices) are reproduced **character for character**, not
  paraphrased.
- None of the fixed clauses (greeting, shipping line, evaluation clause, closing) were restated by
  the model — they should appear exactly once, from the deterministic skeleton.

**If a real completion trips `schema_invalid` or `url_mismatch` more than occasionally, the fix is
in the prompt (`src/reply/compose.ts`'s instructions to the model), not in the guard.** Loosening
`checkOutputGuard` to make this smoke test pass would defeat the one thing standing between a model
hallucination and a URL a customer clicks — see `CLAUDE.md`. Check `usage_log` (`docs/operations.md`
→ "Reading `usage_log`") for the `fallback` reason on any reply that used the deterministic path
instead, and read the *n*th real Worker log line via `wrangler tail` for the mechanical `detail`.

### 8-second compose deadline against real latency

`COMPOSE_DEADLINE_MS` is a fixed 8 seconds (`src/llm/guards.ts`), sized for a small completion
(`COMPOSE_MAX_TOKENS = 2048`, and the longest reference in the corpus is 1,309 characters). Run the
`oxi-one` case above a handful of times and check `usage_log.tokens_out` for those rows — if real
calls are routinely landing close to 2048 output tokens and the deadline is tripping (`fallback =
'timeout'`) on ordinary, non-degraded calls, the deadline is too tight for real-world latency and
needs raising. A deadline that fails the happy path is worse than no deadline.

### Real token throughput — correct `ASSUMED_TOKENS_PER_SECOND`

`src/reply/polish.ts`'s `ASSUMED_TOKENS_PER_SECOND = 25` is an **explicit, unmeasured** placeholder
that sets polish's deadline (`computePolishDeadlineMs`) — the module comment says so outright.
Measure the real rate:

```bash
npx wrangler d1 execute zmod-bot --remote --command \
  "SELECT tokens_out, created_at FROM usage_log WHERE task = 'polish' AND fallback IS NULL ORDER BY created_at DESC LIMIT 20;"
```

Pair `tokens_out` against the call's actual wall-clock duration from `wrangler tail` (the
`logLlmCall` line for that request) to get tokens/second for a handful of real `@bot polish` calls,
then update the constant in `src/reply/polish.ts` to the measured value (rounding down slightly is
the safe direction — this constant sizes a deadline, and overestimating throughput makes the
deadline too tight, the same failure mode as the compose deadline above).

### Does `AbortController` actually cancel a Workers AI call?

`src/llm/guards.ts`'s `withDeadline` races the provider call against the deadline and, on losing
that race, calls `controller.abort()` on the `AbortSignal` passed into `env.AI.run` (`src/llm/
workers-ai.ts`: `req.signal ? { signal: req.signal } : undefined`). Both adapters accept the signal;
whether Workers AI actually **honours** it — stops billing/processing the call — is unverified.

There's no clean way to observe this from the Worker side (an aborted call just means `withDeadline`
stopped waiting; the in-flight request either dies server-side or keeps running invisibly). Check
instead from the Cloudflare dashboard's Workers AI analytics/usage page for the account (exact menu
path varies by dashboard version — look for Workers AI request count and duration), a day or two
after deliberately forcing a few
timeouts — the easiest way to force one is temporarily lowering `COMPOSE_DEADLINE_MS` in a scratch
deploy to something an ordinary call can't beat (e.g. 50ms), running a handful of `@bot` mentions,
then reverting. If the dashboard's request count/duration for that window matches "ran to
completion" rather than "cut short at ~50ms", the abort is not actually cancelling anything
server-side — latency is still bounded by the deadline (the Worker stops waiting either way), but
the call is still being billed. Worth knowing before it shows up on an invoice, not after.

## 4. Byte-exactness — the one thing no unit test can prove (planned; not yet run)

**What the human copies out of Slack must equal what the generator produced.** The reply is pasted
verbatim into Mercari Shops — any drift here (a Slack markdown escape, a Block Kit rendering quirk,
a trailing-whitespace difference) ships straight to a customer.

The system deliberately never persists the composed reply text anywhere — not in `jobs` (`raw_text`
is the *input* mention, not the reply), not in `usage_log`, not in any log line (`CLAUDE.md`: "Never
log a prompt body, a reference body, polish input, or a credential"). That's correct production
behavior, and it also means this specific check has no shortcut: the only way to get a second copy
of the exact text that was sent, to diff against what came out of Slack, is a **one-off, local-only,
never-committed** capture at the moment you run this test.

Capture both sides from **the same single reply**, not two separate runs — the LLM-composed
section is not guaranteed byte-identical between two independent calls, so diffing a *second*
generation against Slack would conflate "did Slack mangle it" with "did the model phrase it
differently the second time." Only the first question is what this check is for.

1. In a scratch local checkout on the deployed Worker's code (never a branch you intend to push),
   temporarily add `console.error(composed.text)` right after the `composeReply` call in
   `src/jobs/worker.ts` (the function that builds a `reply` job's payload — search for
   `buildReplyMessagePayload`), and deploy that one-line change to a **scratch** Worker — never
   production, and never with `pnpm dev`'s output going anywhere but your own terminal.
2. In the real workspace, run **one** `@bot <product>` mention against that scratch Worker, for a
   product with a plain, no-arrival-date-needed category (a `small` product, e.g. `@bot zudo-rail`)
   so there's no interactive picker in the way.
3. Read the printed text back out of `wrangler tail` (or your terminal, if run via `pnpm dev`) for
   *that exact mention* and save it as `/tmp/from-generator.txt`. **Revert the temporary line and
   redeploy immediately** — it must never reach a commit and must never run against real customer
   traffic.
4. **Copy the reply text directly out of Slack** for that same message (select the message, copy) —
   not screenshot it, not retype it. Paste it into `/tmp/from-slack.txt`.
5. `diff /tmp/from-slack.txt /tmp/from-generator.txt` — expect **zero** output.

This is why the reply is posted as Block Kit `rich_text_preformatted` rather than `mrkdwn`
(`CLAUDE.md`) — `mrkdwn` round-trips `&`/`<`/`>` through HTML entities, which is exactly the kind of
mismatch this check exists to catch. If the diff is non-empty, that's the bug to chase, not this
check.
