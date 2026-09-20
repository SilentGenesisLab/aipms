const OFFSET_MS = 8 * 3_600_000;
const INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * ISO instant → 上海墙上时间（`YYYY-MM-DDTHH:mm`），可直接作为 <input type="datetime-local"> 的值。
 * 固定 +8 偏移而不是读浏览器时区：上海没有夏令时，偏移恒定，且这样和排期视图的取数口径一致。
 */
export function toScheduleInput(value: Date | string | null | undefined) {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 16);
}

/** <input type="datetime-local"> 的上海墙上时间 → ISO instant；空值或非法值返回 null。 */
export function fromScheduleInput(value: string | null | undefined) {
  if (!value) return null;
  const input = value.slice(0, 16);
  if (!INPUT.test(input)) return null;
  return new Date(`${input}:00+08:00`).toISOString();
}
