/**
 * `POST /slack/interactions` — Block Kit `block_actions` (button clicks)
 * and `view_submission` (modal) payloads: approve/cancel on a gated
 * write, "create a reference" on a miss. Implementation is issue #14's
 * responsibility.
 */
import type { RouteContext } from "../router";

export async function handleSlackInteractions(context: RouteContext): Promise<Response> {
  throw new Error("not implemented: handleSlackInteractions");
}
