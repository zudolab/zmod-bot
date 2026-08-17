---
name: l-reply-purchase
description: "Generate Mercari Shops purchase reply message for Takazudo Modular customers. Use when: (1) User says 'l-reply-purchase' or 'reply purchase', (2) User provides a product URL or product name and wants a customer reply message generated, (3) User needs to respond to a Mercari purchase with shipping info, manuals, guides, and resources."
argument-hint: "<product-url-or-name> — e.g. https://takazudomodular.com/products/oxi-one-mk2-intro/ or \"OXI ONE MKII\""
---

# Purchase Reply Message Generator

Generate customer reply messages for Mercari Shops purchases at Takazudo Modular.

## Workflow

### 1. Identify the Product

From `$ARGUMENTS`, determine the product and flags:

**Flags:**

- `--discord`: Include Discord server guidance at the end of the message. Used for email orders where the customer doesn't receive the Mercari Shops auto-reply. By default (no flag), Discord guidance is NOT included. **Do NOT ask the user about this flag** — it is an exceptional tweak. Only honor it when the user explicitly passes `--discord`; otherwise silently omit the Discord block without confirming.
- `--direct`: This purchase was NOT made via Mercari Shops (e.g. a direct/private sale), so there's no shop evaluation to request. Remove the shop evaluation sentence ("お受け取りいただけたら、特にコメント無しでも良いのでショップの評価を頂けると嬉しいです。") from the message — see `references/templates.md` for the exact wording to drop per category. By default (no flag), the evaluation request IS included. **Do NOT ask the user about this flag** — only honor it when explicitly passed.

Strip any flags from the arguments before product lookup.

**Shortcuts** — skip product lookup entirely:

- `small` or `nekopos`: Output the small item template directly (no product-specific info needed)

**Normal flow:**

- If a URL like `https://takazudomodular.com/products/...`, extract the slug from the path
- If a product name, match against known product references

Search for a matching file in `references/products/` within this skill directory. Match by:

- Filename (slug)
- `product-url` field
- `aliases` field

### 2. If Product Reference Not Found

When no reference file exists:

1. **Always check BOTH repos — this is mandatory, not optional:**
   - `/refer-another-project zzmod` → product page (intro article), guides, videos. Source MDX is at `src/mdx/products/{slug}.mdx`. (The site repo was migrated from `zmod` to `zzmod` — use `zzmod`.)
   - `/refer-another-project zmanuals` → Japanese-translated manual content. Source is at `manual-pdf/{slug}/`.
2. **Manual URL pattern:** If `manual-pdf/{slug}/` exists in zmanuals, the manual is published at `https://takazudomodular.com/manuals/{slug}` and you MUST include it in the reference file's Manual section. Do NOT fall back to a vendor's official site (e.g. `https://www.ryk-modular.com/user-manuals`) when an in-house translated manual exists — the in-house manual is always the right link to give the customer. The zmanuals slug usually matches the zzmod product slug, but not always (e.g. zzmod `addac305-manual-latches-intro` → zmanuals `addac305-latches-diy`); verify by listing `manual-pdf/`.
3. Create a new product reference file in `references/products/{slug}.md` following the format of existing files.
4. Then proceed to generate the message.

### 3. Ask Shipping Details

For small items (ネコポス), skip the arrival schedule question entirely.

For general/diy items, before asking, compute tomorrow, the day after tomorrow, and the day after that (明々後日) in JST — both the weekday and the `M/D` date (e.g. `8/16`):

```bash
python3 -c "
from datetime import datetime, timedelta, timezone
jst = timezone(timedelta(hours=9))
now = datetime.now(jst)
days_jp = ['月', '火', '水', '木', '金', '土', '日']
tomorrow = now + timedelta(days=1)
day_after = now + timedelta(days=2)
day_after2 = now + timedelta(days=3)
print(days_jp[tomorrow.weekday()] + '曜 ' + str(tomorrow.month) + '/' + str(tomorrow.day))
print(days_jp[day_after.weekday()] + '曜 ' + str(day_after.month) + '/' + str(day_after.day))
print(days_jp[day_after2.weekday()] + '曜 ' + str(day_after2.month) + '/' + str(day_after2.day))
"
```

Then present the arrival question using AskUserQuestion with four options. Include the `M/D` date in each label so it is unambiguous:
- `明日{曜日} {M/D}` — e.g. "明日水曜 8/16" (use computed tomorrow day + date)
- `明後日{曜日} {M/D}` — e.g. "明後日木曜 8/17" (use computed day-after-tomorrow day + date)
- `明々後日{曜日} {M/D}` — e.g. "明々後日金曜 8/18" (use computed day-after-day-after-tomorrow day + date)
- `その他` — user will type a custom answer

If the user selects `その他`, ask a follow-up open-ended question for the custom arrival text (have them include the `M/D` date too).

Carry the selected `M/D` date into the arrival schedule sentence in the message (see `references/templates.md`).

Also confirm the product category if unclear (general / diy / small).

### 4. Generate the Message

Read `references/templates.md` for the template patterns. Read the product reference file for resources.

Compose the message following these rules:

- **general**: Yamato shipping + arrival schedule + manuals/guides/videos + evaluation request
- **diy**: Same as general + build guide link + DIY beginner guides
- **small**: Nekopos shipping, no arrival schedule, just evaluation request

For products with manuals/guides/videos, use the intro text from the product reference file to make the message natural (not robotic).

**Resource line formatting:** product reference files store each resource compactly as `- Title: URL` on one line. In the generated message, always break the line so the URL sits on its own line below the title — do NOT keep title and URL on the same line.

- ❌ Wrong: `OXI Instruments: OXI Split V2: https://takazudomodular.com/products/oxi-split-v2-intro/`
- ✅ Correct:
  ```
  OXI Instruments: OXI Split V2:
  https://takazudomodular.com/products/oxi-split-v2-intro/
  ```

This applies to every resource line pulled from the product reference file (manuals, guides, build guide, videos, extra resources).

Use `===` separator before extra/older resources section if applicable.

If `--discord` flag was passed, append the Discord guidance block (see `references/templates.md`) after the product resources, before the closing lines.

If `--direct` flag was passed, drop the shop evaluation sentence from the shipping paragraph (see `references/templates.md` for the per-category wording).

### 5. Output

Output the generated message directly in the chat response (plain text, ready to copy). Do NOT write it to any file — not `inbox/draft.md`, not a numbered slot, and do NOT use `/l-active` or `$ZUDOTEXT_ACTIVE_FILE_POINTER`.

## Product Reference File Format

```markdown
# Product Name

- category: general | diy | small
- product-url: https://takazudomodular.com/products/{slug}/
- aliases: Name1, Name2

## Manual

- Title: URL

Intro text: ...

## Guides

- Title: URL

Intro text: ...

## Build Guide (diy only)

- Title: URL

## Videos

- Title: URL

## Extra Resources

Separator intro: ...

- Title: URL
```
