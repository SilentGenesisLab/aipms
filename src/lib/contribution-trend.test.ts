import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trendBucketKey, trendWindow } from "@/lib/contribution-trend";
import { shanghaiStart, usageRangeBounds } from "@/lib/usage-analytics";

/** 2026-09-20 10:30 in Shanghai. */
const SEPT_20 = new Date("2026-09-20T02:30:00Z");

describe("contribution trend windows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SEPT_20);
  });
  afterEach(() => vi.useRealTimers());

  it("buckets a single day into 24 hours with concrete clock labels", () => {
    const today = trendWindow("today");
    expect(today.granularity).toBe("hour");
    expect(today.buckets).toHaveLength(24);
    expect(today.buckets[0]).toEqual({ date: "2026-09-20T00", label: "00:00", delivery: 0, coordination: 0, acceptance: 0 });
    expect(today.buckets[23].date).toBe("2026-09-20T23");
    expect(today.buckets[23].label).toBe("23:00");
  });

  it("buckets yesterday into its own 24 hours", () => {
    const yesterday = trendWindow("yesterday");
    expect(yesterday.granularity).toBe("hour");
    expect(yesterday.buckets).toHaveLength(24);
    expect(yesterday.buckets[0].date).toBe("2026-09-19T00");
    expect(yesterday.buckets[23].date).toBe("2026-09-19T23");
  });

  it("buckets multi-day ranges by day and drops the year from the axis label", () => {
    const week = trendWindow("7d");
    expect(week.granularity).toBe("day");
    expect(week.buckets.map((bucket) => bucket.label)).toEqual(["09-14", "09-15", "09-16", "09-17", "09-18", "09-19", "09-20"]);

    const month = trendWindow("month");
    expect(month.granularity).toBe("day");
    expect(month.buckets).toHaveLength(20);
    expect(month.buckets[0].label).toBe("09-01");
    expect(month.buckets[19].label).toBe("09-20");
  });

  it("reaches back to the 1st even when a 30-day floor would not", () => {
    vi.setSystemTime(new Date("2026-10-31T02:30:00Z"));
    const month = trendWindow("month");
    expect(month.buckets).toHaveLength(31);
    expect(month.buckets[0].label).toBe("10-01");
    expect(month.start.getTime()).toBe(usageRangeBounds("month").start.getTime());
    // The old fixed 30-day floor started on the 2nd, so the 1st was never counted.
    expect(month.start.getTime()).toBeLessThan(shanghaiStart(-29).getTime());
  });

  it("maps timestamps onto the same keys the buckets use", () => {
    expect(trendBucketKey(new Date("2026-09-20T06:30:00Z"), "hour")).toBe("2026-09-20T14");
    expect(trendBucketKey(new Date("2026-09-19T16:00:00Z"), "hour")).toBe("2026-09-20T00");
    expect(trendBucketKey(new Date("2026-09-20T06:30:00Z"), "day")).toBe("2026-09-20");
    // 16:00 UTC is already the next day in Shanghai; 15:59 is not.
    expect(trendBucketKey(new Date("2026-09-20T15:59:00Z"), "day")).toBe("2026-09-20");
    expect(trendBucketKey(new Date("2026-09-20T16:00:00Z"), "day")).toBe("2026-09-21");
  });

  it("keeps every bucket reachable by the key function", () => {
    for (const range of ["today", "yesterday", "7d", "month"] as const) {
      const window = trendWindow(range);
      const keys = new Set(window.buckets.map((bucket) => bucket.date));
      expect(keys.size).toBe(window.buckets.length);
      for (const bucket of window.buckets) {
        const instant = new Date(bucket.date.length === 13 ? `${bucket.date}:00:00+08:00` : `${bucket.date}T00:00:00+08:00`);
        expect(trendBucketKey(instant, window.granularity)).toBe(bucket.date);
      }
    }
  });
});
