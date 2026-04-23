type TranslateFn = (key: string, options?: Record<string, unknown>) => unknown;

function translate(t: TranslateFn, key: string, options?: Record<string, unknown>): string {
  const value = t(key, options);
  return typeof value === "string" ? value : String(value ?? "");
}

export function formatRelativeTimeAgo(timestampMs: number, nowMs: number, t: TranslateFn): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  if (diffMs < 60 * 60 * 1000) {
    const minutes = Math.floor(diffMs / (60 * 1000));
    return translate(t, "features.dashboard.minutesAgo", { count: minutes, defaultValue: "{{count}}m ago" });
  }
  if (diffMs < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diffMs / (60 * 60 * 1000));
    return translate(t, "features.dashboard.hoursAgo", { count: hours, defaultValue: "{{count}}h ago" });
  }
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return translate(t, "features.dashboard.daysAgo", { count: days, defaultValue: "{{count}}d ago" });
}
