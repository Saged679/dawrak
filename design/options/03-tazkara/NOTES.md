# 03-tazkara: "The queue ticket"

## Tokens
| Name | Hex | Role |
|---|---|---|
| Counter Blue | #2438C9 | hero and CTA fields, chat header, numerals on white |
| Ticket Yellow | #FFCB2E | the ticket, headline on blue, "now serving" panel |
| Ink Navy | #12183A | text, chat section, footer, perforation lines |
| Stamp Red | #D8321F | the "تم الحجز" stamp and focus ring only |
| Paper | #F3F5FC | quiet page ground (cool, not cream) |
Line #C9CFEA for hairlines. No gradients, no shadows.

## Fonts (Google Fonts, free)
- **Changa 800/600**: display and all big numerals. It has a heavy Arabic weight with wide, squarish Latin digits, so "14" on the ticket reads like a printed counter number and the Arabic headline matches it.
- **Tajawal 400/500/700**: body and UI. Open, neutral Arabic with generous counters, good at small sizes and with tall line-height (1.9).
Numerals are Western digits throughout (common in Gulf and Egyptian app UIs, and they suit the ticket). No letter-spacing on Arabic.

## Layout concept
Flat blocks stacked in alternating fields: blue hero, paper steps, navy chat, paper dashboard, blue CTA, navy footer. The only shaped object is the ticket (notches via circles in the field colour, dashed divider, stub on the left in RTL). Steps are separated by the same dashed perforation, so the "how" section is a strip torn into three stubs of unequal width.

## The one bold move
The hero ticket is the booking widget. Pick a service and a slot and the big number changes (later slot, higher queue number, with a small bump), the time, doctor, Gregorian date and Hijri date update, and "ثبّت الحجز" stamps a red "تم الحجز" onto it. The same ticket reappears as the chat confirmation, the dashboard's "now serving" panel and the CTA, so the shape does the branding. Hijri date comes from Intl (umalqura) with static fallback.

## Review: what changed from the first plan
- First plan made every section ticket-shaped (cards with notches). Cut: only the ticket and the dashboard's now-serving panel keep the shape, everything else is flat.
- First plan had a paper-grain texture and a yellow-on-navy hero (the near-black plus acid accent tell). Moved the hero to blue, navy kept to chat and footer.
- Step numbers kept as 1/2/3 because it is a true sequence, but dropped the "01" style.
- Critique pass: removed the hint line under the hero buttons; the chips' labels already say what to do.

## Trade-offs
- Number-per-slot is a demo rule, not real queue logic.
- Dashboard table scrolls horizontally inside its panel under ~480px.
- Verified in headless Chromium at 1280px and ~350px; not tested in Safari.
