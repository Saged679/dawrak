# Option 02: Fakhama (فخامة), "Gulf luxe"

For premium salons and dental/beauty clinics in Riyadh, Dubai, Doha. Midnight green and brass, with pearl instead of cream.

## Color tokens
| Token | Hex | Use |
|---|---|---|
| green-900 | #0B1F1E | chat section, footer |
| green-800 | #10302D | hero, header, CTA, dashboard sidebar |
| green-700 | #17423E | raised surfaces on dark, bot bubbles |
| brass-400 | #C9A66B | accent on dark, primary button, user bubbles |
| brass-700 | #7A5A26 | brass text on pearl (contrast about 5:1) |
| pearl-50 | #F4F5F1 | page (cool grey-green pearl, not cream) |
| pearl-100 | #E8EBE5 | tags, disabled slots |
| pearl-300 | #CBD1C9 | hairlines |
| ink | #16201F / ink-soft #4A5755 | text on pearl |
| on-dark | #E9EEE8 / #A9BAB5 | text on green |

## Fonts (Google Fonts, free)
- **Reem Kufi** (500-700): display only (h1, h2, h3, logo, numerals in step diamonds). A geometric Kufi with real Gulf signage and calligraphy character; its angular joins pair with the lattice. Not used below 1.1rem.
- **IBM Plex Sans Arabic** (400-600): all UI and body text. Clean, high x-height, legible at 14-16px in forms, chat and tables, and its Latin digits match the mocks. Kept to two families so the Kufi carries all the character.
- Western digits are wrapped in `.num` (LTR isolate) so times and dates do not reorder inside RTL lines.

## Layout concept
```
[logo]        [nav]                 [EN]
+------------------------------------------+
| HERO (green, lattice fading in from the  |
| text side)                               |
|  H1 Kufi, huge, brass 2nd line | booking |
|  copy + 2 buttons              | widget  |
+------------------------------------------+
 HOW: heading, then a vertical rail of 3 diamond-numbered steps (no cards)
 CHAT (dark): copy + bullets | phone mock with confirmation
 DASHBOARD (pearl): framed app mock (sidebar, KPIs, schedule) + 3 plain notes
 CTA (green, faint lattice, centred)
 FOOTER
```
Sections alternate green and pearl so the page reads as a sequence of rooms, not a stack of identical cards. Only the booking widget, phone and dashboard are boxed.

## The one bold move
The hero: a very large Reem Kufi headline ("مواعيدكم / بحجز يليق بكم") in pearl and brass over a mashrabiya-style lattice (square, rotated square and circle, drawn as an inline SVG data URI in brass line art at 16% opacity). The lattice is masked to fade out toward the booking widget, so it frames the headline and never competes with the UI. It reappears once more, at 10%, behind the CTA. Everything else is flat, quiet and hairline-ruled.

## Changes after reviewing the first plan
- First plan had a lattice band between every section; cut to hero and CTA only (structure, not wallpaper).
- First plan used pale brass for text on pearl; failed contrast, added a darker brass-700 token.
- Pearl was first #F1EFE6; too close to cream, moved to a cooler #F4F5F1.
- "How it works" first planned as three equal cards; changed to a rail with diamond markers (a genuine sequence, and different from the other boxed mocks).
- Critique pass: removed the small diamond-and-line eyebrow above each section heading (it was an eyebrow label by another name).
- Bug found in headless test: a `left:-9999px` visually-hidden table caption created 11,000px of horizontal scroll in RTL; replaced with a clip-based `.sr` class. Page now measures exactly the viewport width at 360 and 1280.

## Brief checklist
RTL `lang="ar" dir="rtl"`, logical properties used; Hijri beside Gregorian in the widget, chat and dashboard (15 Nov 2026 = 5 Jumada II 1448, approximate Umm al-Qura); no letter-spacing on Arabic; line-height 1.9 body; copy lines capped at 48-60ch; visible brass focus ring; reduced-motion respected; no external images; demo names are invented.
