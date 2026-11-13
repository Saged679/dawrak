# Option 01 (hadi): Calm clinical

## Direction
A modern clinic: quiet, airy, pale sea-glass and deep teal, white space, readable by any age. Body text 17px/1.85, buttons 48px tall, large tap targets.

## Color tokens
| Name | Hex | Role |
|---|---|---|
| paper | #FBFDFC | page background |
| glass | #E6F2EF | hero, chat, footer bands; mock panels |
| glass-2 | #D3E8E3 | reserved tint |
| line | #C3DAD5 | hairlines, borders, perforation |
| teal-900 | #08373F | headings, dark CTA band, sidebar |
| teal-700 | #0E5F6B | primary buttons, links, selected states |
| teal-600 | #137682 | focus ring |
| teal-100 | #CDE8E6 | assistant bubbles, ghost hover |
| ink | #12292E | body text |
| muted | #4B666C | secondary text |
| amber | #B4531A | the only warm note: "confirmed" stamp, current patient, unread badge |
| amber-bg | #F8E6D6 | row of the patient currently in the clinic |
| ok | #1F7A57 | booking-confirmed label |

## Fonts (Google Fonts, free)
- **Readex Pro** (600) for headings, numerals and the slip number. Its Arabic is open and friendly with sturdy proportions, and its Latin digits and punctuation match, so it works for display sizes without feeling playful.
- **IBM Plex Sans Arabic** (400/500/600) for body, UI and chat. Very legible at small sizes, calm and neutral, tall enough counters for tashkeel-free text, good for older readers.
Both are sans so the page stays quiet; contrast comes from weight and size, not a second style.

## Layout concept
Hero: copy on the right (RTL start), appointment slip and time picker on the left. Then a three-step rail (a real sequence, so numbering is honest), chat on a glass band with a phone mock, a dashboard mock (sidebar + today's agenda), a dark teal CTA band, a quiet footer. Mobile: single column, the rail goes vertical, the dashboard sidebar becomes a scrolling tab strip.

## The one bold move
The hero is a **paper appointment slip with a tear-off stub**: perforated dashed edge, two punched notches, a tilted "مؤكَّد" stamp, and the big queue number "دورك رقم ١٢" on the stub (the product name literally means "your turn"). Tapping a time below it re-stamps the slip and changes the number. The same "دورك رقم" appears in the SMS and chat confirmations. Everything else is deliberately plain.

## Brief checklist
Arabic RTL, realistic copy (Saudi and Egyptian names, fictional clinics), Hijri beside Gregorian (slip, calendar, dashboard, chat; 15 Nov 2026 = 4 Jumada al-Akhira 1448, approximate Umm al-Qura), no letter-spacing, line length capped, focus-visible, reduced-motion respected, works at 360px (no horizontal overflow checked), no images or external assets besides Google Fonts.

## Changes after reviewing the first plan
- First plan had a waiting-room clock motif in the header and hero; dropped it as a second idea competing with the slip. The brand mark keeps a tiny clock hand only.
- First plan had three equal step cards; replaced with a rail with differently shaped mocks (list, calendar, SMS bubble) to avoid identical cards.
- Planned a teal-to-glass gradient hero; made it a flat sea-glass fill.
- Critique pass: removed the fake message input bar under the chat (an accessory that added nothing).
- Fixed KPI tiles clipping at 360px.

## Unverified
Hijri dates are computed by hand, not from a calendar library. Only Chromium (Playwright) was tested; no real-device or screen-reader pass. Fonts load from Google at runtime (needs internet).
