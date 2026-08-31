/* Proposal work is single-flight per policy path. `generation` is the
   fencing token: reclaiming an expired lease increments it, so an old owner
   cannot renew or release the new owner's lease. Additive-only, per
   CLAUDE.md. */
CREATE TABLE policy_proposal_leases (
  path         TEXT PRIMARY KEY NOT NULL CHECK (path = 'policy/reply-guidance.md'),
  owner_job_id INTEGER NOT NULL,
  generation   INTEGER NOT NULL CHECK (generation > 0),
  expires_at   INTEGER NOT NULL
);

/* One row per change set's current decision epoch. Keeping the active epoch
   in its own row makes the single-active-epoch fence explicit and lets a
   conflict reopen exactly one later reject epoch. */
CREATE TABLE policy_decision_fences (
  change_set_id TEXT PRIMARY KEY NOT NULL,
  active_epoch  INTEGER NOT NULL CHECK (active_epoch > 0),
  state         TEXT NOT NULL CHECK (state IN ('open', 'conflict_pending', 'conflict_reopen', 'closed')),
  updated_at    INTEGER NOT NULL
);

/* Decision and outbox state share the composite change-set/epoch identity.
   Only safe metadata is stored: no policy body, diff, request, upstream
   message, or credential is persisted here. */
CREATE TABLE policy_decisions (
  change_set_id          TEXT NOT NULL,
  decision_epoch         INTEGER NOT NULL CHECK (decision_epoch > 0),
  action                 TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  actor_user_id          TEXT NOT NULL,
  channel_id             TEXT NOT NULL,
  review_message_ts      TEXT NOT NULL,
  remote_result          TEXT NOT NULL DEFAULT 'pending' CHECK (remote_result IN ('pending', 'applied', 'rejected', 'expired', 'closed', 'conflict')),
  remote_code            TEXT,
  remote_version         INTEGER,
  remote_commit_id       TEXT,
  conflict_state         TEXT NOT NULL DEFAULT 'none' CHECK (conflict_state IN ('none', 'pending', 'reopenable')),
  slack_update_completed INTEGER NOT NULL DEFAULT 0 CHECK (slack_update_completed IN (0, 1)),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (change_set_id, decision_epoch)
);
