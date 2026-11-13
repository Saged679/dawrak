# 60-second video: script and shot list

Voice-over in Arabic (Gulf-friendly, calm). English subtitles are in italics. Target 60 seconds; the timings add up to 60.

Important facts about the demo that shape the shots (checked in the code):
- Bookings made in the chat assistant are not tied to the visitor's demo mailbox, so no reminder mail comes from them. The reminder shot must use a booking made with the web form (shot 6).
- Reminders are created for 24h and 2h before the appointment, and sent by the dispatcher (`/api/cron/reminders`), not instantly. For the video, trigger it by hand (checklist below).
- The demo clinic (`demo-clinic`) takes a 50 SAR deposit, so a chat booking there returns a payment link. The demo salon (`demo-salon`) has no deposit.

| # | Time | Screen | Click / do | Voice-over (Arabic) | *English subtitle* |
|---|---|---|---|---|---|
| 1 | 0-5 | Demo page `/ar/demo` | Show the four sign-in buttons, then open the clinic booking page `/ar/c/demo-clinic` | «دورك: نظام حجز للعيادات والصالونات، ومساعد يحجز بدل الموظف.» | *Dawrak: a booking system for clinics and salons, with an assistant that books for you.* |
| 2 | 5-17 | Chat widget on the clinic page | Press the microphone, say (about 6 s): "أبغى موعد تنظيف أسنان بكرة العصر". Send. Show the assistant's slot options | «العميل يرسل رسالة صوتية، والمساعد يفهمها ويعرض المواعيد المتاحة فعلًا.» | *The customer sends a voice note. The assistant offers the slots that are really free.* |
| 3 | 17-27 | Same chat | Pick a slot, give name and phone, answer the read-back with "نعم". Show the confirmation | «لا يحجز إلا بعد أن يؤكد العميل.» | *It only books after the customer confirms.* |
| 4 | 27-34 | Pay link from the chat, then Moyasar test invoice | Open the link, show the 15-minute hold, pay with test card 4111 1111 1111 1111 (any future expiry, any CVC, name of two words) | «العيادة تطلب عربونًا. الدفع هنا تجريبي، والموعد محجوز 15 دقيقة.» | *The clinic asks for a deposit. Payment here is test mode; the slot is held for 15 minutes.* |
| 5 | 34-42 | Dashboard `/ar/dashboard/calendar` (sign in as clinic owner from the demo page) | Open the calendar, point at the new appointment from the assistant | «وفي لوحة المالك، الحجز يظهر في التقويم مباشرة.» | *In the owner's dashboard the booking is in the calendar right away.* |
| 6 | 42-50 | Web booking form, then demo mailbox `/ar/demo/mailbox` | (Pre-recorded in a separate take, see checklist.) Show the mailbox with the reminder email and its manage link | «ويصل العميل تذكير بالبريد، مع رابط لتغيير الموعد أو إلغائه.» | *The customer gets a reminder email with a link to change or cancel.* |
| 7 | 50-57 | Dashboard, Conversations, then Knowledge | Open the conversation thread (voice-note marker), then the knowledge page with an FAQ and a PDF | «كل المحادثات تُحفظ، والمساعد يجيب من ملفات المنشأة.» | *Every conversation is saved, and the assistant answers from the business's own files.* |
| 8 | 57-60 | Home page or the demo URL on screen | Hold on the demo address | «جرّبه الآن. الرابط في الوصف.» | *Try it now. The link is in the description.* |

## Recording checklist (free tools only)

Tools: OBS Studio (screen and microphone), Audacity or OBS filters for noise, a free editor such as DaVinci Resolve (free edition) or Shotcut, and `.srt` subtitles written by hand. Browser: Chrome or Edge, window about 1280 x 720 or a phone-sized window for the chat shots.

Before recording:
1. Reset the demo: call `select public.reset_demo();` with the service role (or wait for the daily 03:00 UTC job). This clears old demo data and mailboxes.
2. Confirm env: `DEMO_MODE=true`; on the hosted site payments need Moyasar test keys, because the fake provider is refused on a Vercel production deployment.
3. Confirm `GOOGLE_GENERATIVE_AI_API_KEY` is set and the free quota is not used up (chat limit: 20 messages per 10 minutes per IP; voice 6 per 10 minutes). Do a dry run first, counting your messages.
4. Use a fresh browser profile with microphone permission allowed, so the demo mailbox cookie (`dawrak_demo_session`) is clean. Keep one profile for the customer shots and one for the owner shots.
5. Do not show real keys, the Supabase dashboard, or `.env` files on screen.

The reminder shot (6):
1. In the customer profile, book a slot through the web form on `/ar/c/demo-clinic`, with an email address, on a time a little more than 2 hours from now (the 2h reminder is only created if its send time is still in the future).
2. When the 2h-before moment has passed, trigger the dispatcher: run the "reminders" GitHub Action manually (`workflow_dispatch`) or POST to `/api/cron/reminders` with `Authorization: Bearer <CRON_SECRET>`. Then open `/ar/demo/mailbox` and record. (Whether this works on the hosted demo has not been run by the author: unverified.)
3. A shorter alternative: on the patient page use "send me my link"; that mail also lands in the demo mailbox immediately. Say "رابط الإدارة" rather than "تذكير" if you use this.

After recording: run `reset_demo()` again so the published demo is clean. Add the Arabic voice-over as a separate audio track, export the English subtitles as `.srt`, and keep the final file small enough for Mostaqel's upload limit (limit unverified).
