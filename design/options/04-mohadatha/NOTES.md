# Option 04: محادثة (Chat-first)

## Tokens
| Name | Hex | Role |
|---|---|---|
| Ink | #101C3A | text, CTA band, phone bezel |
| Cobalt | #2549D1 | hero, primary buttons, the assistant's identity |
| Cobalt deep | #1B37A3 | labels on tinted backgrounds |
| Sky | #DCE7FF | customer bubbles, selected chips |
| Mist | #EEF2F9 | page background |
| Paper | #FFFFFF | assistant bubbles, cards |
| Saffron | #F2A93B | the one warm accent: CTAs, "new booking" markers, confirmation ticket |
| Saffron soft | #FDEBC8 | booking ticket, handoff panel |
| Line | #D3DBEB | borders |
| Muted | #4F5C79 | secondary text (5.5:1 on Mist) |

## Fonts
- **Readex Pro** (headings, buttons, numerals): designed with a wide, open Arabic and Latin pair, so headlines feel friendly like a messaging app and not formal like newspaper Arabic.
- **IBM Plex Sans Arabic** (body, bubbles): calm, very legible at 14-16px on phones, good Arabic-Indic digits, comfortable at line-height 1.8.
No letter-spacing on Arabic; body line-height 1.85; measures capped near 40em.

## Layout concept
Hero is the product. Headline on the right (RTL start), and beside it a phone with a scripted chat plus the owner's calendar. The booking lands in the calendar in the same moment the ticket appears in the chat. Below: how booking works (steps + booking widget mock), the assistant (dialect question and a human-handoff case), dashboard preview, demo CTA, footer.

```
[ headline / lead / CTAs ] [ phone chat ][ calendar ]
[ steps ................. ][ booking widget        ]
[ mini chat: price       ][ mini chat: handoff     ]
[ week calendar ......... ][ big number + inbox     ]
[ CTA band (ink) ]  [ footer ]
```

## The one bold move
A live, scripted conversation in the hero: voice note with waveform and transcript, typing dots, slot chips, a confirmation ticket, and the owner's calendar slot appearing with a "new from assistant" badge. Voice note is playable (visual only). Replay button appears at the end. With `prefers-reduced-motion` (or no JS) the page shows the final state at once. Everything else is kept flat and quiet.

## Not WhatsApp
Cobalt and saffron, no green, no doodle pattern, no WhatsApp name or logo; bubble tails use one square corner only, the avatar is the brand letter.

## Hijri
Booking ticket, calendar header, widget and dashboard week show Hijri beside Gregorian. Hijri dates are computed by hand (Umm al-Qura expected: 15 Nov 2026 = 4 Jumada II 1448) and not verified against a calendar API.

## Changes after reviewing the first plan
- First plan had a dark navy hero with a saffron accent: that is the "near-black plus one acid accent" default. Switched to a full cobalt hero, keeping ink only for the CTA band.
- First plan had the dashboard as three identical stat cards. Replaced with one big number tile, a week grid and an inbox list, each with a different shape.
- First plan had "01/02/03" step markers styled as labels; kept real sequence numbers only in the booking steps (a true sequence), in Arabic-Indic digits.
- Critique pass: removed a decorative chat wallpaper pattern and a second voice-note in the mini chats; reduced H1 size after the first screenshot orphaned one word.

## Trade-offs / unverified
- Verified in headless Chromium at 1280px and 360px with reduced motion (final state). The animated sequence was written and logic-checked but not recorded frame by frame.
- Fonts load from Google Fonts at runtime; offline falls back to system Arabic.
