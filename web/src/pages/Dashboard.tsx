import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type Borough } from "../api";
import SavedViews, { type SavedView } from "../components/SavedViews";
import ZoneMap from "../components/ZoneMap";
import ActivityChart from "./dashboard/ActivityChart";
import DashboardFilters from "./dashboard/Filters";
import PlanChooser from "./dashboard/PlanChooser";
import Source from "./dashboard/Source";
import TotalsRow from "./dashboard/Totals";
import ZoneCompare from "./dashboard/ZoneCompare";
import ZoneList, { demandValue, shortageValue } from "./dashboard/ZoneList";
import ZonePicker from "./dashboard/ZonePicker";
import {
  describeSaved, fromSaved, toQuery, toSaved,
  type Compare, type Context, type Filters, type Metric, type Series, type Summary,
} from "./dashboard/types";
import FlowsPanel, { centreMap, flowLines } from "./flows/FlowsPanel";
import MonthCompare from "./flows/MonthCompare";
import {
  DAY_TYPES, bucketForHours, bucketLabel, monthLabel, toParams,
  type Centroid, type Compare as MonthComparison, type Query, type Slice, type Zone,
} from "./flows/types";
import { useApi } from "./flows/useApi";
import { DAYS, planLink, shiftLabel, type Shift } from "./planner/types";
import "./dashboard/dashboard.css";

// Analytical Dashboard. Routes are in api/routers/dashboard.py, the MongoDB
// pipelines ($facet, $setWindowFields, $median, $percentile) in
// api/dashboard.py; the Flow Explorer reads api/routers/flows.py.
//
// Two sections under the same filters:
//   Overview  where people want taxis and where taxis run short: one map,
//             switched between Demand (pickups) and Shortages (pickups minus
//             drop-offs), with the zones ranked beside it. A zone opens the
//             Flow Explorer (where its trips go) in that panel, and + adds it
//             to the comparison under the map.
//   Timing    how steady demand is: pickups per day with a moving average,
//             and the unusual days, each compared with a typical day of the
//             same weekday (worked out in the MongoDB pipeline). The week's
//             busiest hours are chosen in the Allocation Planner instead.
// The filter bar's Plan button opens the planner on the filtered shift (or
// asks which shift, when the filters don't name one), taking the boroughs and
// the zones the analyst looked at with it. The page keeps its state in this
// tab, so coming back from the planner returns to the same view.

type Tab = "overview" | "timing";
type MapMode = "demand" | "shortages";

const TABS: Record<Tab, { title: string; question: string }> = {
  overview: { title: "Overview", question: "Where people want taxis, and where taxis run short." },
  timing: { title: "Timing", question: "How steady demand is from day to day, and which days broke the pattern." },
};
const TAB_KEYS = Object.keys(TABS) as Tab[];
const METRIC_OF: Record<MapMode, Metric> = { demand: "pickups", shortages: "imbalance" };
const MAX_COMPARED = 3;

// What the page was showing, kept for this browser tab so that going to the
// planner and back (or anywhere else) returns to the same view.
const STATE_KEY = "ycq.dashboard";
type Kept = {
  filters: Filters; mapMode: "demand" | "shortages"; compareIds: number[]; flow: Query | null;
  comparingMonths: boolean; bucket: "hour" | "day";
};
const kept: Partial<Kept> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "{}");
  } catch {
    return {};
  }
})();

const MAX_HOURLY_DAYS = 31;
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000) + 1;

// The flow snapshot closest to the filters: flows are stored per month,
// weekday or weekend, and time band, while the filters take any dates and hours.
function sliceFor(f: Filters, months: string[]): Omit<Query, "originZoneId"> {
  const wanted = f.dateTo.slice(0, 7);
  const month = months.includes(wanted) ? wanted : months[months.length - 1];
  const dayType = f.weekdays.length > 0 && f.weekdays.every((d) => d >= 6) ? "weekend" : "weekday";
  const from = f.hourFrom ?? 0, to = f.hourTo ?? 23;
  const hours = f.hourFrom === null && f.hourTo === null ? [8]
    : from <= to ? Array.from({ length: to - from + 1 }, (_, i) => from + i)
    : [...Array.from({ length: 24 - from }, (_, i) => from + i), ...Array.from({ length: to + 1 }, (_, i) => i)];
  return { month, dayType, timeBucket: bucketForHours(hours) };
}

export default function Dashboard() {
  const { tab: param } = useParams();
  const navigate = useNavigate();
  const tab: Tab = TAB_KEYS.includes(param as Tab) ? (param as Tab) : "overview";
  const [mapMode, setMapMode] = useState<MapMode>(param === "shortages" ? "shortages" : kept.mapMode ?? "demand");
  useEffect(() => {
    // Shortages and Compare zones were their own sections; both are now part of the Overview.
    if (param === "shortages") setMapMode("shortages");
    if (param !== tab) navigate(`/dashboard/${tab}`, { replace: true });
  }, [param, tab, navigate]);

  const context = useApi<Context>("/dashboard/context");
  const boroughs = useApi<Borough[]>("/boroughs");
  const zones = useApi<Zone[]>("/zones");
  const centroids = useApi<Centroid[]>("/zones/centroids");
  const months = useApi<string[]>("/flows/months");

  const [filters, setFilters] = useState<Filters | null>(kept.filters ?? null);
  const [bucket, setBucket] = useState<"hour" | "day">(kept.bucket ?? "day");
  const [compareIds, setCompareIds] = useState<number[]>(kept.compareIds ?? []);
  const [flow, setFlow] = useState<Query | null>(kept.flow ?? null);
  const [comparingMonths, setComparingMonths] = useState(kept.comparingMonths ?? false);
  const [choosing, setChoosing] = useState(false);

  // Start with every loaded month, the same data the planner learns from.
  const bounds = context.data?.dateFrom && context.data.dateTo
    ? { dateFrom: context.data.dateFrom, dateTo: context.data.dateTo } : null;
  useEffect(() => {
    if (filters === null && bounds) {
      setFilters({ ...bounds, weekdays: [], hourFrom: null, hourTo: null, boroughs: [], metric: "pickups" });
    }
  }, [bounds, filters]);
  useEffect(() => {
    if (!filters) return;
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(
        { filters, mapMode, compareIds, flow, comparingMonths, bucket } satisfies Kept));
    } catch {
      // storage blocked: the page still works, it just starts afresh next time
    }
  }, [filters, mapMode, compareIds, flow, comparingMonths, bucket]);

  const hourlyAllowed = !!filters && daysBetween(filters.dateFrom, filters.dateTo) <= MAX_HOURLY_DAYS;
  const shownBucket = hourlyAllowed ? bucket : "day";

  // Each section asks only for what it shows; useApi drops answers to older paths.
  const q = filters && toQuery(filters);
  const overview = tab === "overview";
  const summary = useApi<Summary>(q && overview ? `/dashboard?${q}` : null);
  const series = useApi<Series>(filters && !overview
    ? `/dashboard/series?${toQuery(filters, { bucket: shownBucket })}` : null);
  const compare = useApi<Compare>(filters && overview && compareIds.length
    ? `/dashboard/compare?${toQuery(filters, { zoneIds: compareIds })}` : null);
  const slice = useApi<Slice>(flow && `/flows?${toParams(flow)}`);
  const monthCompare = useApi<MonthComparison>(flow && comparingMonths
    ? `/flows/compare-months?${toParams({
        originZoneId: flow.originZoneId, dayType: flow.dayType, timeBucket: flow.timeBucket })}`
    : null);

  const zoneName = useMemo(() => new Map((zones.data ?? []).map((z) => [z.location_id, z.zone_name])), [zones.data]);
  const centre = useMemo(() => centreMap(centroids.data), [centroids.data]);
  const lines = useMemo(() => flowLines(slice.data, centre), [slice.data, centre]);

  // Clicking a zone opens its flows, matched to the filters the first time;
  // after that, the panel keeps the month and time the analyst chose.
  const openFlow = useCallback((id: number) => {
    if (!filters || !months.data?.length) return;
    setFlow((f) => (f ? { ...f, originZoneId: id } : { originZoneId: id, ...sliceFor(filters, months.data!) }));
  }, [filters, months.data]);
  const closeFlow = () => {
    setFlow(null);
    setComparingMonths(false);
  };
  const toggleCompare = useCallback((id: number) => setCompareIds((ids) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= MAX_COMPARED ? ids : [...ids, id]), []);

  // A saved view holds the filters, plus the section, the map mode, the
  // compared zones, the chart's hour or day choice and the open flows.
  const viewState = useMemo(() => filters && {
    filters: toSaved({ ...filters, metric: METRIC_OF[mapMode] }),
    widgets: {
      section: tab, mapMode, compareZoneIds: compareIds, bucket,
      ...(flow ? { flow, compareMonths: comparingMonths } : {}),
    },
  }, [filters, tab, mapMode, compareIds, bucket, flow, comparingMonths]);
  // Views saved on the old Flow Explorer page hold only the flow's four choices.
  const flowViewState = useCallback((v: SavedView) =>
    v.page === "flows" && flow ? { filters: flow, widgets: { compareMonths: comparingMonths } } : null,
  [flow, comparingMonths]);

  const openView = useCallback((v: SavedView) => {
    if (v.page === "flows") {
      setFlow(v.filters as Query);
      setComparingMonths(v.widgets?.compareMonths === true);
      navigate("/dashboard/overview");
      return;
    }
    if (!bounds) return;
    const f = fromSaved(v.filters, bounds);
    const w = v.widgets ?? {};
    setFilters({ ...f, metric: "pickups" });
    setCompareIds((w.compareZoneIds as number[]) ?? []);
    setBucket((w.bucket as "hour" | "day") ?? "day");
    setFlow((w.flow as Query) ?? null);
    setComparingMonths(w.compareMonths === true);
    // views saved before the sections were merged may name Shortages or Compare zones
    setMapMode(w.mapMode === "shortages" || w.section === "shortages" || f.metric === "imbalance"
      ? "shortages" : "demand");
    navigate(`/dashboard/${w.section === "timing" ? "timing" : "overview"}`);
  }, [bounds, navigate]);

  const describeView = useCallback((f: Record<string, unknown>, page: SavedView["page"]) => {
    if (page !== "flows") return describeSaved(f);
    const fq = f as Query;
    return ["Flows from " + (zoneName.get(fq.originZoneId) ?? `zone ${fq.originZoneId}`), monthLabel(fq.month),
            DAY_TYPES.find((d) => d.value === fq.dayType)?.label, bucketLabel(fq.timeBucket)].join(" · ");
  }, [zoneName]);

  // Opening the planner: on the filtered shift when the filters name one
  // weekday and an hour range, otherwise on the filtered boroughs (the planner
  // then offers its busiest shifts). All boroughs when none is filtered.
  const filterShift: Shift | null = filters && filters.weekdays.length === 1 && filters.hourFrom !== null
    && filters.hourTo !== null && filters.hourFrom <= filters.hourTo
    ? { dow: filters.weekdays[0], from: filters.hourFrom, to: filters.hourTo } : null;
  const planBoroughs = filters?.boroughs.length ? filters.boroughs : (boroughs.data ?? []).map((b) => b.name);
  // the zones the analyst looked at: opened in the Flow Explorer or compared
  const watched = [...new Set([...(flow ? [flow.originZoneId] : []), ...compareIds])];
  const planShift = (shift: Shift) => navigate(planLink(shift, planBoroughs, watched, tab));
  const carried = [
    filters?.boroughs.length ? filters.boroughs.join(", ") : "all boroughs",
    ...(watched.length ? [`watching ${watched.map((id) => zoneName.get(id) ?? `zone ${id}`).join(", ")}`] : []),
  ];

  const setupError = context.error || boroughs.error || zones.error;
  const short = mapMode === "shortages";
  const metric = METRIC_OF[mapMode];
  const values = useMemo(
    () => Object.fromEntries((summary.data?.zones ?? []).map((z) => [z.zoneId, z[metric]])),
    [summary.data, metric]);

  // The zones ranked for the map mode.
  const all = summary.data?.zones ?? [];
  const byPickups = useMemo(() => [...all].sort((a, b) => b.pickups - a.pickups || a.zoneId - b.zoneId), [all]);
  const shortOf = useMemo(() => all.filter((z) => z.imbalance > 0)
    .sort((a, b) => b.imbalance - a.imbalance || a.zoneId - b.zoneId), [all]);
  const pilingUp = useMemo(() => all.filter((z) => z.imbalance < 0)
    .sort((a, b) => a.imbalance - b.imbalance || a.zoneId - b.zoneId), [all]);
  const listProps = { onOpen: openFlow, compared: compareIds, onCompare: toggleCompare, maxCompared: MAX_COMPARED,
                      selected: flow?.originZoneId };

  return (
    <section className="dashboard">
      <div className="page-head">
        <h1>{TABS[tab].title}</h1>
        <p className="muted">{TABS[tab].question}</p>
      </div>

      {setupError && <div className="alert error"><span>{setupError}</span></div>}
      {context.data && !bounds && (
        <div className="card"><p className="muted">No data is loaded yet. Run the loader first.</p></div>
      )}

      {filters && (
        <DashboardFilters filters={filters} onChange={setFilters} bounds={bounds}
                          boroughs={(boroughs.data ?? []).map((b) => b.name)}
                          action={
                            <button className="primary"
                                    onClick={() => (filterShift ? planShift(filterShift) : setChoosing(!choosing))}
                                    title={`Open the Allocation Planner: ${carried.join(" · ")}`}>
                              {filterShift ? `Plan ${shiftLabel(filterShift)} →` : "Plan a shift →"}
                            </button>
                          } />
      )}
      {filters && choosing && !filterShift && (
        <PlanChooser filters={filters} carried={carried} onPlan={planShift} onClose={() => setChoosing(false)} />
      )}
      {filters && (
        <SavedViews page="dashboard" pages={["dashboard", "flows"]} current={viewState} currentFor={flowViewState}
                    describe={describeView} onOpen={openView} />
      )}
      {summary.error && <div className="alert error"><span>{summary.error}</span></div>}

      {overview && (
        <>
          {summary.data && (
            <div className={summary.loading ? "dash-stale" : ""}><TotalsRow totals={summary.data.totals} /></div>
          )}

          <div className="map-layout">
            <div className="card map-card">
              <div className="card-head">
                <div className="segmented" role="group" aria-label="Colour the map by">
                  <button className={short ? "" : "on"} onClick={() => setMapMode("demand")}
                          title="Pickups: where people want taxis">Demand</button>
                  <button className={short ? "on" : ""} onClick={() => setMapMode("shortages")}
                          title="Pickups minus drop-offs: where taxis leave faster than they arrive">Shortages</button>
                </div>
                {summary.loading && summary.data && <span className="tag">updating…</span>}
                <MapLegend short={short} flowOpen={!!flow} compared={compareIds.length > 0} />
              </div>
              <ZoneMap values={values} label={short ? "pickups minus drop-offs" : "pickups"}
                       onZoneClick={openFlow} diverging={short} selectedId={flow?.originZoneId}
                       markedIds={compareIds} lines={lines} />
              <Source answer={summary.data} />
            </div>

            <div className="card map-side">
              {flow && months.data ? (
                <FlowsPanel query={flow} onChange={setFlow} months={months.data} slice={slice}
                            originName={zoneName.get(flow.originZoneId) ?? `zone ${flow.originZoneId}`}
                            onClose={closeFlow} comparing={comparingMonths} onCompareMonths={setComparingMonths}
                            note={<>Starts at the month, day type and time band closest to your filters.</>}
                            actions={
                              <button onClick={() => toggleCompare(flow.originZoneId)}
                                      disabled={!compareIds.includes(flow.originZoneId)
                                        && compareIds.length >= MAX_COMPARED}>
                                {compareIds.includes(flow.originZoneId) ? "✓ In the comparison" : "+ Compare"}
                              </button>
                            } />
              ) : short ? (
                <>
                  <ZoneList key="short" title="Short of taxis" first={6} zones={shortOf} value={shortageValue}
                            sub="More pickups than drop-offs: taxis leave and don't come back." {...listProps} />
                  <ZoneList key="surplus" title="Taxis piling up" first={4} zones={pilingUp} value={shortageValue}
                            sub="More drop-offs than pickups: taxis end up here empty." {...listProps} />
                </>
              ) : (
                <ZoneList key="demand" title="Busiest zones" zones={byPickups} value={demandValue}
                          sub="Ranked by pickups. Click a zone to see where its trips go." {...listProps} />
              )}
            </div>
          </div>

          {comparingMonths && flow && (
            <MonthCompare compare={monthCompare.data} loading={monthCompare.loading} error={monthCompare.error}
                          originZoneId={flow.originZoneId} onClose={() => setComparingMonths(false)} />
          )}

          {compareIds.length > 0 && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">
                  Zone comparison <div className="card-sub">Steady demand has a median close to its average.</div>
                </div>
                <button onClick={() => setCompareIds([])}>Clear</button>
              </div>
              <ZonePicker zones={zones.data ?? []} selected={compareIds} max={MAX_COMPARED}
                          onAdd={toggleCompare} onRemove={toggleCompare} />
              <ZoneCompare compare={compare.data} loading={compare.loading} error={compare.error}
                           onRemove={toggleCompare} />
              <Source answer={compare.data} />
            </div>
          )}
        </>
      )}

      {tab === "timing" && (
        <>
          <div className="card">
            <div className="card-title">
              Pickups over time <div className="card-sub">Red dots mark unusual days.</div>
            </div>
            {series.error && <div className="alert error"><span>{series.error}</span></div>}
            {series.data
              ? <div className={series.loading ? "dash-stale" : ""}>
                  <ActivityChart series={series.data} bucket={shownBucket} onBucket={setBucket} hourlyAllowed={hourlyAllowed} />
                </div>
              : series.loading && <p className="muted">Loading…</p>}
            <Source answer={series.data} />
          </div>
          {series.data?.bucket === "day" && <UnusualDays series={series.data} />}
        </>
      )}
    </section>
  );
}

function MapLegend({ short, flowOpen, compared }: { short: boolean; flowOpen: boolean; compared: boolean }) {
  return (
    <div className="map-legend">
      {short ? (
        <>
          <span><span className="swatch short" /> short of taxis</span>
          <span><span className="swatch surplus" /> taxis piling up</span>
        </>
      ) : (
        <span><span className="ramp" /> more pickups</span>
      )}
      {compared && <span><span className="marked-swatch" /> compared</span>}
      {flowOpen && <span><span className="line-swatch" /> where trips go</span>}
    </div>
  );
}

// The days far from a typical day of the same weekday, largest change first.
function UnusualDays({ series }: { series: Series }) {
  const byDate = new Map(series.points.map((p) => [p.localDate, p]));
  const days = series.unusualDays.map((d) => byDate.get(d)!).filter(Boolean);
  const pct = Math.round(series.unusualThreshold * 100);
  return (
    <div className="card">
      <div className="card-title">
        Unusual days
        <div className="card-sub">
          Days with at least {pct}% more or fewer pickups than a typical {""}
          day of the same weekday over these dates. The planner's averages include them.
        </div>
      </div>
      {days.length === 0 ? (
        <p className="muted">No unusual days for these filters.</p>
      ) : (
        <table className="unusual">
          <thead>
            <tr><th>Day</th><th className="num">Pickups</th><th className="num">Typical {""}for that weekday</th><th className="num">Change</th></tr>
          </thead>
          <tbody>
            {days.map((p) => (
              <tr key={p.localDate}>
                <td>
                  {DAYS[(p.isoDayOfWeek ?? 1) - 1]}{" "}
                  {new Date(`${p.localDate}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long" })}
                </td>
                <td className="num">{p.pickups.toLocaleString()}</td>
                <td className="num">{Math.round(p.typicalPickups ?? 0).toLocaleString()}</td>
                <td className={`num ${(p.change ?? 0) < 0 ? "short" : "surplus"}`}>
                  <strong>{(p.change ?? 0) > 0 ? "+" : ""}{Math.round((p.change ?? 0) * 100)}%</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
