# Seed corpus — immutable bootstrap fixture

These files are the **initial import source** for the product reference store. They are applied
exactly once, by `migrations/0002_seed_product_refs.sql`, which CI runs before every deploy.

**Rules:**

- **Nothing under `src/**` may import from this directory.** D1 is the runtime store; a test enforces
  this. If the Worker ever read these files at runtime, "reference data is online, read and written
  from Slack" would quietly stop being true.
- **Do not edit these files to change a reference.** After the seed migration has run, edits happen
  through the bot (`@bot ref refresh …` / `ref restore …`), which versions every change in
  `product_ref_versions`. Editing here would silently diverge from the live store.
- They are kept in the repo as the provenance record of where the store started, and so the seed
  migration can be regenerated deterministically (`pnpm seed:build`).

## Contents

- `products/*.md` — 34 product references, copied verbatim from the `/l-reply-purchase` Claude Code
  skill they originated in.
- `templates.md` — the reply templates. The deterministic renderer must reproduce the fixed clauses
  from this file byte for byte.
- `source-skill.md` — the original skill definition, kept for its workflow and tone rules.
