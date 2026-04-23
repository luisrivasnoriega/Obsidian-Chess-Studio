import { describe, expect, test } from "vitest";
import { formatRelativeTimeAgo } from "../relativeTime";

const fakeT = (key: string, options?: Record<string, unknown>) => `${key}:${String(options?.count ?? "")}`;

describe("formatRelativeTimeAgo", () => {
  test("uses minutes for intervals under one hour", () => {
    const value = formatRelativeTimeAgo(1_000, 1_000 + 20 * 60 * 1000, fakeT);
    expect(value).toBe("features.dashboard.minutesAgo:20");
  });

  test("uses hours for intervals under one day", () => {
    const value = formatRelativeTimeAgo(1_000, 1_000 + 5 * 60 * 60 * 1000, fakeT);
    expect(value).toBe("features.dashboard.hoursAgo:5");
  });

  test("uses days for long intervals", () => {
    const value = formatRelativeTimeAgo(1_000, 1_000 + 3 * 24 * 60 * 60 * 1000, fakeT);
    expect(value).toBe("features.dashboard.daysAgo:3");
  });
});
