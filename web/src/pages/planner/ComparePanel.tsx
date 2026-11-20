import { useMemo, useState } from "react";
import { useApi } from "../flows/useApi";
import type { Zone } from "../flows/types";
import { DAYS, endLabel, hourLabel, type Change, type SavedVersion, type VersionSummary } from "./types";

type Props = {
  from: VersionSummary;
  to: VersionSummary;
  a: SavedVersion;          // the older version, in full
  b: SavedVersion;          // the newer version, in full
  changes: Change[];        // GET /plans/{id}/compare: names for the zones that changed
  onClose: () => void;
};

const shift = (v: { iso_dow: number; start_hour: number; end_hour: number }) =>
  `${DAYS[v.iso_dow - 1].slice(0, 3)} ${hourLabel(v.start_hour)}–${endLabel(v.end_hour)}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const signed = (n: number) => `${n > 0 ? "+" : "−"}${Math.abs(n).toLocaleString()}`;

type ZoneDiff = {
  id: number; name: string; borough: string;
  cells: Map<number, { a: number | null; b: number | null }>;   // null: that version doesn't cover the hour
  change: number;            // total change over the hours both versions cover
  status: "added" | "removed" | "changed" | "same";
};

// Two saved versions side by side, the way a plan is read: key figures that
// actually changed, then a zone per row and an hour per column, each cell the
// newer number with its change. Only zones that changed are listed at first.
export default function ComparePanel({ from, to, a, b, changes, onClose }: Props) {
  const [showAll, setShowAll] = useState(false);
  const zones = useApi<Zone[]>("/zones");

  const { hours, diffs } = useMemo(() => {
    const aHours = new Set(range(a.start_hour, a.end_hour));
    const bHours = new Set(range(b.start_hour, b.end_hour));
    const sameDay = a.iso_dow === b.iso_dow;
    const hours = [...new Set([...aHours, ...bHours])].sort((x, y) => x - y);
    const cell = (v: SavedVersion) => new Map(v.results.map((r) => [`${r.hour}:${r.location_id}`, r.final_taxis]));
    const A = cell(a), B = cell(b);
    const names = new Map<number, { name: string; borough: string }>();
    for (const z of zones.data ?? []) names.set(z.location_id, { name: z.zone_name, borough: z.borough });
    for (const c of changes) names.set(c.location_id, { name: c.zone_name, borough: c.borough });
    const ids = new Set([...a.results, ...b.results].map((r) => r.location_id));

    const diffs: ZoneDiff[] = [...ids].map((id) => {
      const cells = new Map<number, { a: number | null; b: number | null }>();
      let change = 0, inA = false, inB = false;
      for (const h of hours) {
        const av = aHours.has(h) ? A.get(`${h}:${id}`) ?? 0 : null;
        const bv = bHours.has(h) ? B.get(`${h}:${id}`) ?? 0 : null;
        cells.set(h, { a: av, b: bv });
        if (av) inA = true;
        if (bv) inB = true;
        if (av !== null && bv !== null && sameDay) change += bv - av;
      }
      const moved = [...cells.values()].some((c) => c.a !== null && c.b !== null && c.a !== c.b);
      const status = inB && !inA ? "added" : inA && !inB ? "removed" : moved || !sameDay ? "changed" : "same";
      const n = names.get(id);
      return { id, name: n?.name ?? `Zone ${id}`, borough: n?.borough ?? "", cells, change, status };
    });
    const weight = (d: ZoneDiff) => [...d.cells.values()].reduce((s, c) => s + Math.abs((c.b ?? 0) - (c.a ?? 0)), 0);
    diffs.sort((x, y) => weight(y) - weight(x) || x.name.localeCompare(y.name));
    return { hours, diffs };
  }, [a, b, changes, zones.data]);

  const changed = diffs.filter((d) => d.status !== "same");
  const added = diffs.filter((d) => d.status === "added");
  const removed = diffs.filter((d) => d.status === "removed");
  const shiftChanged = a.iso_dow !== b.iso_dow || a.start_hour !== b.start_hour || a.end_hour !== b.end_hour;
  const shared = hours.filter((h) => h >= Math.max(a.start_hour, b.start_hour) && h <= Math.min(a.end_hour, b.end_hour));
  const biggest = !shiftChanged || a.iso_dow === b.iso_dow
    ? [...diffs].filter((d) => d.change !== 0).sort((x, y) => Math.abs(y.change) - Math.abs(x.change))[0]
    : undefined;
  const perHour = (d: ZoneDiff) => Math.round(d.change / Math.max(1, shared.length));
  const shown = showAll ? diffs : changed;

  // only the figures that changed
  const tiles = [
    a.fleet_size !== b.fleet_size && {
      value: `${a.fleet_size.toLocaleString()} → ${b.fleet_size.toLocaleString()}`,
      label: `taxis (${signed(b.fleet_size - a.fleet_size)})`,
    },
    shiftChanged && { value: `${shift(a)} → ${shift(b)}`, label: "shift", small: true },
    { value: `${changed.length} of ${diffs.length}`, label: "zones changed" },
    biggest && perHour(biggest) !== 0 && {
      value: biggest.name, label: `${signed(perHour(biggest))} taxis an hour, the biggest change`, small: true,
    },
    added.length > 0 && { value: added.map((d) => d.name).join(", "), label: `zone${added.length > 1 ? "s" : ""} added`, small: true },
    removed.length > 0 && { value: removed.map((d) => d.name).join(", "), label: `zone${removed.length > 1 ? "s" : ""} removed`, small: true },
  ].filter(Boolean) as { value: string; label: string; small?: boolean }[];

  return (
    <div className="card compare-card">
      <div className="card-head">
        <div className="card-title">Compare v{from.version_no} → v{to.version_no}</div>
        <button className="link" onClick={onClose}>Close</button>
      </div>

      {changed.length === 0 && !shiftChanged && a.fleet_size === b.fleet_size ? (
        <p className="muted">The two versions place every taxi in the same zones.</p>
      ) : (
        <>
          <div className="cmp-tiles">
            {tiles.map((t) => (
              <div key={t.label} className="cmp-tile">
                <div className={`cmp-tile-value ${t.small ? "small-value" : ""}`}>{t.value}</div>
                <div className="cmp-tile-label">{t.label}</div>
              </div>
            ))}
          </div>

          <div className="table-wrap">
            <table className="cmp-grid" style={{ minWidth: 300 + hours.length * 110 }}>
              <colgroup><col className="cmp-zone-col" />{hours.map((h) => <col key={h} />)}</colgroup>
              <thead>
                <tr>
                  <th>Zone</th>
                  {hours.map((h) => <th key={h} className="num">{hourLabel(h)}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id} className={d.status}>
                    <td>
                      <span className="cmp-zone">{d.name}</span>
                      {d.status === "added" && <span className="cmp-tag added">New</span>}
                      {d.status === "removed" && <span className="cmp-tag removed">Removed</span>}
                    </td>
                    {hours.map((h) => {
                      const c = d.cells.get(h)!;
                      if (c.b === null) {
                        return <td key={h} className="num muted" title={`v${to.version_no} doesn't cover ${hourLabel(h)}`}>–</td>;
                      }
                      // no taxis there in either version: an empty hour, as in the planner
                      if (c.b === 0 && !c.a) return <td key={h} className="num muted">–</td>;
                      const delta = c.a === null ? null : c.b - c.a;
                      return (
                        <td key={h} className={`num ${delta === 0 ? "cmp-same" : ""}`}
                            title={c.a === null ? `v${from.version_no} doesn't cover ${hourLabel(h)}` : `v${from.version_no}: ${c.a} → v${to.version_no}: ${c.b}`}>
                          <span className="cmp-val">{c.b}</span>
                          {delta !== null && delta !== 0 && (
                            <span className={`cmp-delta ${delta > 0 ? "pos" : "neg"}`}>{signed(delta)}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {diffs.length > changed.length && (
            <button className="link cmp-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show only zones that changed" : `Show unchanged zones (${diffs.length - changed.length})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
