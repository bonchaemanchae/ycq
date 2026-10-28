import { useCallback, useEffect, useMemo, useState } from "react";
import { type Borough } from "../api";
import ZoneMap from "../components/ZoneMap";
import ActivityChart from "./dashboard/ActivityChart";
import DashboardFilters from "./dashboard/Filters";
import Imbalances from "./dashboard/Imbalances";
import TotalsRow from "./dashboard/Totals";
import WeekdayChart from "./dashboard/WeekdayChart";
import ZoneCompare from "./dashboard/ZoneCompare";
import ZoneTable from "./dashboard/ZoneTable";
import {
  METRICS, WEEKDAYS, count, hourLabel, toQuery,
  type Compare, type Context, type Filters, type Series, type Summary, type Weekdays,
} from "./dashboard/types";
import { useApi } from "./flows/useApi";
import "./dashboard/dashboard.css";

// Activity Dashboard (Kessler). Routes are in api/routers/dashboard.py, the
// MongoDB pipelines ($facet, $setWindowFields, $median, $percentile) in
// api/dashboard.py. Everything on the page follows the same filters.

const MAX_HOURLY_DAYS = 31;

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000) + 1;

export default function Dashboard() {
  const context = useApi<Context>("/dashboard/context");
  const boroughs = useApi<Borough[]>("/boroughs");
  const [filters, setFilters] = useState<Filters | null>(null);
  const [bucket, setBucket] = useState<"hour" | "day">("day");
  const [compareIds, setCompareIds] = useState<number[]>([]);

  // Start with every loaded date.
  const bounds = context.data?.dateFrom && context.data.dateTo
    ? { dateFrom: context.data.dateFrom, dateTo: context.data.dateTo } : null;
  useEffect(() => {
    if (filters === null && bounds) {
      setFilters({ ...bounds, weekdays: [], hourFrom: null, hourTo: null, boroughs: [], metric: "pickups" });
    }
  }, [bounds, filters]);

  const hourlyAllowed = !!filters && daysBetween(filters.dateFrom, filters.dateTo) <= MAX_HOURLY_DAYS;
  const shownBucket = hourlyAllowed ? bucket : "day";

  // Each path changes with the filters; useApi drops answers to older ones.
  const q = filters && toQuery(filters);
  const summary = useApi<Summary>(q && `/dashboard?${q}`);
  const series = useApi<Series>(filters && `/dashboard/series?${toQuery(filters, { bucket: shownBucket })}`);
  const weekdays = useApi<Weekdays>(q && `/dashboard/weekdays?${q}`);
  const compare = useApi<Compare>(filters && compareIds.length
    ? `/dashboard/compare?${toQuery({ ...filters }, { zoneIds: compareIds })}` : null);

  const toggleCompare = useCallback((id: number) => setCompareIds((ids) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= 3 ? ids : [...ids, id]), []);

  const metric = filters?.metric ?? "pickups";
  const values = useMemo(
    () => Object.fromEntries((summary.data?.zones ?? []).map((z) => [z.zoneId, z[metric]])),
    [summary.data, metric]);
  const metricLabel = METRICS.find((m) => m.value === metric)!.label.toLowerCase();

  const ctx = context.data;
  const setupError = context.error || boroughs.error;

  return (
    <section className="dashboard">
      <div className="page-head">
        <h1>Activity Dashboard</h1>
        <p className="muted">
          Where and when taxis are busy: pickups, drop-offs and the imbalance between them for every zone, over
          the dates, days, hours and boroughs you pick. Read from MongoDB's hourly zone activity, which is checked
          against PostgreSQL after every load.
        </p>
      </div>

      {setupError && <div className="alert error"><span>{setupError}</span></div>}
      {ctx && !bounds && (
        <div className="card"><p className="muted">No data is loaded yet. Run the loader first.</p></div>
      )}

      {filters && (
        <DashboardFilters filters={filters} onChange={setFilters} bounds={bounds}
                          boroughs={(boroughs.data ?? []).map((b) => b.name)} />
      )}
      {summary.error && <div className="alert error"><span>{summary.error}</span></div>}

      {summary.data && (
        <div className={summary.loading ? "dash-stale" : ""}>
          <TotalsRow totals={summary.data.totals} />
        </div>
      )}

      <div className="split">
        <div className="card">
          <div className="card-head">
            <div className="card-title">
              Zones by {metricLabel}
              {summary.loading && summary.data && <span className="tag">updating…</span>}
            </div>
          </div>
          <ZoneMap values={values} label={metricLabel} onZoneClick={toggleCompare} diverging={metric === "imbalance"} />
          <p className="muted small dash-note">
            {metric === "imbalance"
              ? "Green = more pickups than drop-offs, red = more drop-offs. "
              : "Darker = more. Grey = no matching hours. "}
            Click a zone to add it to the comparison.
          </p>
        </div>
        <div className="card">
          <div className="card-title">Imbalance</div>
          {summary.data ? <Imbalances zones={summary.data.zones} /> : summary.loading && <p className="muted">Loading…</p>}
        </div>
      </div>

      {compareIds.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Zone comparison <span className="muted small">up to 3 zones</span></div>
            <button onClick={() => setCompareIds([])}>Clear</button>
          </div>
          <ZoneCompare compare={compare.data} loading={compare.loading} error={compare.error} onRemove={toggleCompare} />
        </div>
      )}

      <div className="card">
        <div className="card-title">Activity over time</div>
        {series.error && <div className="alert error"><span>{series.error}</span></div>}
        {series.data && (
          <div className={series.loading ? "dash-stale" : ""}>
            <ActivityChart series={series.data} bucket={shownBucket} onBucket={setBucket} hourlyAllowed={hourlyAllowed} />
          </div>
        )}
      </div>

      <div className="split">
        <div className="card">
          <div className="card-title">By weekday</div>
          {weekdays.error && <div className="alert error"><span>{weekdays.error}</span></div>}
          {weekdays.data && (
            <div className={weekdays.loading ? "dash-stale" : ""}><WeekdayChart data={weekdays.data} /></div>
          )}
        </div>
        <div className="card">
          <div className="card-title">Data and your plans</div>
          {ctx?.latestImport && (
            <p>
              Latest import: <strong>{ctx.latestImport.month}</strong>, {count(ctx.latestImport.rows_accepted)} trips
              accepted. Data covers {ctx.dateFrom} to {ctx.dateTo}.
            </p>
          )}
          {ctx && ctx.recentPlans.length === 0 && <p className="muted">You have no saved plans yet.</p>}
          {ctx && ctx.recentPlans.length > 0 && (
            <table>
              <thead>
                <tr><th>Recent plan</th><th className="num">Version</th><th className="num">Fleet</th><th>When</th></tr>
              </thead>
              <tbody>
                {ctx.recentPlans.map((p) => (
                  <tr key={p.allocation_plan_id}>
                    <td>{p.name}</td>
                    <td className="num">{p.latest_version ?? "none"}</td>
                    <td className="num">{count(p.fleet_size)}</td>
                    <td>
                      {p.iso_dow ? `${WEEKDAYS[p.iso_dow - 1]} ${hourLabel(p.start_hour ?? 0)}-${hourLabel(p.end_hour ?? 0)}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">All zones</div>
        {summary.data && (
          <ZoneTable zones={summary.data.zones} metric={metric} selected={compareIds} onToggle={toggleCompare} />
        )}
      </div>
    </section>
  );
}
