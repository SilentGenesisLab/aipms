import { usageRangeBounds, type UsageRange } from "@/lib/usage-analytics";

export type TrendGranularity = "hour" | "day";

export type TrendBucket = {
  date: string;
  label: string;
  delivery: number;
  coordination: number;
  acceptance: number;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Shanghai is UTC+8 year-round, so instant arithmetic needs no DST handling. */
const SHANGHAI_OFFSET = 8 * HOUR;

const pad = (value: number) => String(value).padStart(2, "0");

/** Shanghai wall-clock day and hour for an instant, without going through Intl. */
function shanghaiParts(at: Date) {
  const local = new Date(at.getTime() + SHANGHAI_OFFSET);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

/**
 * The window the contribution chart covers for a range. Single days are bucketed
 * hourly so one day reads as 24 points; multi-day ranges are bucketed daily.
 * `start`/`end` bound the rows that have to be fetched, and the buckets come back
 * pre-seeded at zero so callers only increment them.
 */
export function trendWindow(range: UsageRange) {
  const { start, end } = usageRangeBounds(range);
  const granularity: TrendGranularity = range === "today" || range === "yesterday" ? "hour" : "day";
  const step = granularity === "hour" ? HOUR : DAY;
  const buckets: TrendBucket[] = Array.from(
    { length: Math.round((end.getTime() - start.getTime()) / step) },
    (_, index) => {
      const { day, hour } = shanghaiParts(new Date(start.getTime() + index * step));
      return {
        date: granularity === "hour" ? `${day}T${pad(hour)}` : day,
        label: granularity === "hour" ? `${pad(hour)}:00` : day.slice(5),
        delivery: 0,
        coordination: 0,
        acceptance: 0,
      };
    },
  );
  return { granularity, start, end, buckets };
}

/** The bucket a timestamp belongs to, matching the `date` keys from `trendWindow`. */
export function trendBucketKey(at: Date, granularity: TrendGranularity) {
  const { day, hour } = shanghaiParts(at);
  return granularity === "hour" ? `${day}T${pad(hour)}` : day;
}
