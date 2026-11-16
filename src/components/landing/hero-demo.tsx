"use client";

import { useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/brand/logo";

export type HeroCopy = {
  phoneTitle: string;
  phoneStatus: string;
  replay: string;
  play: string;
  threadLabel: string;
  day: string;
  dur: string;
  transcriptLabel: string;
  transcript: string;
  transcriptOriginal?: string;
  m2: string;
  m3: string;
  m4: string;
  slotsLabel: string;
  slots: [string, string, string];
  m5: string;
  m6: string;
  stamps: string[];
  ticketTitle: string;
  ticketOk: string;
  ticketRows: { k: string; v: string }[];
  composer: string;
  typing: string;
  calTitle: string;
  calDate: string;
  calLive: string;
  rows: { time: string; name?: string; sub?: string; kind: "busy" | "free" | "new" }[];
  free: string;
  newBadge: string;
  newName: string;
  newSvc: string;
  calFoot: string;
  isArabic: boolean;
};

const BARS = [30, 55, 80, 45, 95, 60, 35, 70, 100, 50, 25, 65, 85, 40, 75, 30, 55, 20, 45, 30];

type Phase = "static" | "playing" | "done";

/**
 * The scripted booking. The first render (server and no-JS) is the final state. When JS runs and the
 * user does not prefer reduced motion, it resets and plays; otherwise it stays on the final state.
 */
export function HeroDemo({ copy }: { copy: HeroCopy }) {
  const [phase, setPhase] = useState<Phase>("static");
  const [step, setStep] = useState(6);
  const [typing, setTyping] = useState(false);
  const [picked, setPicked] = useState(true);
  const [cal, setCal] = useState(true);
  const [wave, setWave] = useState(BARS.length);
  const [playingVoice, setPlayingVoice] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const fillWave = (ms: number) => {
    const per = ms / BARS.length;
    setPlayingVoice(true);
    setWave(0);
    for (let i = 1; i <= BARS.length; i++) later(() => setWave(i), per * i);
    later(() => setPlayingVoice(false), ms + 50);
  };

  const run = () => {
    clear();
    setPhase("playing");
    setStep(0);
    setTyping(false);
    setPicked(false);
    setCal(false);
    setWave(0);
    setPlayingVoice(false);
    const typeThen = (at: number, n: number, ms: number) => {
      later(() => setTyping(true), at);
      later(() => {
        setTyping(false);
        setStep(n);
      }, at + ms);
    };
    later(() => {
      setStep(1);
      fillWave(1800);
    }, 600);
    typeThen(2700, 2, 1100);
    later(() => setStep(3), 5000);
    typeThen(5700, 4, 1000);
    later(() => setPicked(true), 7800);
    later(() => setStep(5), 8200);
    typeThen(8800, 6, 1300);
    later(() => setCal(true), 10100); // same moment the ticket appears
    later(() => setPhase("done"), 10300);
  };

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) timers.current.push(setTimeout(run, 0));
    return clear;
    // run only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animated = phase !== "static";
  const show = (n: number) => step >= n;
  const enter = animated ? "lp-enter" : "";
  const dirAttr = copy.isArabic ? "rtl" : "ltr";

  return (
    <div className="lp-stage" data-testid="hero-demo" data-phase={phase}>
      <div className="lp-phone" role="group" aria-labelledby="lp-phone-title">
        <div className="lp-phone-head">
          <span className="lp-avatar" aria-hidden="true">
            <LogoMark size={40} />
          </span>
          <div className="lp-who">
            <strong id="lp-phone-title">{copy.phoneTitle}</strong>
            <span className="lp-status">
              <i className="lp-dot" aria-hidden="true" /> {copy.phoneStatus}
            </span>
          </div>
          <button
            type="button"
            className="lp-replay"
            data-testid="hero-replay"
            aria-label={copy.replay}
            hidden={phase !== "done"}
            onClick={run}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v4.5h4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className="lp-scroll" tabIndex={0} role="group" aria-label={copy.threadLabel}>
          <div className="lp-thread">
            <p className="lp-day">{copy.day}</p>

            {show(1) && (
              <div className={`lp-msg lp-me ${enter}`} data-testid="msg-1">
                <div className="lp-voice">
                  <button
                    type="button"
                    className="lp-play"
                    aria-label={copy.play}
                    aria-pressed={playingVoice}
                    onClick={() => {
                      if (!playingVoice) fillWave(1800);
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <path className="lp-i-play" d="M8 5.5v13l11-6.5z" fill="currentColor" />
                      <path className="lp-i-pause" d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
                    </svg>
                  </button>
                  <div className="lp-wave" aria-hidden="true">
                    {BARS.map((h, i) => (
                      <i key={i} className={i < wave ? "on" : ""} style={{ height: `${h}%` }} />
                    ))}
                  </div>
                  <span className="lp-dur">{copy.dur}</span>
                </div>
                <p className="lp-transcript">
                  <span>{copy.transcriptLabel}</span>
                  {copy.transcript}
                  {copy.transcriptOriginal ? (
                    <bdi className="lp-orig" lang="ar" dir="rtl" style={{ display: "block" }}>
                      {copy.transcriptOriginal}
                    </bdi>
                  ) : null}
                </p>
                <time className="lp-stamp">{copy.stamps[0]}</time>
              </div>
            )}

            {show(2) && (
              <div className={`lp-msg lp-bot ${enter}`} data-testid="msg-2">
                <p>{copy.m2}</p>
                <time className="lp-stamp">{copy.stamps[1]}</time>
              </div>
            )}

            {show(3) && (
              <div className={`lp-msg lp-me ${enter}`} data-testid="msg-3">
                <p>{copy.m3}</p>
                <time className="lp-stamp">{copy.stamps[2]}</time>
              </div>
            )}

            {show(4) && (
              <div className={`lp-msg lp-bot ${enter}`} data-testid="msg-4">
                <p>{copy.m4}</p>
                <div className="lp-slots" role="group" aria-label={copy.slotsLabel}>
                  <span className="lp-slot">{copy.slots[0]}</span>
                  <span className={`lp-slot ${picked ? "chosen" : ""}`}>{copy.slots[1]}</span>
                  <span className="lp-slot">{copy.slots[2]}</span>
                </div>
                <time className="lp-stamp">{copy.stamps[3]}</time>
              </div>
            )}

            {show(5) && (
              <div className={`lp-msg lp-me ${enter}`} data-testid="msg-5">
                <p>{copy.m5}</p>
                <time className="lp-stamp">{copy.stamps[4]}</time>
              </div>
            )}

            {show(6) && (
              <div className={`lp-msg lp-bot ${enter}`} data-testid="msg-6">
                <p>{copy.m6}</p>
                <div className="lp-ticket" data-testid="ticket">
                  <div className="lp-ticket-top">
                    <strong>{copy.ticketTitle}</strong>
                    <span className="lp-ok">{copy.ticketOk}</span>
                  </div>
                  <dl>
                    {copy.ticketRows.map((r) => (
                      <div key={r.k}>
                        <dt>{r.k}</dt>
                        <dd>{r.v}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <time className="lp-stamp">{copy.stamps[5]}</time>
              </div>
            )}

            {typing && (
              <div className="lp-msg lp-bot lp-typing" role="img" aria-label={copy.typing}>
                <i />
                <i />
                <i />
              </div>
            )}
          </div>
        </div>

        <div className="lp-composer" aria-hidden="true">
          <span className="lp-composer-field">{copy.composer}</span>
          <span className="lp-mic">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0M12 17v3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
        </div>
      </div>

      <aside className="lp-cal" aria-labelledby="lp-cal-title" dir={dirAttr}>
        <div className="lp-cal-head">
          <div>
            <h2 id="lp-cal-title">{copy.calTitle}</h2>
            <p>{copy.calDate}</p>
          </div>
          <span className={`lp-live ${cal ? "" : "off"}`} data-testid="cal-live" aria-hidden={!cal}>
            {copy.calLive}
          </span>
        </div>
        <ol className="lp-rows">
          {copy.rows.map((r, i) => (
            <li key={i}>
              <time>{r.time}</time>
              {r.kind === "busy" ? (
                <div className="lp-ev lp-busy">
                  {r.name} <small>{r.sub}</small>
                </div>
              ) : r.kind === "free" ? (
                <div className="lp-ev lp-free">{copy.free}</div>
              ) : (
                <div className={`lp-ev lp-new ${cal ? "" : "off"}`} data-testid="cal-new" aria-hidden={!cal}>
                  <span className="lp-badge">{copy.newBadge}</span>
                  <strong>{copy.newName}</strong>
                  <small>{copy.newSvc}</small>
                </div>
              )}
            </li>
          ))}
        </ol>
        <p className="lp-cal-foot">{copy.calFoot}</p>
      </aside>
    </div>
  );
}
