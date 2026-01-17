const STORAGE_KEY = "networkFetchCooldownUntil";
const COOLDOWN_MS = 10 * 60 * 1000;

function safeGetItem(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // ignore
  }
}

export function isFailedToFetchError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : JSON.stringify(err, null, 2) ?? String(err);

  // Do NOT retry auth failures.
  // These are permanent until the user fixes credentials/token.
  if (/\b(401|403)\b/i.test(msg)) return false;

  // Do NOT treat generic 4xx as a network failure (except 429).
  if (/\b4\d\d\b/i.test(msg) && !/\b429\b/i.test(msg)) return false;

  // Covers browser fetch + Tauri plugin-http failures.
  return (
    /failed to fetch|fetch failed|networkerror|load failed/i.test(msg) ||
    /timeout|timed out|deadline exceeded/i.test(msg) ||
    /network is unreachable|connection (refused|reset|aborted)|broken pipe/i.test(msg) ||
    /dns|enotfound|econnrefused|econnreset|econnaborted/i.test(msg) ||
    /error sending request|request failed|channel closed|os error/i.test(msg) ||
    /\b(429|5\d\d)\b/.test(msg)
  );
}

export function getNetworkCooldownUntil(): number {
  const raw = safeGetItem(STORAGE_KEY);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function isInNetworkCooldown(now: number = Date.now()): boolean {
  return now < getNetworkCooldownUntil();
}

export function startNetworkCooldown(now: number = Date.now()): number {
  const until = now + COOLDOWN_MS;
  safeSetItem(STORAGE_KEY, String(until));
  return until;
}


