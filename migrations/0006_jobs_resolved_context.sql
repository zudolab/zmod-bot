/* A small JSON blob recording what a reply job actually resolved to --
   slug, variant, arrival schedule (epic #22, thread continuity). Nullable:
   a job that never reached a resolved product has none. Additive-only,
   per CLAUDE.md. */
ALTER TABLE jobs ADD COLUMN resolved_context TEXT;
