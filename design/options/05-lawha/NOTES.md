# 05 - Lawha (dashboard-first, dense and operational)

## Concept
The hero is the product: a live day-view calendar (4 doctor columns, 09:00-19:00, "now" line at 12:20), KPI strip above it, detail panel beside it. Click a block to open it, change its status, and the KPIs (revenue, no-show rate, waiting) recompute. Day/week toggle, prev/next day, legend chips filter by status. Tabular data (booking stages, assistant log, doctors, services) is real tables with ruled lines, not cards.

```
[logo  nav              theme toggle | CTA]
H1 (right)                    lede + Gregorian/Hijri date
|مواعيد|إيراد|عدم حضور|انتظار|   <- ruled KPI strip, mono numerals
[يوم|أسبوع] [<  اليوم  >]  legend filters
| detail panel |  time | Dr1 | Dr2 | Dr3 | Dr4 |   (RTL: time axis on the right)
ledger table (4 stages) / chat + assistant log / tables + no-show bars / dark CTA band / footer
```

## Tokens (light / dark)
- bg `#F1F4F7` / `#0D1218`; panel `#FFFFFF` / `#141B23`; sunk `#E7ECF1` / `#10161D`
- ink `#101C27` / `#E6EDF3`; ink2 `#4A5B6A` / `#A5B3C0`; ink3 `#6B7A88` / `#8696A4`; line `#D3DBE3` / `#26313C`
- brand (ink-blue, used sparingly) `#0B5A7A` / `#6CC4E8`; now-line `#D9392F` / `#FF6B60`
- Status, fill / edge+text (5 flat hues, each also has its own shape marker and label, so color is never the only cue):
  - confirmed teal `#D2F0E8` / `#0A7A63` (dark `#12392F` / `#5FD9B8`), circle
  - waiting amber `#FBE9C2` / `#8F5A00` (dark `#3E3010` / `#F0C25E`), square + hatch
  - in session blue `#D9E5FD` / `#2250C4` (dark `#1B2D57` / `#8FB1FF`), leaf
  - done violet `#E6DCF7` / `#6A3FB0` (dark `#2D2150` / `#C0A4F5`), diamond
  - no-show red `#F8D8D5` / `#B42F2B` (dark `#4A1E1F` / `#FF938D`), crossed + strikethrough
- Dark is designed separately: block fills are deep tints, text and edges are lifted pastels, and hairlines are quieter, so it reads as a night-shift console rather than an inversion.

## Fonts
- **IBM Plex Sans Arabic** (400/500/600/700) for all Arabic text. Open counters and a sturdy, slightly technical, editorial feel; stays legible at 12-13px in dense blocks; its Latin glyphs match the mono.
- **IBM Plex Mono** (400/500) for every time, price, count and KPI. Western digits in tabular width mean column numbers align and "09:30" never reflows; set with `direction:ltr` so Arabic context does not scramble them.
- Rejected: Readex Pro (wide, loose, wastes width in narrow blocks), Vazirmatn (Persian-leaning forms), Noto Sans Arabic (fine but generic; kept only as fallback).

## Layout and type rules
Radius by hierarchy: calendar frame 6px, blocks 2px/6px asymmetric, pills and the main CTAs fully round, chat bubble and logo mark asymmetric. Weight carries hierarchy (700 headings, 600 data labels, 400-500 body). Line-height 1.8 body, 1.35 in blocks; no letter-spacing on Arabic. Hijri beside Gregorian in hero, day label, and detail panel. Works from 360px: calendar scrolls inside its own frame, tables collapse to stacked rows.

## The one bold move
The calendar is the hero and is sized like a real work screen, not a thumbnail. Everything else stays quiet (hairline rules, one brand color, no card grid).

## What changed after reviewing the first plan
- First plan had a three-up feature card row and a gradient hero backdrop; both removed (card kit, gradient wash). Replaced by the ruled ledger table and a flat page.
- First plan used 5 hues by color alone; added shape markers, hatching and strikethrough for accessibility.
- Considered a warm cream paper background; changed to cool grey-blue to avoid the cream/terracotta default.
- Critique pass: removed a decorative sparkline that sat in each KPI (duplicated the no-show bars and added noise).

## Unverified
Tested in headless Chromium (light desktop, dark mobile) via a local server; Safari/Firefox not checked; week-view layout at 360px only inspected by reasoning (scrolls inside frame). English version not built. Requires internet for Google Fonts, falls back to system Arabic fonts.
