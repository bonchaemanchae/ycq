import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { type Borough } from "../api";
import SavedViews, { type SavedView } from "../components/SavedViews";
import ZoneMap from "../components/ZoneMap";
import ActivityChart from "./dashboard/ActivityChart";
import DashboardFilters from "./dashboard/Filters";
import Imbalances from "./dashboard/Imbalances";
import Source from "./dashboard/Source";
import TotalsRow from "./dashboard/Totals";
import WeekdayChart from "./dashboard/WeekdayChart";
import ZoneCompare from "./dashboard/ZoneCompare";
import ZoneTable from "./dashboard/ZoneTable";
import {
  METRICS, WEEKDAYS, count, describeFilters, describeSaved, fromSaved, hourLabel, toQuery, toSaved,
  type Compare, type Context, type Filters, type Metric, type Series, type Summary, type Weekdays,
} from "./dashboard/types";
import { useApi } from "./flows/useApi";
import "./dashboard/dashboard.css";

// Activity Dashboard (Kessler). Routes are in api/routers/dashboard.py, the
// MongoDB pipelines ($facet, $setWindowFields, $median, $percentile) in
// api/dashboard.py.
//
// The page is organised around the three questions a fleet manager asks. Each
// tab answers its question in one line first, and only loads the routes it
// needs; filters and the longer charts and tables open when asked for.

const MAX_HOURLY_DAYS = 31;

type Tab = "needed" | "busiest" | "compare";
const TABS: { value: Tab; label: string }[] = [
  { value: "needed", label: "Where are taxis needed?" },
  { value: "busiest", label: "When is it busiest?" },
  { value: "compare", label: "How do these zones compare?" },
];

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000) + 1;

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function Dashboard() {
  const context = useApi<Context>("/dashboard/context");
  const boroughs = useApi<Borough[]>("/boroughs");
  const [filters, setFilters] = useState<Filters | null>(null);
  const [tab, setTab] = useState<Tab>("needed");
  const [refining, setRefining] = useState(false);
  const [showZones, setShowZones] = useState(false);
  const [showSeries, setShowSeries] = useState(false);
  const [bucket, setBucket] = useState<"hour" | "day">("day");
  const [compareIds, setCompareIds] = useState<number[]>([]);

  // Start with the latest loaded month: about a third of the work of every
  // date, so the first screen is quicker. "all dates" in the filters widens it.
  const bounds = context.data?.dateFrom && context.data.dateTo
    ? { dateFrom: context.data.dateFrom, dateTo: context.data.dateTo } : null;
  useEffect(() => {
    if (filters === null && bounds) {
      const monthStart = `${bounds.dateTo.slice(0, 8)}01`;
      const dateFrom = monthStart > bounds.dateFrom ? monthStart : bounds.dateFrom;
      setFilters({ ...bounds, dateFrom, weekdays: [], hourFrom: null, hourTo: null, boroughs: [],
                   metric: "imbalance" });
    }
  }, [bounds, filters]);

  const hourlyAllowed = !!filters && daysBetween(filters.dateFrom, filters.dateTo) <= MAX_HOURLY_DAYS;
  const shownBucket = hourlyAllowed ? bucket : "day";

  // Each path changes with the filters; useApi drops answers to older ones.
  // A route is only asked when the open tab shows its answer.
  const q = filters && toQuery(filters);
  const summary = useApi<Summary>(q && `/dashboard?${q}`);
  const weekdays = useApi<Weekdays>(q && tab === "busiest" ? `/dashboard/weekdays?${q}` : null);
  const series = useApi<Series>(filters && tab === "busiest" && showSeries
    ? `/dashboard/series?${toQuery(filters, { bucket: shownBucket })}` : null);
  const compare = useApi<Compare>(filters && compareIds.length
    ? `/dashboard/compare?${toQuery(filters, { zoneIds: compareIds })}` : null);

  const toggleCompare = useCallback((id: number) => setCompareIds((ids) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= 3 ? ids : [...ids, id]), []);

  // A saved view holds the filters, plus the open question, the compared
  // zones and the chart's hour or day choice as widgets.
  const viewState = useMemo(() => filters && {
    filters: toSaved(filters),
    widgets: { tab, compareZoneIds: compareIds, bucket },
  }, [filters, tab, compareIds, bucket]);
  const openView = useCallback((v: SavedView) => {
    if (!bounds) return;
    setFilters(fromSaved(v.filters, bounds));
    setTab((v.widgets?.tab as Tab) ?? "needed");
    setCompareIds((v.widgets?.compareZoneIds as number[]) ?? []);
    setBucket((v.widgets?.bucket as "hour" | "day") ?? "day");
  }, [bounds]);

  const metric = filters?.metric ?? "imbalance";
  const values = useMemo(
    () => Object.fromEntries((summary.data?.zones ?? []).map((z) => [z.zoneId, z[metric]])),
    [summary.data, metric]);
  const metricLabel = METRICS.find((m) => m.value === metric)!.label.toLowerCase();

  const ctx = context.data;
  const setupError = context.error || boroughs.error;

  // The map, with what it is coloured by next to it. Shared by two tabs.
  const mapCard = filters && (
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          Zones by {metricLabel}
          {summary.loading && summary.data && <span className="tag">updating…</span>}
        </div>
        <div className="dash-pills">
          {METRICS.map((m) => (
            <button key={m.value} title={m.help} className={metric === m.value ? "active" : ""}
                    onClick={() => setFilters({ ...filters, metric: m.value as Metric })}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <ZoneMap values={values} label={metricLabel} onZoneClick={toggleCompare} diverging={metric === "imbalance"} />
      <p className="muted small dash-note">
        {metric === "imbalance"
          ? "Yellow = taxis needed (more pickups than drop-offs), blue = taxis pile up (more drop-offs). "
          : "Darker = more. Grey = no matching hours. "}
        Click a zone to compare it{compareIds.length ? ` (${compareIds.length} of 3 picked)` : ""}.
      </p>
      <Source answer={summary.data} />
    </div>
  );

  return (
    <section className="dashboard">
      <div className="page-head">
        <h1>Activity Dashboard</h1>
        <p className="muted">Pick a question. Each one answers in a line first; open the detail when you need it.</p>
      </div>

      {setupError && <div className="alert error"><span>{setupError}</span></div>}
      {ctx && !bounds && (
        <div className="card"><p className="muted">No data is loaded yet. Run the loader first.</p></div>
      )}

      {filters && (
        <>
          <div className="dash-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.value} role="tab" aria-selected={tab === t.value}
                      className={tab === t.value ? "active" : ""} onClick={() => setTab(t.value)}>
                {t.label}
                {t.value === "compare" && compareIds.length > 0 && <span className="dash-count">{compareIds.length}</span>}
              </button>
            ))}
          </div>

          <div className="card dash-scope">
            <div className="dash-scope-line">
              <span><span className="muted">Looking at</span> {describeFilters(filters)}</span>
              <button className="link" onClick={() => setRefining((r) => !r)} aria-expanded={refining}>
                {refining ? "Done" : "Refine"}
              </button>
            </div>
            {refining && (
              <div className="dash-refine">
                <DashboardFilters filters={filters} onChange={setFilters} bounds={bounds}
                                  boroughs={(boroughs.data ?? []).map((b) => b.name)} />
                <SavedViews page="dashboard" current={viewState} describe={describeSaved} onOpen={openView} />
              </div>
            )}
          </div>
        </>
      )}
      {summary.error && <div className="alert error"><span>{summary.error}</span></div>}

      {filters && tab === "needed" && (
        <>
          <NeededAnswer summary={summary.data} />
          <div className="split">
            <div className="card">
              <div className="card-head">
                <div className="card-title">Imbalance</div>
                <Link to="/planner" className="dash-action">Plan taxis for these zones →</Link>
              </div>
              {summary.data
                ? <Imbalances zones={summary.data.zones} />
                : summary.loading && <p className="muted">Loading…</p>}
            </div>
            {mapCard}
          </div>
          {summary.data && (
            <div className={summary.loading ? "dash-stale" : ""}><TotalsRow totals={summary.data.totals} /></div>
          )}
          <Disclosure open={showZones} onToggle={() => setShowZones((s) => !s)} label="every zone">
            {summary.data && (
              <ZoneTable zones={summary.data.zones} metric={metric} selected={compareIds} onToggle={toggleCompare} />
            )}
          </Disclosure>
        </>
      )}

      {filters && tab === "busiest" && (
        <>
          <BusiestAnswer weekdays={weekdays.data} loading={weekdays.loading} />
          <div className="card">
            <div className="card-title">By weekday and hour</div>
            {weekdays.error && <div className="alert error"><span>{weekdays.error}</span></div>}
            {weekdays.data && (
              <div className={weekdays.loading ? "dash-stale" : ""}><WeekdayChart data={weekdays.data} /></div>
            )}
            <Source answer={weekdays.data} />
          </div>
          <Disclosure open={showSeries} onToggle={() => setShowSeries((s) => !s)} label="activity day by day">
            {series.error && <div className="alert error"><span>{series.error}</span></div>}
            {series.loading && !series.data && <p className="muted">Loading…</p>}
            {series.data && (
              <div className={series.loading ? "dash-stale" : ""}>
                <ActivityChart series={series.data} bucket={shownBucket} onBucket={setBucket} hourlyAllowed={hourlyAllowed} />
              </div>
            )}
            <Source answer={series.data} />
          </Disclosure>
        </>
      )}

      {filters && tab === "compare" && (
        <>
          <div className="card">
            <div className="card-head">
              <div className="card-title">Zone comparison <span className="muted small">up to 3 zones</span></div>
              {compareIds.length > 0 && <button onClick={() => setCompareIds([])}>Clear</button>}
            </div>
            {compareIds.length === 0
              ? <p className="muted">Pick up to 3 zones on the map or in the list below to compare them side by side.</p>
              : <ZoneCompare compare={compare.data} loading={compare.loading} error={compare.error} onRemove={toggleCompare} />}
          </div>
          <div className="split">
            {mapCard}
            <div className="card">
              <div className="card-title">Zones</div>
              {summary.data && (
                <ZoneTable zones={summary.data.zones} metric={metric} selected={compareIds} onToggle={toggleCompare} />
              )}
            </div>
          </div>
        </>
      )}

      {ctx && bounds && (
        <p className="muted small dash-footer">
          Data covers {ctx.dateFrom} to {ctx.dateTo}
          {ctx.latestImport && <>; latest import {ctx.latestImport.month}, {count(ctx.latestImport.rows_accepted)} trips</>}.
          {" "}Read from MongoDB's hourly zone activity, checked against PostgreSQL after every load.
          {" "}
          {ctx.recentPlans.length > 0
            ? <>Latest plan: <Link to="/planner">{ctx.recentPlans[0].name}</Link>
                {ctx.recentPlans[0].iso_dow
                  ? ` (${WEEKDAYS[ctx.recentPlans[0].iso_dow - 1]} ${hourLabel(ctx.recentPlans[0].start_hour ?? 0)}-${hourLabel(ctx.recentPlans[0].end_hour ?? 0)})`
                  : ""}.</>
            : <>No saved plans yet: <Link to="/planner">open the planner</Link>.</>}
        </p>
      )}
    </section>
  );
}

// "Where are taxis needed?" in one line: the zone losing the most taxis a day,
// and the one where they pile up.
function NeededAnswer({ summary }: { summary: Summary | null }) {
  if (!summary) return null;
  const days = Math.max(1, summary.totals.days);
  const zones = summary.zones;
  const out = zones.reduce<Summary["zones"][number] | null>((m, z) => (z.imbalance > (m?.imbalance ?? 0) ? z : m), null);
  const into = zones.reduce<Summary["zones"][number] | null>((m, z) => (z.imbalance < (m?.imbalance ?? 0) ? z : m), null);
  const perDay = (v: number) => count(Math.round(Math.abs(v) / days));
  if (!out && !into) return <div className="card dash-answer"><p>No zone is short of taxis for these filters.</p></div>;
  return (
    <div className="card dash-answer">
      {out && (
        <p className="dash-answer-main">
          <strong>{out.zoneName}</strong> <span className="muted">({out.borough})</span> needs the most taxis:
          about <strong>{perDay(out.imbalance)} more pickups than drop-offs a day</strong>.
        </p>
      )}
      {into && (
        <p className="muted">
          Taxis pile up empty in {into.zoneName} ({into.borough}), about {perDay(into.imbalance)} more drop-offs than
          pickups a day.
        </p>
      )}
    </div>
  );
}

// "When is it busiest?" in one line: the busiest hour of the week and the
// busiest weekday.
function BusiestAnswer({ weekdays, loading }: { weekdays: Weekdays | null; loading: boolean }) {
  if (!weekdays) return loading ? <div className="card dash-answer"><p className="muted">Loading…</p></div> : null;
  if (weekdays.grid.length === 0) return <div className="card dash-answer"><p>No hours match the filters.</p></div>;
  const peak = weekdays.grid.reduce((m, g) => (g.averagePickups > m.averagePickups ? g : m));
  const day = weekdays.weekdays.reduce((m, w) => (w.averagePickups > m.averagePickups ? w : m));
  return (
    <div className="card dash-answer">
      <p className="dash-answer-main">
        The busiest hour is <strong>{DAY_NAMES[peak.isoDayOfWeek - 1]} {hourLabel(peak.hour)}</strong>, with
        about <strong>{count(Math.round(peak.averagePickups))} pickups in that hour</strong> on an average {DAY_NAMES[peak.isoDayOfWeek - 1]}.
      </p>
      <p className="muted">
        {DAY_NAMES[day.isoDayOfWeek - 1]} is the busiest day overall, about {count(Math.round(day.averagePickups))} pickups.
      </p>
    </div>
  );
}

// A section that stays folded until asked for.
function Disclosure({ open, onToggle, label, children }: {
  open: boolean; onToggle: () => void; label: string; children: React.ReactNode;
}) {
  return (
    <div className="card dash-disclosure">
      <button className="link" onClick={onToggle} aria-expanded={open}>
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && <div className="dash-disclosure-body">{children}</div>}
    </div>
  );
}
