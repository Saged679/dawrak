import { getTranslations } from "next-intl/server";
import { formatGregorian, formatHijri, type Loc } from "@/components/booking/dates";
import { Link } from "@/i18n/navigation";
import { CountUp } from "@/components/motion/count-up";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { HeroDemo, type HeroCopy } from "./hero-demo";
import "./landing.css";

const SAMPLE_DAY = "2026-11-15"; // a Sunday
const SAMPLE_WIDGET_DAY = "2026-11-16";
const SAMPLE_WEEK = ["2026-11-15", "2026-11-19"];

type T = Awaited<ReturnType<typeof getTranslations>>;
const split = (s: string) => s.split("|");

function Hijri({ k, locale }: { k: string; locale: Loc }) {
  return <>{formatHijri(k, undefined, locale)}</>;
}

export async function LandingPage({ locale }: { locale: Loc }) {
  const t = await getTranslations({ locale, namespace: "Landing" });
  const isAr = locale === "ar";
  const longG = (k: string) =>
    formatGregorian(k, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const shortG = (k: string, year = false) =>
    formatGregorian(k, locale, { day: "numeric", month: "long", ...(year ? { year: "numeric" } : {}) });
  const hijriShort = (k: string, year = false) =>
    formatHijri(k, year ? undefined : { day: "numeric", month: "long" }, locale);

  const heroCopy: HeroCopy = {
    isArabic: isAr,
    phoneTitle: t("hero.phoneTitle"),
    phoneStatus: t("hero.phoneStatus"),
    replay: t("hero.replay"),
    play: t("hero.play"),
    threadLabel: t("hero.threadLabel"),
    day: t("hero.day"),
    dur: t("hero.dur"),
    transcriptLabel: t("hero.transcriptLabel"),
    transcript: t("hero.transcript"),
    transcriptOriginal: t("hero.transcriptOriginal") || undefined,
    m2: t("hero.m2", { day: shortG(SAMPLE_DAY) }),
    m3: t("hero.m3"),
    m4: t("hero.m4"),
    slotsLabel: t("hero.slotsLabel"),
    slots: [t("hero.slot1"), t("hero.slot2"), t("hero.slot3")],
    m5: t("hero.m5"),
    m6: t("hero.m6"),
    stamps: [1, 2, 3, 4, 5, 6].map((n) => t(`hero.t${n}`)),
    ticketTitle: t("hero.ticketTitle"),
    ticketOk: t("hero.ticketOk"),
    ticketRows: [
      { k: t("hero.kDoctor"), v: t("hero.vDoctor") },
      { k: t("hero.kWhen"), v: t("hero.vWhen", { date: longG(SAMPLE_DAY) }) },
      { k: t("hero.kHijri"), v: formatHijri(SAMPLE_DAY, undefined, locale) },
    ],
    composer: t("hero.composer"),
    typing: t("hero.typing"),
    calTitle: t("hero.calTitle"),
    calDate: t("hero.calDate", { date: longG(SAMPLE_DAY), hijri: formatHijri(SAMPLE_DAY, undefined, locale) }),
    calLive: t("hero.calLive"),
    rows: [
      { time: t("hero.r1"), name: t("hero.r1n"), sub: t("hero.r1s"), kind: "busy" },
      { time: t("hero.r2"), kind: "free" },
      { time: t("hero.r3"), kind: "new" },
      { time: t("hero.r4"), name: t("hero.r4n"), sub: t("hero.r4s"), kind: "busy" },
      { time: t("hero.r5"), kind: "free" },
    ],
    free: t("hero.free"),
    newBadge: t("hero.newBadge"),
    newName: t("hero.newName"),
    newSvc: t("hero.newSvc"),
    calFoot: t("hero.calFoot"),
  };

  const days = split(t("dash.days"));
  const weekCols = [t("dash.d1"), t("dash.d2"), t("dash.d3"), t("dash.d4"), t("dash.d5")].map(split);
  const other = isAr ? "en" : "ar";

  return (
    <div className="lp">
      <ScrollReveal />
      <a className="lp-skip" href="#main">
        {t("nav.skip")}
      </a>

      <header className="lp-topbar">
        <div className="lp-wrap lp-topbar-in">
          <Link className="lp-brand" href="/">
            <span className="lp-mark" aria-hidden="true">
              {isAr ? "د" : "D"}
            </span>
            <span className="lp-brand-name">{t("nav.brand")}</span>
          </Link>
          <nav aria-label={t("nav.sections")} className="lp-nav-wrap" style={{ display: "contents" }}>
            <ul className="lp-nav">
              <li><a href="#how">{t("nav.how")}</a></li>
              <li><a href="#assistant">{t("nav.assistant")}</a></li>
              <li><a href="#dashboard">{t("nav.dashboard")}</a></li>
              <li><a href="#faq">{t("nav.faq")}</a></li>
            </ul>
          </nav>
          <Link className="lp-switch" href="/" locale={other} lang={other} hrefLang={other} aria-label={t("nav.switchAria")}>
            {t("nav.switchLabel")}
          </Link>
          <Link className="lp-btn lp-btn-sm lp-saffron" href="/demo">
            {t("nav.demo")}
          </Link>
        </div>
      </header>

      <main id="main">
        <section className="lp-hero" aria-labelledby="hero-h1">
          <div className="lp-wrap lp-hero-grid">
            <div>
              <h1 id="hero-h1">{t("hero.h1")}</h1>
              <p className="lp-lead">{t("hero.lead")}</p>
              <div className="lp-actions">
                <Link className="lp-btn lp-saffron" href="/demo">{t("hero.ctaDemo")}</Link>
                <Link className="lp-btn lp-ghost" href="/c/demo-clinic">{t("hero.ctaClinic")}</Link>
              </div>
              <p className="lp-hero-note">{t("hero.note")}</p>
            </div>
            <HeroDemo copy={heroCopy} />
          </div>
          <div className="lp-wrap">
            <p className="lp-sample">{t("hero.sample")}</p>
          </div>
        </section>

        <section className="lp-sec" id="how" aria-labelledby="how-h">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="how-h">{t("how.title")}</h2>
              <p>{t("how.lead")}</p>
            </div>
            <div className="lp-two">
              <ol className="lp-steps">
                {[1, 2, 3, 4].map((n) => (
                  <li key={n}>
                    <span className="lp-n" aria-hidden="true">{isAr ? ["١", "٢", "٣", "٤"][n - 1] : n}</span>
                    <div>
                      <h3>{t(`how.s${n}t`)}</h3>
                      <p>{t(`how.s${n}d`)}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="lp-widget" role="group" aria-label={t("how.widgetLabel")}>
                <div className="lp-widget-top">
                  <strong>{t("how.wName")}</strong>
                  <span>{t("how.wDate", { date: shortG(SAMPLE_WIDGET_DAY), hijri: hijriShort(SAMPLE_WIDGET_DAY) })}</span>
                </div>
                <p className="lp-label">{t("how.wService")}</p>
                <div className="lp-chips">
                  <span className="lp-chip">{t("how.c1")}</span>
                  <span className="lp-chip lp-on">{t("how.c2")}</span>
                  <span className="lp-chip">{t("how.c3")}</span>
                </div>
                <p className="lp-label">{t("how.wProvider")}</p>
                <div className="lp-chips">
                  <span className="lp-chip lp-on">{t("how.p1")}</span>
                  <span className="lp-chip">{t("how.p2")}</span>
                </div>
                <p className="lp-label">{t("how.wTime")}</p>
                <div className="lp-chips">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <span
                      key={n}
                      className={`lp-t ${n === 3 ? "lp-sel" : ""} ${n === 1 || n === 5 ? "lp-off" : ""}`}
                      title={n === 1 || n === 5 ? t("how.unavailable") : undefined}
                    >
                      {t(`how.tm${n}`)}
                    </span>
                  ))}
                </div>
                <div className="lp-widget-foot">
                  <span>{t("how.wSummary")}</span>
                  <span className="lp-fake-btn" aria-hidden="true">{t("how.wConfirm")}</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-sec lp-tint" id="assistant" aria-labelledby="as-h">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="as-h">{t("assistant.title")}</h2>
              <p>{t("assistant.lead")}</p>
            </div>
            <div className="lp-feats">
              {[1, 2, 3, 4].map((n) => (
                <div key={n}>
                  <h3>{t(`assistant.f${n}t`)}</h3>
                  <p>{t(`assistant.f${n}d`)}</p>
                </div>
              ))}
            </div>
            <div className="lp-chan">
              <div>
                <h3>{t("assistant.chanTitle")}</h3>
                <p>{t("assistant.chanD")}</p>
              </div>
              <ul className="lp-pills">
                <li className="lp-pill">{t("assistant.chanWeb")} <span className="lp-state lp-s-live">{t("assistant.live")}</span></li>
                <li className="lp-pill">{t("assistant.chanWa")} <span className="lp-state lp-s-plan">{t("assistant.planned")}</span></li>
              </ul>
            </div>
            <div className="lp-duo">
              <figure className="lp-mini">
                <figcaption>{t("assistant.priceCap")}</figcaption>
                <div className="lp-minit">
                  <p className="lp-b lp-me">{t("assistant.q1")}</p>
                  <p className="lp-b lp-bot">{t("assistant.a1")}</p>
                  <p className="lp-b lp-me">{t("assistant.q2")}</p>
                  <p className="lp-b lp-bot">{t("assistant.a2")}</p>
                </div>
              </figure>
              <figure className="lp-mini lp-mini-note">
                <figcaption>{t("assistant.limitCap")}</figcaption>
                <div className="lp-minit">
                  <p className="lp-b lp-me">{t("assistant.q3")}</p>
                  <p className="lp-b lp-bot">{t("assistant.a3")}</p>
                </div>
                <p className="lp-note">{t("assistant.handoffNote")}</p>
              </figure>
            </div>
          </div>
        </section>

        <section className="lp-sec" id="dashboard" aria-labelledby="dash-h">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="dash-h">{t("dash.title")}</h2>
              <p>{t("dash.lead")}</p>
            </div>
            <div className="lp-dash" role="group" aria-label={t("dash.label")}>
              <div className="lp-card">
                <div className="lp-bar">
                  <strong>{t("dash.week")}</strong>
                  <span>
                    {t("dash.range", {
                      g: `${shortG(SAMPLE_WEEK[0])} – ${shortG(SAMPLE_WEEK[1], true)}`,
                      h: `${hijriShort(SAMPLE_WEEK[0])} – ${hijriShort(SAMPLE_WEEK[1], true)}`,
                    })}
                  </span>
                </div>
                <div className="lp-week">
                  {weekCols.map((col, i) => (
                    <div key={i}>
                      <h3 className="lp-day-h">{days[i]}</h3>
                      {col.map((e, j) => (
                        <p key={j} className={`lp-e ${i === 0 && j === 1 ? "lp-e-new" : ""}`}>{e}</p>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="lp-note" style={{ color: "var(--lp-muted)" }}>
                  <span className="lp-sample-chip">{t("dash.sample")}</span>
                </p>
              </div>
              <div className="lp-side">
                <div className="lp-nums">
                  <h3>{t("dash.numbers")}</h3>
                  <dl>
                    {[1, 2, 3].map((n) => (
                      <div key={n}>
                        <dt>{t(`dash.n${n}`)}</dt>
                        <dd><CountUp text={t(`dash.n${n}v`)} /></dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div className="lp-card lp-inbox">
                  <h3>
                    {t("dash.inbox")} <small>{t("dash.readOnly")}</small>
                  </h3>
                  <ul>
                    {[
                      ["i1", ""],
                      ["i2", "lp-tag-q"],
                      ["i3", "lp-tag-x"],
                    ].map(([k, cls]) => (
                      <li key={k}>
                        <span className="lp-whoi">{t(`dash.${k}`)}</span>
                        <span className="lp-what">{t(`dash.${k}w`)}</span>
                        <span className={`lp-tag ${cls}`}>{t(`dash.${k}t`)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
            <p className="lp-fine" style={{ marginTop: 14 }}>{t("dash.note")}</p>
          </div>
        </section>

        <section className="lp-sec lp-tint" id="reminders" aria-labelledby="rem-h">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="rem-h">{t("rem.title")}</h2>
              <p>{t("rem.lead")}</p>
            </div>
            <div className="lp-trio">
              {[1, 2, 3].map((n) => (
                <div key={n}>
                  <h3>{t(`rem.c${n}t`)}</h3>
                  <p>{t(`rem.c${n}d`)}</p>
                </div>
              ))}
            </div>
            <div className="lp-mail-card" role="group" aria-label={t("rem.mailLabel")}>
              <small>{t("rem.mailLabel")}</small>
              <b>{t("rem.mailSubject")}</b>
              <p>{t("rem.mailBody")}</p>
            </div>
            <p className="lp-callout">{t("rem.sms")}</p>
          </div>
        </section>

        <section className="lp-sec" id="payments" aria-labelledby="pay-h">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="pay-h">{t("pay.title")}</h2>
              <p>{t("pay.lead")}</p>
            </div>
            <ol className="lp-pay">
              {[1, 2, 3].map((n) => (
                <li key={n}>
                  <span className="lp-n" aria-hidden="true">{isAr ? ["١", "٢", "٣"][n - 1] : n}</span>
                  <p>{t(`pay.p${n}`)}</p>
                </li>
              ))}
            </ol>
            <p className="lp-callout">{t("pay.test")}</p>
          </div>
        </section>

        <section className="lp-sec lp-tint" id="languages" aria-labelledby="lang-h">
          <div className="lp-wrap lp-langs">
            <div>
              <div className="lp-head" style={{ marginBottom: 20 }}>
                <h2 id="lang-h">{t("lang.title")}</h2>
                <p>{t("lang.lead")}</p>
              </div>
              <ul className="lp-list">
                {[1, 2, 3].map((n) => (
                  <li key={n}>{t(`lang.a${n}`)}</li>
                ))}
              </ul>
            </div>
            <div className="lp-dates">
              <div className="lp-date" lang="ar" dir="rtl">
                <small>{t("lang.sampleAr")}</small>
                <p><bdi>{formatGregorian(SAMPLE_DAY, "ar", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</bdi></p>
                <p><Hijri k={SAMPLE_DAY} locale="ar" /></p>
              </div>
              <div className="lp-date" lang="en" dir="ltr">
                <small>{t("lang.sampleEn")}</small>
                <p>{formatGregorian(SAMPLE_DAY, "en", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
                <p><Hijri k={SAMPLE_DAY} locale="en" /></p>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-sec" id="clinics" aria-labelledby="multi-h">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="multi-h">{t("multi.title")}</h2>
              <p>{t("multi.lead")}</p>
            </div>
            <div className="lp-sites">
              <div className="lp-site">
                <small>{t("multi.clinic")}</small>
                <code>/{locale}/c/demo-clinic</code>
                <Link className="lp-link" href="/c/demo-clinic">{t("multi.open")}</Link>
              </div>
              <div className="lp-site">
                <small>{t("multi.salon")}</small>
                <code>/{locale}/c/demo-salon</code>
                <Link className="lp-link" href="/c/demo-salon">{t("multi.open")}</Link>
              </div>
            </div>
            <p className="lp-fine" style={{ marginTop: 16, maxWidth: "44em" }}>{t("multi.iso")}</p>
          </div>
        </section>

        <section className="lp-sec lp-tint" id="faq" aria-labelledby="faq-h">
          <div className="lp-wrap">
            <div className="lp-head">
              <h2 id="faq-h">{t("faq.title")}</h2>
            </div>
            <div className="lp-faq">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <details key={n}>
                  <summary>{t(`faq.q${n}`)}</summary>
                  <p>{t(`faq.a${n}`)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-cta" id="try" aria-labelledby="cta-h">
          <div className="lp-wrap lp-cta-in">
            <div>
              <h2 id="cta-h">{t("cta.title")}</h2>
              <p>{t("cta.lead")}</p>
            </div>
            <div className="lp-cta-actions">
              <Link className="lp-btn lp-btn-lg lp-saffron" href="/demo">{t("cta.demo")}</Link>
              <Link className="lp-btn lp-ghost" href="/c/demo-clinic">{t("cta.clinic")}</Link>
              <p>{t("cta.fine")}</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-in">
          <div className="lp-brand">
            <span className="lp-mark" aria-hidden="true">{isAr ? "د" : "D"}</span>
            <span className="lp-brand-name">{t("nav.brand")}</span>
          </div>
          <p>{t("foot.tag")}</p>
          <nav aria-label={t("foot.label")}>
            <ul>
              <li><Link href="/demo">{t("foot.demo")}</Link></li>
              <li><Link href="/c/demo-clinic">{t("foot.clinic")}</Link></li>
              <li><Link href="/login">{t("foot.login")}</Link></li>
            </ul>
          </nav>
          <p className="lp-fine">{t("foot.note")}</p>
        </div>
      </footer>
    </div>
  );
}

export type { T };
