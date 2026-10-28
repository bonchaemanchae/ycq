import { useCallback, useEffect, useMemo, useState } from "react";
import SavedViews, { type SavedView } from "../components/SavedViews";
import ZoneMap, { type MapLine } from "../components/ZoneMap";
import DestinationTable from "./flows/DestinationTable";
import FlowControls from "./flows/FlowControls";
import MonthCompare from "./flows/MonthCompare";
import {
  DAY_TYPES, bucketLabel, count, monthLabel, percent, toParams,
  type Centroid, type Compare, type Query, type Slice, type Zone,
} from "./flows/types";
import { useApi } from "./flows/useApi";
import "./flows/flows.css";

// Flow Explorer (Caleb). Routes are in api/routers/flows.py, the MongoDB
// pipelines ($unwind on the embedded top-10 lists) in api/flows.py.
//
// Flow: pick an origin zone (list or map), month, day type and time of day ->
// the top 10 destinations as a table and as lines from the origin -> optionally
// the same slice across every loaded month.

// The first view: Midtown Center on weekday mornings, in the latest month.
const START = { originZoneId: 161, dayType: "weekday", timeBucket: "am_peak" } as const;

export default function Flows() {
  const zones = useApi<Zone[]>("/zones");
  const centroids = useApi<Centroid[]>("/zones/centroids");
  const months = useApi<string[]>("/flows/months");
  const [query, setQuery] = useState<Query | null>(null);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    const list = months.data;
    if (query === null && list?.length) setQuery({ ...START, month: list[list.length - 1] });
  }, [months.data, query]);

  // Each changes path when the controls change; useApi drops older answers.
  const slice = useApi<Slice>(query && `/flows?${toParams(query)}`);
  const compare = useApi<Compare>(query && comparing
    ? `/flows/compare-months?${toParams({
        originZoneId: query.originZoneId, dayType: query.dayType, timeBucket: query.timeBucket })}`
    : null);

  const onZoneClick = useCallback((id: number) => setQuery((q) => (q ? { ...q, originZoneId: id } : q)), []);

  const zoneName = useMemo(() => new Map((zones.data ?? []).map((z) => [z.location_id, z.zone_name])), [zones.data]);
  const centre = useMemo(
    () => new Map((centroids.data ?? []).map((c) => [c.location_id, [c.lat, c.lon] as [number, number]])),
    [centroids.data]);

  // What's on screen is always the last answer, labelled with its own query,
  // even while the next one loads.
  const s = slice.data;
  const shown = s?.found ? s : null;

  // A line from the origin to each destination, thicker for a larger share.
  // Trips within the origin zone have no line.
  const lines = useMemo<MapLine[]>(() => {
    const from = shown && centre.get(shown.originZoneId);
    if (!shown || !from) return [];
    const max = Math.max(...shown.destinations.map((d) => d.share));
    return shown.destinations
      .filter((d) => d.zoneId !== shown.originZoneId && centre.has(d.zoneId))
      .map((d) => ({
        from,
        to: centre.get(d.zoneId)!,
        weight: 2 + 10 * (d.share / max),
        tooltip: `#${d.rank} ${d.zoneName}: ${count(d.trips)} trips (${percent(d.share)})`,
      }));
  }, [shown, centre]);
  const values = Object.fromEntries((shown?.destinations ?? []).map((d) => [d.zoneId, d.trips]));

  // A saved view holds the four choices, plus whether the month comparison is open.
  const viewState = useMemo(() => query && { filters: query, widgets: { compareMonths: comparing } },
                            [query, comparing]);
  const openView = useCallback((v: SavedView) => {
    setQuery(v.filters as Query);
    setComparing(v.widgets?.compareMonths === true);
  }, []);
  const describeView = useCallback((f: Record<string, unknown>) => {
    const q = f as Query;
    return [zoneName.get(q.originZoneId) ?? `Zone ${q.originZoneId}`, monthLabel(q.month),
            DAY_TYPES.find((d) => d.value === q.dayType)?.label, bucketLabel(q.timeBucket)].join(" · ");
  }, [zoneName]);

  const setupError = zones.error || centroids.error || months.error;
  const origin = s ? zoneName.get(s.originZoneId) ?? `Zone ${s.originZoneId}` : "";
  const sliceLabel = s
    ? `${monthLabel(s.month)} · ${DAY_TYPES.find((d) => d.value === s.dayType)!.label} · ${bucketLabel(s.timeBucket)}`
    : "";

  return (
    <section className="flows">
      <div className="page-head">
        <h1>Flow Explorer</h1>
        <p className="muted">
          Where taxi trips from a zone go: the top 10 destinations for a month, weekday or weekend, and time of
          day. Pick an origin from the list or click it on the map. Read from MongoDB snapshots of PostgreSQL's
          origin-destination summary.
        </p>
      </div>

      {setupError && <div className="alert error"><span>{setupError}</span></div>}
      {months.data?.length === 0 && (
        <div className="card"><p className="muted">No flow data is loaded yet. Run the loader first.</p></div>
      )}

      {query && months.data && (
        <FlowControls query={query} onChange={setQuery} zones={zones.data ?? []} months={months.data} />
      )}
      {query && <SavedViews page="flows" current={viewState} describe={describeView} onOpen={openView} />}
      {slice.error && <div className="alert error"><span>{slice.error}</span></div>}

      <div className="split">
        <div className="card">
          <div className="card-head">
            <div className="card-title">
              {s ? <>From {origin} <span className="muted">· {sliceLabel}</span></> : "Top destinations"}
              {slice.loading && s && <span className="tag">updating…</span>}
            </div>
            <button onClick={() => setComparing(true)} disabled={!query || comparing}>Compare months</button>
          </div>

          {!s ? (
            slice.loading && <p className="muted">Loading…</p>
          ) : !s.found ? (
            <div className={`flows-empty ${slice.loading ? "flows-stale" : ""}`}>
              <p><strong>No trips from {origin}</strong> for {sliceLabel}.</p>
              <p className="muted small">Quiet zones often have no trips at some times of day. Try another time or month.</p>
            </div>
          ) : (
            <div className={slice.loading ? "flows-stale" : ""}>
              <p className="flows-summary">
                <strong>{count(s.totalTrips)}</strong> trips ·{" "}
                {s.destinationCount <= s.destinations.length
                  ? <>all {s.destinationCount} destinations</>
                  : <>top {s.destinations.length} of {count(s.destinationCount)} destinations</>}{" "}
                = <strong>{percent(s.topShare)}</strong> of trips
              </p>
              <DestinationTable slice={s} />
            </div>
          )}
        </div>

        <div className="card">
          <ZoneMap values={values} label="trips" onZoneClick={onZoneClick} lines={lines} />
          <div className="flows-legend">
            <span><span className="flows-swatch-line" /> line from the origin, thicker = larger share</span>
            <span><span className="flows-swatch-zone" /> destination, darker = more trips</span>
            <span>Click any zone to make it the origin.</span>
          </div>
        </div>
      </div>

      {comparing && query && (
        <MonthCompare compare={compare.data} loading={compare.loading} error={compare.error}
                      originZoneId={query.originZoneId} onClose={() => setComparing(false)} />
      )}
    </section>
  );
}
