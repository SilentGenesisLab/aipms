import { describe, expect, it } from "vitest";
import { fromScheduleInput, toScheduleInput } from "./schedule-time";

describe("schedule input timezone", () => {
  it("renders a Shanghai midnight as 00:00 rather than the UTC 16:00 of the previous day", () => {
    expect(toScheduleInput("2026-09-20T16:00:00.000Z")).toBe("2026-09-21T00:00");
  });
  it("round-trips every whole-minute stored instant without moving it", () => {
    const instants = [
      "2026-09-20T16:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T23:59:00.000Z",
    ];
    for (const instant of instants)
      expect(fromScheduleInput(toScheduleInput(instant))).toBe(new Date(instant).toISOString());
  });
  it("truncates sub-minute precision to the minute, keeping the day", () => {
    // 库里有一批截止时间是 23:59:59（脚本批量建的）。datetime-local 只到分钟，
    // 用户保存表单会把它抹成 23:59:00 —— 同一天同一含义，但不是恒等变换。
    expect(toScheduleInput("2026-09-23T15:59:59.000Z")).toBe("2026-09-23T23:59");
    expect(fromScheduleInput("2026-09-23T23:59")).toBe("2026-09-23T15:59:00.000Z");
    expect(toScheduleInput("2026-09-23T15:59:59.000Z").slice(0, 10)).toBe("2026-09-23");
  });
  it("keeps the value that a previous UTC round-trip had already shifted 8 hours earlier", () => {
    // 2026-09-20T08:00Z 是线上被写坏的那条记录，读出来应当是 16:00 而不是 00:00。
    expect(toScheduleInput("2026-09-20T08:00:00.000Z")).toBe("2026-09-20T16:00");
    expect(fromScheduleInput("2026-09-20T16:00")).toBe("2026-09-20T08:00:00.000Z");
  });
  it("treats the input as Shanghai wall clock, not as the browser's local time", () => {
    expect(fromScheduleInput("2026-09-21T00:00")).toBe("2026-09-20T16:00:00.000Z");
    expect(fromScheduleInput("2026-09-21T09:30")).toBe("2026-09-21T01:30:00.000Z");
  });
  it("maps empty and malformed values to empty/null", () => {
    expect(toScheduleInput("")).toBe("");
    expect(toScheduleInput(null)).toBe("");
    expect(toScheduleInput(undefined)).toBe("");
    expect(toScheduleInput("not a date")).toBe("");
    expect(fromScheduleInput("")).toBeNull();
    expect(fromScheduleInput(null)).toBeNull();
    expect(fromScheduleInput("2026-09-21")).toBeNull();
  });
  it("ignores seconds the picker may append", () => {
    expect(fromScheduleInput("2026-09-21T00:00:30")).toBe("2026-09-20T16:00:00.000Z");
  });
});
