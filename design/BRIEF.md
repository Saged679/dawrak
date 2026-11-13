# Design brief: Dawrak (دورك)

**Product:** Arabic-first SaaS where clinics and salons take bookings online. A patient picks a service, a doctor or stylist and a time, or just chats with an AI assistant that books for them. The owner gets a dashboard with the calendar, staff, services, numbers and conversations. Name means "your turn".

**Audience:** (1) Clinic and salon owners in Saudi Arabia, the Gulf and Egypt who judge the product in the first minute. (2) Their customers, who book from a phone. (3) Mostaqel clients looking at the author's portfolio.

**Primary job of the page:** make an owner try the live demo.

## Deliverable per option
A static, build-free folder `design/options/<NN-name>/` containing:
- `index.html` (+ `styles.css`, optional small `app.js`): the **Arabic RTL landing page**, `lang="ar" dir="rtl"`, with realistic Arabic copy. Sections: hero, how a booking works, the AI chat in action, the dashboard preview, a "try the demo" call to action, footer. Mock the product UI in HTML/CSS (booking widget, chat, dashboard); no screenshots, no images from the internet.
- `NOTES.md`: color tokens (named hex), fonts and their roles, layout concept, the one bold move, and what you changed after reviewing your first plan.

## Constraints
- Everything free: fonts from Google Fonts only, no paid assets, no frameworks that need a build.
- Works from 360px up. Visible keyboard focus. Respect `prefers-reduced-motion`.
- Arabic typography matters: line length under 80 characters, generous line-height (Arabic needs more), no letter-spacing on Arabic text.
- Show Hijri date beside the Gregorian date somewhere in the mocks.
- Real content, no lorem ipsum. Invent plausible demo clinics, doctors and Saudi/Egyptian names, no real brands.
- Avoid the generated-page defaults: cream + terracotta serif; near-black + one acid accent; identical rounded cards with the same soft shadow; all-caps tracked eyebrow labels above headings; "01/02/03" markers on non-sequences; arrows on every button; gradient washes as decoration.
- Spend boldness in one place and keep the rest quiet.

## Process
1. Write a short plan (named hex colors, type, layout concept with an ASCII wireframe, principles).
2. Review it against this brief and revise any part that is a default.
3. Build it. Critique and remove one accessory before finishing.
4. Don't touch other options' folders.
