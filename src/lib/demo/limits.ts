export type RateFn = (key: string, max: number, window: string) => Promise<boolean>;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Limits on CREATING a demo visitor. Order matters: the per-IP hour and day limits come first, and only a request
 * that passed both is counted against the global per-minute budget, so one noisy IP can never use up the budget
 * of everybody else (its blocked calls consume nothing globally).
 */
export async function demoCreateAllowed(ip: string, rateLimitOk: RateFn): Promise<boolean> {
  if (!(await rateLimitOk(`ip:${ip}:demo:h`, envInt("DEMO_SIGNIN_PER_HOUR", 3), "1 hour"))) return false;
  if (!(await rateLimitOk(`ip:${ip}:demo:d`, envInt("DEMO_SIGNIN_PER_DAY", 10), "1 day"))) return false;
  return rateLimitOk("demo:create:global", envInt("DEMO_CREATE_PER_MINUTE", 20), "1 minute");
}
