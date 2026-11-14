# Motion system

One CSS file defines the tokens and the shared rules: `src/app/motion.css` (imported by `globals.css`). Landing-only rules sit at the end of `src/components/landing/landing.css`. No motion library: CSS transitions and keyframes, React `<ViewTransition>` (Next 16 / React 19.3), and four tiny client components in `src/components/motion/`.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--m-d1` | 120 ms | press, hover |
| `--m-d2` | 200 ms | small state changes, menus, chat close |
| `--m-d3` | 320 ms | step slides, sheets, dialogs |
| `--m-d4` | 500 ms | reveals, confirmation, count-up feel |
| `--m-ease-out` | `cubic-bezier(.2,.7,.2,1)` | default |
| `--m-ease-in-out` | `cubic-bezier(.65,0,.35,1)` | shake, send |
| `--m-ease-in` | `cubic-bezier(.4,0,1,1)` | exits |
| `--m-ease-spring` | `cubic-bezier(.34,1.35,.64,1)` | pops (tiny overshoot) |
| `--m-dist-1/2/3` | 4 / 12 / 24 px | travel distances |
| `--dir` | `1` LTR, `-1` RTL (`[dir=rtl]`) | multiply every horizontal offset |

Tailwind's `--default-transition-duration` and timing function point at these, so `transition-*` utilities follow the tokens.

## Rules

- Animate `transform`, `opacity` and the individual `translate`/`scale` properties. Colour and shadow transitions are allowed on small elements. Never width, height, top or left. SVG stroke draw is used only for the tiny confirmation check.
- Direction: `translateX(calc(var(--dir) * N))`. Steps go forward from the inline-end side, back from the inline-start side.
- Reduced motion (`prefers-reduced-motion: reduce`): the tokens collapse to 1 ms and distances to 0. Transitions and animations still run and still fire `transitionend`/`animationend`, so dialogs and focus handling keep working. On top of that: ambient glow, shimmer, typing dots, record dot, progress bar and view-transition animations are removed; count-ups and reveal-on-scroll never start (final values and content shown at once).
- Hiding content before JS is forbidden. Reveal-on-scroll hides only under `@media (scripting: enabled) and (prefers-reduced-motion: no-preference)` and only elements that JS has marked `data-reveal-state="pending"` after hydration and that start wholly below the fold. Hero, first headings and the LCP are never marked. Count-ups use `data-count="pending"` under the same media query, with a 1.5 s CSS failsafe. Status pages, calendar blocks and alerts animate `transform` only, so their text is never hidden.
- Looping animation: skeleton shimmer and typing dots while something loads; the hero glow is decorative, removed under reduced motion and paused while offscreen.

## Where

- Landing: scroll reveals with stagger, step line draw, number count-ups, card lift (hover devices), header shadow on scroll, smooth anchors, hero glow. The hero sequence is unchanged.
- Navigation: `template.tsx` files wrap routes in `PageEnter` (React `<ViewTransition>`; CSS fallback when `document.startViewTransition` is missing), `NavProgress` bar, `loading.tsx` skeletons for the dashboard and the clinic page.
- Booking: step slide (RTL-aware, only after the first click), progress bar, chip press/selected, confirmation check draw and ticket stamp (the heading takes focus, so screen readers hear the result without the animation).
- Chat: sheet open/close below `lg`, bubble entrance, typing dots, smooth scroll, send feedback, voice meter and record dot.
- Dashboard: nav icon nudge, topbar shadow, user menu, calendar blocks (entrance, hover, press, status highlight), sliding detail sheet, KPI count-ups, notices, table rows, field focus, validation shake.
- Global: base transitions on links, buttons, inputs, summaries; press scale; mailbox arrival flash; status pages rise.

## Tests

`e2e/motion.spec.ts` (reduced motion, no-JS, RTL step direction, View Transitions fallback, CSP console), `e2e/motion-perf.spec.ts` (CLS, JS size, 4x CPU throttle), `tests/motion/` (count-up and reveal helpers).
