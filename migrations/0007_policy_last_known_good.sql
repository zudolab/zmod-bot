/* The last policy document confirmed by the stash, keyed by its exact path.
   `version` is the stash version, `etag` is the exact response-header ETag,
   and `confirmed_at` is the epoch-millisecond confirmation time. The
   conditional upsert in src/stash/policy-store.ts fences older responses and
   rejects same-version identity changes. Additive-only, per CLAUDE.md. */
CREATE TABLE policy_last_known_good (
  path         TEXT PRIMARY KEY NOT NULL CHECK (path = 'policy/reply-guidance.md'),
  document     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  etag         TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL
);
