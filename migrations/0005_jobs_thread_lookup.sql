/* jobs carries only jobs_claimable ON jobs(state, claim_expires_at, id) (0001) —
   a thread-scoped lookup (epic #22, thread continuity) would be a full scan
   without this index. Additive-only, per CLAUDE.md. */
CREATE INDEX jobs_thread_lookup ON jobs(channel_id, thread_ts, id);
