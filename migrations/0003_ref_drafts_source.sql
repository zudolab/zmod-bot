/* ref_drafts.source records which authoring action produced the draft, so the
   product_ref_versions row written on approval carries the true source label.
   Without it the approve path can only infer 'authored' vs 'refreshed' from
   base_version, and a `ref restore` approved through the same draft/preview
   flow would be recorded as a refresh -- a false entry in the one table that
   IS this store's undo history (issue #15). Additive-only, per CLAUDE.md. */
ALTER TABLE ref_drafts ADD COLUMN source TEXT NOT NULL DEFAULT 'authored' /* 'authored' | 'refreshed' | 'restored' */;
