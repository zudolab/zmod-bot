# Reply Message Templates

## Category: general

Standard modules, sequencers, etc. Shipped via Yamato (ヤマト). Ask user for arrival date.

```
ご購入ありがとうございます。
こちら、本日ヤマトで発送させていただきました。{arrival_schedule}お受け取りいただけたら、特にコメント無しでも良いのでショップの評価を頂けると嬉しいです。

{product_resources}

不明点等ございましたらお気軽にコメント等頂ければと存じます。
よろしくお願いいたします！
```

- `{arrival_schedule}`: e.g. "明日土曜（8/16）到着予定になります。" — ask user for day/date
  - **MUST be a complete sentence ending with `到着予定になります。`** Do NOT inline the user's raw answer (e.g. just "明後日月曜") directly before "お受け取りいただけたら" — that produces broken Japanese ("明後日月曜お受け取りいただけたら"). Always wrap their answer as `{day}（{M/D}）到着予定になります。` so the sentence terminates cleanly.
  - **Always include the exact `M/D` date** in parentheses after the weekday — e.g. `明後日火曜（8/17）`. The user's selected option carries the date; do not drop it.
  - ✅ Correct: `本日ヤマトで発送させていただきました。明後日月曜（8/18）到着予定になります。お受け取りいただけたら、…`
  - ❌ Wrong (missing date): `本日ヤマトで発送させていただきました。明後日月曜到着予定になります。お受け取りいただけたら、…`
  - ❌ Wrong (broken grammar): `本日ヤマトで発送させていただきました。明後日月曜お受け取りいただけたら、…`
- `{product_resources}`: manuals, guides, videos — built from product reference file

With `--direct` (not a Mercari Shops order — no shop evaluation to request), drop the evaluation clause and end the sentence at the arrival schedule:

```
こちら、本日ヤマトで発送させていただきました。{arrival_schedule}
```

## Category: diy

DIY kits. Same shipping as general, but add build guide and DIY beginner guides.

```
ご購入ありがとうございます。
こちら、本日ヤマトで発送させていただきました。{arrival_schedule}お受け取りいただけたら、特にコメント無しでも良いのでショップの評価を頂けると嬉しいです。

{product_name}について、こちらのDIYキットは、以下に写真入りのステップバイステップビルドガイドが用意されておりまして、こちらを参照しつつお作りいただければと存じます。

{build_guide}

{product_resources}

ほか、DIY入門者向けのガイドをサイトに用意しました。
もしご興味がございましたら、ご参考にしていただけると幸いです。

ガイド: シンセDIYとDIYキット
https://takazudomodular.com/guides/col001-diy-kits/
ガイド: シンセDIYに必要な道具
https://takazudomodular.com/notes/2024-08-07-col002-diy-tools/

使い方についても不明点ありましたら、お気軽に質問等していただければと存じます。

よろしくお願いいたします！
```

Same `--direct` shipping-line change as the general category applies here.

## Category: small

Blank panels, cables, small accessories. Shipped via Nekopos (ネコポス). No specific arrival date.

```
ご購入ありがとうございます。
こちら先ほど配送させて頂きました。
ネコポス配送のため、郵便受けへの投函となるかもしれません。

お受け取りいただけたら、特にコメント無しでも良いのでショップの評価を頂けると嬉しいです。よろしくお願いいたします！
```

With `--direct`, drop the evaluation clause:

```
ご購入ありがとうございます。
こちら先ほど配送させて頂きました。
ネコポス配送のため、郵便受けへの投函となるかもしれません。

よろしくお願いいたします！
```

## Discord Guidance (--discord flag only)

When `--discord` is passed, insert this block after the product resources and before the closing lines. Use `---` as a separator.

```
---

ほか、ご購入くださった方には、Takazudo ModularのDiscordをご案内させていただいております。

Discordサーバーのご案内 | Takazudo Modular
https://takazudomodular.com/s/discord/

こちらでは、Takazudo Modularの新着情報告知／お得なお知らせや、入荷の相談、気軽な雑談、モジュラーやシンセDIYに関する質問等をし合うようなチャットになっております。ご興味あるようでしたら、お気軽に覗いて頂けると幸いです。
```

## Notes

- For general/DIY: always ask user when the item will arrive (day of week + date if known)
- For small: no arrival schedule needed
- If the product has manuals/guides/videos on takazudomodular.com, always include them
- Use `===` separator before extra/older resources section if applicable
- Resource lines: break the line before the URL (title on one line, URL on the next) — even though product reference files store them compactly as `Title: URL` on one line
- Discord guidance is NOT included by default (Mercari Shops customers already receive it via auto-reply). Only add it when `--discord` flag is explicitly passed (e.g. for email orders).
- The shop evaluation clause is included by default (assumes a Mercari Shops order). Only drop it when `--direct` flag is explicitly passed (e.g. a direct/private sale with no Mercari Shops evaluation to leave).
