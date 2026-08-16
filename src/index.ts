/**
 * zmod-bot Worker entry point.
 *
 * Routes:
 *   POST /slack/events        -> src/slack/events.ts        (Events API: app_mention, URL verification)
 *   POST /slack/interactions  -> src/slack/interactions.ts  (Block Kit button clicks, modal submissions)
 *   GET  /health               -> src/health.ts (D1 round-trip + migration state)
 *   everything else            -> 404 (src/router.ts default)
 *
 * The cron trigger (wrangler.jsonc `triggers.crons`) runs the delivery-
 * worker sweep. Per CLAUDE.md "durable intent before the ack": the write
 * that happens before this Worker returns 200 to Slack is the contract;
 * an immediate `ctx.waitUntil` delivery attempt right after ack (see
 * src/slack/events.ts) is only an optimization on top of it.
 */
import type { Env } from "./env";
import { Router } from "./router";
import { handleSlackEvents } from "./slack/events";
import { handleSlackInteractions } from "./slack/interactions";
import { handleHealth } from "./health";
import { runScheduledSweep } from "./jobs/worker";

const router = new Router()
  .post("/slack/events", handleSlackEvents)
  .post("/slack/interactions", handleSlackInteractions)
  .get("/health", handleHealth);

export default {
  async fetch(request, env, ctx) {
    return router.handle(request, env, ctx);
  },

  // The cron trigger — every 5 minutes (wrangler.jsonc triggers.crons).
  // This is the contract, not the optimization: runScheduledSweep's
  // delivery pass alone (with no immediate-delivery waitUntil ever
  // firing from src/slack/events.ts) is sufficient to eventually
  // deliver every job, because it claims both "pending" and "failed"
  // jobs unconditionally — see src/jobs/worker.ts's module comment.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledSweep({ env, fetch, now: () => new Date() }));
  },
} satisfies ExportedHandler<Env>;
