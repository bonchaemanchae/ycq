import type { ReactNode } from "react";
import type { MapLine } from "../../components/ZoneMap";
import {
  DAY_TYPES, TIME_BUCKETS, count, money, monthLabel, percent,
  type Centroid, type Query, type Slice,
} from "./types";
import type { Loaded } from "./useApi";
import "./flows.css";

// The Flow Explorer, as a panel beside a map: where trips from one origin zone
// go, for a month, weekday or weekend, and time band. It reads one MongoDB
// snapshot with the top 10 destinations embedded (api/flows.py), so the
// answer comes from one indexed read. Opened by clicking a zone on the
// Analytical Dashboard or the Allocation Planner.

type Props = {
  query: Query;
  onChange: (q: Query) => void;
  months: string[];
  originName: string;
  slice: Loaded<Slice>;
  onClose: () => void;
  note?: ReactNode;               // e.g. how the slice was matched to the page's filters
  actions?: ReactNode;            // extra buttons, e.g. "Add to comparison"
  comparing?: boolean;            // month comparison open (shown by the page)
  onCompareMonths?: (on: boolean) => void;
  compact?: boolean;              // fewer controls, for the planner's narrow column
};

// A line from the origin to each destination, thicker for a larger share.
// Trips within the origin zone have no line.
export function flowLines(slice: Slice | null, centre: Map<number, [number, number]>): MapLine[] {
  const from = slice?.found ? centre.get(slice.originZoneId) : undefined;
  if (!slice?.found || !from) return [];
  const max = Math.max(...slice.destinations.map((d) => d.share));
  return slice.destinations
    .filter((d) => d.zoneId !== slice.originZoneId && centre.has(d.zoneId))
    .map((d) => ({
      from,
      to: centre.get(d.zoneId)!,
      weight: 2 + 9 * (d.share / max),
      color: "#1c1c1a",
      tooltip: `#${d.rank} ${d.zoneName}: ${count(d.trips)} trips (${percent(d.share)})`,
    }));
}

export const centreMap = (list: Centroid[] | null) =>
  new Map((list ?? []).map((c) => [c.location_id, [c.lat, c.lon] as [number, number]]));

export default function FlowsPanel({ query: q, onChange, months, originName, slice, onClose, note, actions,
                                     comparing, onCompareMonths, compact = false }: Props) {
  const set = <K extends keyof Query>(k: K, v: Query[K]) => onChange({ ...q, [k]: v });
  const s = slice.data;
  const max = s?.found ? Math.max(...s.destinations.map((d) => d.share)) : 1;

  return (
    <div className="flow-panel">
      <div className="flow-head">
        <div>
          <span className="eyebrow">Flow Explorer</span>
          <div className="flow-title">Where trips from {originName} go</div>
        </div>
        <button className="link" onClick={onClose} aria-label="Close the Flow Explorer">✕</button>
      </div>

      <div className="flow-controls">
        {!compact && (
          <select value={q.month} onChange={(e) => set("month", e.target.value)} aria-label="Month">
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        )}
        <div className="segmented" role="group" aria-label="Day type">
          {DAY_TYPES.map((d) => (
            <button key={d.value} className={q.dayType === d.value ? "on" : ""} onClick={() => set("dayType", d.value)}>
              {d.value === "weekday" ? "Weekdays" : "Weekends"}
            </button>
          ))}
        </div>
        <select value={q.timeBucket} onChange={(e) => set("timeBucket", e.target.value as Query["timeBucket"])}
                aria-label="Time of day">
          {TIME_BUCKETS.map((b) => <option key={b.value} value={b.value}>{b.label} ({b.hours})</option>)}
        </select>
      </div>
      {note && <p className="muted small flow-note">{note}</p>}

      {slice.error && <div className="alert error"><span>{slice.error}</span></div>}
      {!s ? (
        slice.loading && <p className="muted">Loading…</p>
      ) : !s.found ? (
        <div className={`flows-empty ${slice.loading ? "flows-stale" : ""}`}>
          <p><strong>No trips from {originName}</strong> at this time.</p>
          <p className="muted small">Quiet zones often have no trips at some times of day. Try another time band.</p>
        </div>
      ) : (
        <div className={slice.loading ? "flows-stale" : ""}>
          <p className="flow-summary">
            <strong>{count(s.totalTrips)}</strong> trips in {monthLabel(s.month)}. The top{" "}
            {s.destinations.length} destinations take <strong>{percent(s.topShare)}</strong> of them.
          </p>
          <ol className="flow-list">
            {s.destinations.map((d) => (
              <li key={d.zoneId}>
                <span className="flow-rank">{d.rank}</span>
                <div className="flow-dest">
                  <div className="flow-dest-name">
                    {d.zoneName}
                    {d.zoneId === s.originZoneId && <span className="tag" title="Trips that start and end here">stays in zone</span>}
                  </div>
                  <div className="flow-bar"><span style={{ width: `${(d.share / max) * 100}%` }} /></div>
                  <div className="muted small">
                    {d.borough} · avg fare {money(d.averageFare)}
                  </div>
                </div>
                <div className="flow-num">
                  <strong>{percent(d.share)}</strong>
                  <span className="muted small">{count(d.trips)}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(actions || onCompareMonths) && (
        <div className="flow-actions">
          {actions}
          {onCompareMonths && (
            <button onClick={() => onCompareMonths(!comparing)}>
              {comparing ? "Hide month comparison" : "Compare months"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
