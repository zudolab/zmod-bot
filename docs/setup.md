# Setup runbook

First-time deployment of zmod-bot. **Follow the numbered order** — several steps fail, or fail
silently, if done out of sequence. Where order matters, the step says why.

You will need: a Cloudflare account with Workers AI and D1 available, and permission to create a
Slack app in the target workspace.

## 1. Create the D1 database

```bash
npx wrangler login          # if you haven't already
npx wrangler d1 create zmod-bot
```

This prints a `database_id`. Open `wrangler.jsonc` and paste it in, replacing the placeholder:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "zmod-bot",
    "database_id": "REPLACE_WITH_D1_DATABASE_ID"   // <- paste the real id here
  }
]
```

`database_name` must stay `"zmod-bot"` — the deploy workflow's migrations step
(`npx wrangler d1 migrations apply zmod-bot --remote`) refers to the database by this name, not by
the `binding` name or the Worker's name (they happen to match today, but only one of the three is
what that command actually reads).

Commit this change. A D1 `database_id` is an opaque identifier, not a credential — it is fine to
commit even though this repo is public (see `CLAUDE.md` "Setup state").

## 2. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app
manifest** → pick the target workspace.

**Do not paste `docs/slack-manifest.yml` in as-is at this step.** Slack validates
`event_subscriptions.request_url` and `interactivity.request_url` live, at manifest-apply time —
and your Worker doesn't exist yet, so that validation will fail and the import will be rejected.
Paste in only the `display_information` and `oauth_config` sections (bot user + scopes). You'll add
Event Subscriptions and Interactivity back in step 10–11, once the Worker is live and those URLs
actually resolve.

(If you'd rather not hand-edit the manifest, just create the app manually: **Create New App** →
**From scratch**, name it, then do steps 3–4 below through the regular UI instead of a manifest
import. Either path ends up in the same place.)

## 3. Add scopes and install the app

Under **OAuth & Permissions** → **Bot Token Scopes**, add:

- `app_mentions:read` — receive `app_mention` events
- `chat:write` — post replies and ephemeral admin-only messages

Click **Install to Workspace** (top of the OAuth & Permissions page) and approve.

Copy two values now, you'll need them in step 5:

- **Bot User OAuth Token** (`xoxb-…`) — OAuth & Permissions page, after install.
- **Signing Secret** — Basic Information page → App Credentials. This is what
  `src/slack/verify.ts` HMAC-verifies every incoming request against; without it every request from
  Slack gets a `401`.

## 4. Get the bot's own Slack user id

The bot must recognize and ignore its own messages, or an `app_mention` the bot itself posts (it
never does today, but a future feature might) would trigger a loop. `src/slack/events.ts` checks
`event.user === env.SLACK_BOT_USER_ID` — you need that id before step 6.

```bash
curl -X POST https://slack.com/api/auth.test \
  -H "Authorization: Bearer xoxb-your-bot-token"
```

The response's `user_id` field is the value for `SLACK_BOT_USER_ID`.

## 5. Set the secrets

Three secrets, deployed via `wrangler secret put` (never committed — `wrangler.jsonc`'s
`secrets.required` lists only the *names*):

```bash
npx wrangler secret put SLACK_BOT_TOKEN        # the xoxb- token from step 3
npx wrangler secret put SLACK_SIGNING_SECRET   # the signing secret from step 3
npx wrangler secret put ANTHROPIC_API_KEY      # from console.anthropic.com
```

For local dev, copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in the same three
values there instead.

## 6. Set the vars

Edit the `vars` block of `wrangler.jsonc`:

| Var | Value |
|---|---|
| `SLACK_BOT_USER_ID` | The id from step 4 |
| `SLACK_ALLOWED_CHANNEL_IDS` | Comma-separated Slack channel ids the bot may act in. **Leave empty to allow every channel it's invited to** — see `src/slack/events.ts` `isAllowedChannel`. |
| `SLACK_ADMIN_USER_IDS` | Comma-separated Slack user ids allowed to run `ref new`/`refresh`/`restore` or click an approve/reject button. Anyone not listed gets a polite refusal, not a crash. |

The remaining vars (`COMPOSE_PROVIDER`, `AUTHOR_PROVIDER`, `POLISH_PROVIDER`, `CLAUDE_MODEL`,
`SITE_API_BASE`) already ship with working defaults and don't need to change for a first deploy.
Full meaning of every var: `docs/operations.md`.

Commit the `vars` change — see `docs/operations.md` for which values are and aren't safe to commit.

## 7. Add GitHub Actions repo secrets

The deploy workflow (`.github/workflows/deploy.yml`) needs two secrets, set under the repo's
**Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — from the Cloudflare dashboard's **My Profile → API Tokens → Create
  Token**. The "Edit Cloudflare Workers" template covers what this workflow needs (Workers Scripts
  edit + D1 edit + account read); a custom token works too as long as it can deploy a Worker and run
  `wrangler d1 migrations apply --remote` against this account. Scope it to the specific account,
  not "All accounts".
- `CLOUDFLARE_ACCOUNT_ID` — the account id from the Cloudflare dashboard's right sidebar.

## 8. Deploy

Push to `main` (or run `workflow_dispatch` on the Deploy workflow). CI runs `pnpm typecheck`,
`pnpm test`, applies every migration under `migrations/` to the **remote** D1 database — including
`0002_seed_product_refs.sql`, the 34-reference seed — and then deploys the Worker.

**There is no manual seed step.** Every `INSERT` in the seed migration is `ON CONFLICT DO NOTHING`,
so it's safe even if it somehow ran twice.

> **If you deploy manually with `pnpm deploy` instead of pushing to `main`:** that script is a bare
> `wrangler deploy` — it does **not** apply migrations. Run
> `npx wrangler d1 migrations apply zmod-bot --remote` yourself first, or `/health` will report a
> connectable-but-empty database (`refCount: 0`) after you deploy. Pushing to `main` is the path
> that does both automatically and is what production actually uses; prefer it.

Note the URL `wrangler deploy` prints (or find it under **Workers & Pages** in the dashboard) — it's
`https://zmod-bot.<your-workers-subdomain>.workers.dev` unless you've attached a custom domain.
The rest of this doc calls it `{worker}`.

## 9. Verify the deploy

```bash
curl https://{worker}/health
```

Expect `{"ok":true,"migrations":[...],"refCount":34}`. `refCount` is a live `SELECT COUNT(*) FROM
product_refs` — 34 confirms the seed migration actually landed in the remote database, not just
that the Worker booted.

## 10. Enable Event Subscriptions — only now

In the Slack app config → **Event Subscriptions**:

- Toggle **Enable Events** on.
- Request URL: `https://{worker}/slack/events`

**This step must come after step 8, never before.** The instant you enable Event Subscriptions,
Slack sends a `url_verification` challenge to the request URL and requires a `200` echoing the
challenge back within a few seconds. That only succeeds against a Worker that is already deployed
and already has the correct `SLACK_SIGNING_SECRET` — see `src/slack/events.ts`, which answers
`url_verification` only *after* the signature check passes. Attempting this against a
not-yet-deployed Worker (or the pre-`main` old deployment) gets a validation failure that has
nothing to do with your Slack config being wrong.

Under **Subscribe to bot events**, add `app_mention`. Save.

## 11. Enable Interactivity

Same app config, **Interactivity & Shortcuts**:

- Toggle **Interactivity** on.
- Request URL: `https://{worker}/slack/interactions`

This is what makes the arrival-date picker, the variant/candidate disambiguation buttons, and the
ref-approval buttons work — all of them post back to this one endpoint
(`src/slack/interactions.ts`).

Also confirm **Distribution** stays **off** (internal-only app). This bot is scoped to one
workspace; there's no reason to make it publicly installable.

## 12. Invite the bot and try it

In the target Slack channel:

```
/invite @zmod-bot
```

Then:

```
@zmod-bot help
```

You should get the usage text back (`src/slack/commands.ts` `USAGE_TEXT`) within a few seconds. Try
a real product next: `@zmod-bot zudo-rail`.

If nothing happens, see `docs/operations.md` for how to inspect a stuck job, and
`docs/smoke-test.md` for the checks that need a live deployment.
