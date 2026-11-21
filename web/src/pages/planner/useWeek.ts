import { useMemo } from "react";
import { toQuery, type Context, type Summary, type Weekdays } from "../dashboard/types";
import { useApi } from "../flows/useApi";
import { busiestShifts, type Shift } from "./types";

export type Week = {
  ready: boolean;                    // the answers are for the boroughs asked about
  grid: Weekdays["grid"];            // average pickups for every weekday and hour
  tripSec: number | null;            // average trip time in these boroughs
  // the busiest zones over every loaded day and hour, as on the dashboard: a
  // starting point when there are too few trips to recommend by the hour
  topZones: { id: number; name: string; pickups: number }[];
  error: string;
  months: string;                    // the loaded months the planner learns from, e.g. "Jan–Mar 2026"
};

const monthName = (iso: string) =>
  new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleString("en", { month: "short", timeZone: "UTC" });

// The week for the chosen boroughs over every loaded date (MongoDB's
// borough-hour summary, GET /dashboard/weekdays), for the busiest shifts, and
// the average trip time (GET /dashboard), for the suggested fleet.
export function useWeek(boroughs: string[]): Week {
  const context = useApi<Context>("/dashboard/context");
  const c = context.data;
  const q = c?.dateFrom && c.dateTo && boroughs.length
    ? toQuery({ dateFrom: c.dateFrom, dateTo: c.dateTo, weekdays: [], hourFrom: null, hourTo: null, boroughs,
                metric: "pickups" })
    : null;
  const weekPath = q && `/dashboard/weekdays?${q}`;
  const summaryPath = q && `/dashboard?${q}`;
  const week = useApi<Weekdays>(weekPath);
  const summary = useApi<Summary>(summaryPath);
  const grid = useMemo(() => week.data?.grid ?? [], [week.data]);
  const months = c?.dateFrom && c.dateTo
    ? (c.dateFrom.slice(0, 7) === c.dateTo.slice(0, 7) ? monthName(c.dateTo) : `${monthName(c.dateFrom)}–${monthName(c.dateTo)}`)
      + ` ${c.dateTo.slice(0, 4)}`
    : "every loaded month";
  return {
    ready: !!weekPath && week.path === weekPath && !!week.data && summary.path === summaryPath,
    grid,
    tripSec: summary.path === summaryPath ? summary.data?.totals.averageDurationSec ?? null : null,
    topZones: summary.path === summaryPath
      ? [...(summary.data?.zones ?? [])].sort((a, b) => b.pickups - a.pickups).slice(0, 3)
          .filter((z) => z.pickups > 0).map((z) => ({ id: z.zoneId, name: z.zoneName, pickups: z.pickups }))
      : [],
    error: week.error || context.error,
    months,
  };
}

// The `count` busiest shifts the `allow` test lets through: three hours long
// when they fit, otherwise the longest that does.
export function busiestAllowed(grid: Week["grid"], count: number,
                               allow?: (dow: number, hour: number) => boolean): Shift[] {
  for (let length = 3; length >= 1; length--) {
    const found = busiestShifts(grid, count, length, allow);
    if (found.length) return found.map(({ dow, from, to }) => ({ dow, from, to }));
  }
  return [];
}
