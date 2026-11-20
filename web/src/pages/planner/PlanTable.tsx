import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { METRICS, endLabel, hourLabel, notableNotes, whyLine, type Row, type Settings } from "./types";

export type TableRow = Row & { final: number; added: boolean };
export type HourSlot = { rows: TableRow[]; candidates: Row[]; left: number };

type Props = {
  hours: number[];
  byHour: Record<number, HourSlot>;
  weights: Settings;               // the settings the plan was scored with
  fleet: number;
  watched: number[];               // zones brought over from the dashboard
  names: Map<number, string>;
  focusId: number | null;
  mapHour: number;
  onSet: (row: Row, taxis: number) => void;
  onAddZone: (zoneId: number) => void;      // to every hour where it's eligible
  onRemoveZone: (zoneId: number) => void;   // a zone the analyst added
  onBalance: (hour: number) => void;
  onFocus: (zoneId: number) => void;        // highlight it on the map
  onMapHour: (hour: number) => void;
  need: Record<number, number | null>;      // taxis each hour's demand needs (pickups x average trip)
  details: boolean;                         // admins' database details: the Why? numbers
};

const money = (v: number | null) => (v === null ? "—" : `$${Number(v).toFixed(2)}`);
// pickups at this hour on an average day, for zones with too few to recommend
const perDay = (r: Row) => (Number(r.avg_pickups) < 0.5 ? "<1 a day" : `≈${Math.round(Number(r.avg_pickups))} a day`);
const fewTitle = (r: Row) =>
  `Few trips here at ${hourLabel(r.hour)} (${perDay(r)}), so the planner doesn't recommend it. You can still place taxis here.`;

// The whole plan at once: a row per zone, a column per hour, every number
// editable. Each hour's column must add up to the fleet; its total sits under
// it. The zone column stays put when a long shift scrolls sideways. "Why?"
// opens the numbers behind a zone's ranking.
export default function PlanTable({ hours, byHour, weights, fleet, watched, names, focusId, mapHour, onSet, onAddZone,
                                    onRemoveZone, onBalance, onFocus, onMapHour, need, details }: Props) {
  // hours whose demand needs more taxis than the fleet: their column is tinted
  // and its header says how many are needed
  const short = (h: number) => need[h] !== null && need[h] !== undefined && need[h]! > fleet;
  const [why, setWhy] = useState<number | null>(null);

  // every zone in the plan at any hour, best ranked first
  const zones = useMemo(() => {
    const out = new Map<number, { id: number; name: string; borough: string; total: number; best: number; added: boolean;
                                  rows: Map<number, TableRow> }>();
    for (const h of hours) {
      for (const r of byHour[h].rows) {
        const z = out.get(r.location_id) ?? { id: r.location_id, name: r.zone_name, borough: r.borough, total: 0,
                                              best: Infinity, added: false, rows: new Map() };
        z.total += r.final;
        z.best = Math.min(z.best, r.rank);
        z.added ||= r.added;
        z.rows.set(h, r);
        out.set(r.location_id, z);
      }
    }
    // by the planner's ranking, not by taxis, so rows never move while numbers are typed
    return [...out.values()].sort((a, b) => a.best - b.best || a.id - b.id);
  }, [hours, byHour]);

  // eligible zones not in the plan at any hour, best ranked first
  const others = useMemo(() => {
    const inPlan = new Set(zones.map((z) => z.id));
    const best = new Map<number, Row>();
    for (const h of hours) {
      for (const c of byHour[h].candidates) {
        if (inPlan.has(c.location_id)) continue;
        const seen = best.get(c.location_id);
        if (!seen || c.rank < seen.rank) best.set(c.location_id, c);
      }
    }
    return [...best.values()].sort((a, b) => a.rank - b.rank);
  }, [hours, byHour, zones]);

  useEffect(() => {
    if (focusId !== null) document.getElementById(`zone-row-${focusId}`)?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  // the borough beside each name only when the plan covers more than one
  const manyBoroughs = new Set(zones.map((z) => z.borough)).size > 1;

  // zones from the dashboard that aren't in the plan: why not, and one click to add them
  const missing = watched.filter((id) => !zones.some((z) => z.id === id));

  return (
    <div className="plan-table">
      {missing.length > 0 && (
        <div className="watched">
          <span className="watched-title">From the dashboard, not in this plan</span>
          {missing.map((id) => {
            const candidate = others.find((c) => c.location_id === id);
            return (
              <div key={id} className="watched-item">
                <button className="link watched-name" onClick={() => onFocus(id)}>{names.get(id) ?? `Zone ${id}`}</button>
                {candidate ? (
                  <span>{candidate.reliable
                    ? `ranked #${candidate.rank}, below the top ${weights.max_zones_per_hour}`
                    : "too few trips on this shift to recommend"}{" "}
                    <button className="watched-add" onClick={() => onAddZone(id)}>Add it</button></span>
                ) : (
                  <span className="muted">not eligible on this shift: outside the chosen boroughs, or too few pickups</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="table-wrap plan-scroll">
        {/* fixed widths: the zone column and every hour column keep their size whatever is shown */}
        <table className="plan-grid" style={{ minWidth: 300 + hours.length * 96 }}>
          <colgroup>
            <col className="zone-colw" />
            {hours.map((h) => <col key={h} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="zone-col">Zone</th>
              {hours.map((h) => (
                <th key={h} className={`num hour-col ${h === mapHour ? "on-map" : ""} ${short(h) ? "short-col" : ""}`}>
                  <button className="link" onClick={() => onMapHour(h)}
                          title={`${hourLabel(h)}–${endLabel(h)}: how many taxis should wait in each zone at the start of this hour. Click to show this hour on the map.`}>
                    {hourLabel(h)}
                  </button>
                  {short(h) && (
                    <div className="need-note"
                         title={`About ${need[h]!.toLocaleString()} taxis are busy with passengers at ${hourLabel(h)} (pickups an hour × the average trip); you have ${fleet.toLocaleString()}.`}>
                      ⚠ needs ≈{need[h]!.toLocaleString()}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {zones.map((z) => {
              // the reason from the zone's best-ranked hour, so it doesn't change with the map's hour
              const first = [...z.rows.values()].sort((a, b) => Number(b.reliable) - Number(a.reliable) || a.rank - b.rank)[0];
              const notes = notableNotes(first);
              const reason = first.reliable ? whyLine(first, weights) : "Few trips here: not recommended, your choice";
              const open = why === z.id;
              return (
                <Fragment key={z.id}>
                  <tr id={`zone-row-${z.id}`}
                      className={`${z.id === focusId ? "focus" : ""} ${watched.includes(z.id) ? "watched-row" : ""}`}>
                    <td className="zone-col">
                      <div className="zone-line">
                        <button className="zone-name zone-link" onClick={() => onFocus(z.id)}
                                title={`${reason}. Click to show it on the map; click again to zoom back out.`}>{z.name}</button>
                        {manyBoroughs && <span className="muted zone-borough">{z.borough}</span>}
                      </div>
                      <div className="zone-meta">
                        {z.added && (
                          <span className="pick-tag" title="Not recommended by the planner: you added this zone">
                            ＋ Your pick
                            <button className="pick-x" onClick={() => onRemoveZone(z.id)}
                                    aria-label={`Remove ${z.name} from the plan`} title="Remove from the plan">✕</button>
                          </span>
                        )}
                        {watched.includes(z.id) && <span className="tag watch" title="You looked at this zone on the Analytical Dashboard">Watched</span>}
                        {notes.map((n) => (
                          <span key={n.text} className={`note-tag ${n.kind}`} title={n.help}>
                            {n.kind === "warn" ? "⚠ " : ""}{n.text}
                          </span>
                        ))}

                        {details && (
                          <button className="link small" onClick={() => setWhy(open ? null : z.id)} aria-expanded={open}>
                            {open ? "Hide" : "Why?"}
                          </button>
                        )}
                      </div>
                    </td>
                    {hours.map((h) => {
                      const r = z.rows.get(h);
                      const candidate = r ? null : byHour[h].candidates.find((c) => c.location_id === z.id);
                      if (!r && !candidate) {
                        return <td key={h} className="num muted" title="Not eligible at this hour">—</td>;
                      }
                      // not in the plan this hour: an empty box, and typing a number adds it;
                      // a zone with too few trips to recommend shows how many it has
                      const row = (r ?? candidate)!;
                      const edited = r ? r.final !== r.proposed_taxis && r.selected : false;
                      return (
                        <td key={h} className={`num cell ${short(h) ? "short-col" : ""} ${edited ? "edited" : ""} ${r && !(r.added && r.final === 0) ? "" : "not-in"} ${row.reliable ? "" : "few"} ${h === mapHour ? "on-map" : ""}`}
                            title={!row.reliable ? fewTitle(row) : r ? undefined : "Not in the plan at this hour. Type a number to add it."}>
                          <TaxiInput value={r && !(r.added && r.final === 0) ? r.final : null} label={`${z.name} at ${hourLabel(h)}`}
                                     onSet={(n) => onSet(row, n)} />
                          {edited && <div className="muted small">was {r!.proposed_taxis}</div>}
                          {!row.reliable && <div className="few-note">{perDay(row)}</div>}
                        </td>
                      );
                    })}
                  </tr>
                  {open && details && (
                    <tr className="why-row">
                      <td colSpan={hours.length + 1}>
                        <WhyDetails rows={hours.flatMap((h) => z.rows.get(h) ?? [])} weights={weights} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="zone-col" title="Every taxi has to be placed somewhere each hour">
                <strong>Adds up to {fleet.toLocaleString()}</strong>
              </td>
              {hours.map((h) => {
                const left = byHour[h].left;
                return (
                  <td key={h} className={`num total ${left === 0 ? "ok" : "bad"} ${short(h) ? "short-col" : ""}`}>
                    {left === 0 ? <span title={`${fleet.toLocaleString()} taxis`}>✓</span> : (
                      <>
                        <div>{left > 0 ? `${left} not placed` : `${-left} extra`}</div>
                        {byHour[h].rows.length === 0 ? <div className="muted small">type taxis into a zone</div> : (
                        <button className="link small" onClick={() => onBalance(h)}
                                title={left > 0 ? `Give the ${left} to the top zone` : `Take ${-left} from the lowest-ranked zones`}>
                          Fix
                        </button>)}
                      </>
                    )}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="add-zone">
        <select value="" onChange={(e) => e.target.value && onAddZone(Number(e.target.value))} disabled={others.length === 0}>
          <option value="">{others.length ? "+ Add a zone" : "Every zone is in the plan"}</option>
          {others.map((c) => (
            <option key={c.location_id} value={c.location_id}>
              {c.zone_name} ({c.borough}), {c.reliable ? `ranked #${c.rank}` : "few trips, not recommended"}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// The numbers behind a zone's ranking, hour by hour: the score and its four
// parts, average pickups and the net (pickups minus drop-offs), the median fare.
function WhyDetails({ rows, weights }: { rows: TableRow[]; weights: Settings }) {
  return (
    <div className="why-details">
      <div className="score-legend">
        <span className="muted small">Score =</span>
        {METRICS.map((m) => (
          <span key={m.label} className="small" title={m.help}>
            <span className="dot" style={{ background: m.color }} /> {m.label} ×{weights[m.weight].toFixed(2)}
          </span>
        ))}
        <span className="muted small">(each as a percentile among the zones that hour)</span>
      </div>
      <table className="why-table">
        <thead>
          <tr><th>Hour</th><th>Rank</th><th>Score</th><th className="num">Pickups / hour</th>
              <th className="num">Net</th><th className="num">Median fare</th><th className="num">Days of data</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.hour}>
              <td>{hourLabel(r.hour)}</td>
              <td>#{r.rank}</td>
              <td>
                <div className="score">
                  <div className="score-bar">
                    {METRICS.map((m) => (
                      <span key={m.label} style={{ width: `${weights[m.weight] * r[m.pct] * 100}%`, background: m.color }} />
                    ))}
                  </div>
                  <span className="score-num">{Number(r.score).toFixed(3)}</span>
                </div>
              </td>
              <td className="num">{r.avg_pickups}</td>
              <td className={`num ${r.avg_imbalance > 0 ? "short" : r.avg_imbalance < 0 ? "surplus" : ""}`}>
                {r.avg_imbalance > 0 ? "+" : ""}{r.avg_imbalance}
              </td>
              <td className="num">{money(r.median_fare)}</td>
              <td className="num">{r.days}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A number box for taxis. Clicking selects the number, so typing replaces it;
// an empty box stays empty while typing (and counts as 0 once you leave it);
// leading zeros are dropped. Empty boxes are zones not in the plan that hour.
function TaxiInput({ value, label, onSet }: { value: number | null; label: string; onSet: (n: number) => void }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [editing, setEditing] = useState(false);
  // a mouse click would undo the select-all when the button is released
  const justFocused = useRef(false);
  useEffect(() => {
    if (!editing) setText(value === null ? "" : String(value));
  }, [value, editing]);
  return (
    <input type="text" inputMode="numeric" value={text} placeholder="–" aria-label={label}
           onFocus={(e) => { setEditing(true); justFocused.current = true; e.target.select(); }}
           onMouseUp={(e) => { if (justFocused.current) e.preventDefault(); justFocused.current = false; }}
           onChange={(e) => {
             const digits = e.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
             setText(digits);
             if (digits !== "") onSet(Math.min(Number(digits), 100000));
           }}
           onBlur={() => {
             setEditing(false);
             if (text === "" && value !== null) onSet(0);
           }} />
  );
}
