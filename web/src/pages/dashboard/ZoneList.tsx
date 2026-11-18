import { useState } from "react";
import { count, percent, signed, type ZoneRow } from "./types";

type Props = {
  title: string;
  sub: string;
  zones: ZoneRow[];                 // already ranked
  value: (z: ZoneRow) => { main: string; mainClass?: string; detail: string };
  onOpen: (zoneId: number) => void; // show where its trips go
  compared: number[];
  onCompare: (zoneId: number) => void;
  maxCompared: number;
  selected?: number | null;         // the zone whose flows are open
  first?: number;                   // rows shown before "Show more"
};

const STEP = 20;

// A ranked list of zones beside the map. Clicking a zone shows where its
// trips go; + adds it to the comparison under the map.
export default function ZoneList({ title, sub, zones, value, onOpen, compared, onCompare, maxCompared,
                                   selected, first = 8 }: Props) {
  const [shown, setShown] = useState(first);
  const rows = zones.slice(0, shown);

  return (
    <div className="zone-list">
      <div className="card-title">{title}<div className="card-sub">{sub}</div></div>
      {zones.length === 0 && <p className="muted small">No zone matches the filters.</p>}
      <ol>
        {rows.map((z, i) => {
          const v = value(z);
          const inCompare = compared.includes(z.zoneId);
          return (
            <li key={z.zoneId} className={z.zoneId === selected ? "picked" : ""}>
              <button className="zl-open" onClick={() => onOpen(z.zoneId)} title="Show where trips from this zone go">
                <span className="zl-rank">{i + 1}</span>
                <span className="zl-name">
                  {z.zoneName}
                  <span className="muted small">{z.borough} · {v.detail}</span>
                </span>
                <span className={`zl-value ${v.mainClass ?? ""}`}>{v.main}</span>
              </button>
              <button className={`zl-compare ${inCompare ? "on" : ""}`} onClick={() => onCompare(z.zoneId)}
                      disabled={!inCompare && compared.length >= maxCompared}
                      title={inCompare ? "Remove from the comparison" : `Compare (up to ${maxCompared} zones)`}
                      aria-label={inCompare ? `Remove ${z.zoneName} from the comparison` : `Compare ${z.zoneName}`}>
                {inCompare ? "✓" : "+"}
              </button>
            </li>
          );
        })}
      </ol>
      {zones.length > shown && (
        <button className="link" onClick={() => setShown(shown + STEP)}>
          Show more ({zones.length - shown} left)
        </button>
      )}
      {shown > first && (
        <button className="link" onClick={() => setShown(first)}>Show fewer</button>
      )}
    </div>
  );
}

// What each row shows in the two map modes.
export const demandValue = (z: ZoneRow) => ({
  main: count(z.pickups),
  detail: `${percent(z.pickupShare)} of pickups`,
});
export const shortageValue = (z: ZoneRow) => ({
  main: signed(z.imbalance),
  mainClass: z.imbalance > 0 ? "short" : z.imbalance < 0 ? "surplus" : "",
  detail: `${count(z.pickups)} pickups, ${count(z.dropoffs)} drop-offs`,
});
