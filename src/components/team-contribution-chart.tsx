"use client";

import { BarChart3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type ContributionRange = "today" | "yesterday" | "7d" | "month";

export type ContributionPoint = {
  date: string;
  label: string;
  delivery: number;
  coordination: number;
  acceptance: number;
};

const ranges: Array<{ value: ContributionRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "近 7 日" },
  { value: "month", label: "本月" },
];

/** Stacking order is bottom-to-top; the legend reads in the order people scan it. */
const series = [
  { key: "acceptance", name: "验收", color: "#34d399" },
  { key: "coordination", name: "协同", color: "#a78bfa" },
  { key: "delivery", name: "交付", color: "#3b82f6" },
] as const;

const legend = [...series].reverse();

/** Shanghai calendar day for an instant, so the caption states real dates. */
function shanghaiDay(iso: string) {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

export function TeamContributionChart({
  points,
  granularity,
  start,
  end,
  range,
  onRangeChange,
}: {
  points: ContributionPoint[];
  granularity: "hour" | "day";
  start: string;
  end: string;
  range: ContributionRange;
  onRangeChange: (range: ContributionRange) => void;
}) {
  const total = points.reduce((sum, point) => sum + point.delivery + point.coordination + point.acceptance, 0);
  const data = points.map((point) => ({
    ...point,
    // The axis only carries the clock for hourly windows, so the tooltip title
    // has to reintroduce the date it belongs to.
    full: granularity === "hour" ? `${point.date.slice(5, 10)} ${point.label}` : point.date,
  }));
  const windowText =
    granularity === "hour"
      ? `${shanghaiDay(start)} 全天 · 24 小时`
      : `${shanghaiDay(start)} 至 ${shanghaiDay(new Date(new Date(end).getTime() - 1).toISOString())}`;

  return (
    <section className="card p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 size={18} />
            <h4 className="font-semibold">贡献趋势</h4>
          </div>
          <p className="mt-1 text-xs text-slate-500">{windowText}</p>
        </div>
        <div className="flex rounded-xl bg-slate-100 p-1 sm:ml-auto">
          {ranges.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onRangeChange(item.value)}
              className={`rounded-lg px-3 py-1.5 text-xs ${range === item.value ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-500"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 12, left: -24, bottom: 0 }}>
            <CartesianGrid stroke="#eef2f7" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              interval={granularity === "hour" ? 2 : "preserveStartEnd"}
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: "rgba(148, 163, 184, 0.12)" }}
              labelFormatter={(_value, payload) => payload?.[0]?.payload?.full ?? ""}
              formatter={(value, name) => [`${value} 项`, name]}
              contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
            />
            {series.map((item) => (
              <Bar key={item.key} dataKey={item.key} name={item.name} stackId="contribution" fill={item.color} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
        {legend.map((item) => (
          <span key={item.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
            {item.name}
          </span>
        ))}
        {total === 0 && <span className="text-slate-400">该区间暂无贡献记录</span>}
      </div>
    </section>
  );
}
