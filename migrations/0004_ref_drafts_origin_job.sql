/* Links a ref_drafts row back to the job that spawned it — thread continuity
   (epic #22) needs this to recognize a `ref new` follow-up as part of the
   same conversation. Nullable: an explicit `@bot ref new <query>` has no
   originating job, and that is a legitimate state, not a defect. Additive-only,
   per CLAUDE.md. */
ALTER TABLE ref_drafts ADD COLUMN origin_job_id INTEGER;
