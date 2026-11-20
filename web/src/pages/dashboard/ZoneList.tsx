import { count, percent, type ZoneRow } from "./types";

type Props = {
  title: string;
  columns: [string, string];        // header row: the zone column and the number column
  zones: ZoneRow[];                 // already ranked
  value: (z: ZoneRow) => { main: string; mainClass?: string; detail: string };
  onOpen: (zoneId: number) => void; // show where its trips go
  compared: number[];
  onCompare: (zoneId: number) => void;
  maxCompared: number;
  selected?: number | null;         // the zone whose flows are open
};

// A ranked list of every matching zone beside the map, scrolling inside its
// panel. Clicking a zone shows where its trips go; + adds it to the
// comparison under the map.
export default function ZoneList({ title, columns, zones, value, onOpen, compared, onCompare, maxCompared,
                                   selected }: Props) {

  return (
    <div className="zone-list">
      <div className="card-title">{title}</div>
      <div className="zl-head" aria-hidden="true">
        <span>{columns[0]}</span>
        <span>{columns[1]}</span>
      </div>
      {zones.length === 0 && <p className="muted small">No zone matches the filters.</p>}
      <ol>
        {zones.map((z, i) => {
          const v = value(z);
          const inCompare = compared.includes(z.zoneId);
          return (
            <li key={z.zoneId} className={z.zoneId === selected ? "picked" : ""}>
              <button className="zl-open" onClick={() => onOpen(z.zoneId)} title="Show where trips from this zone go">
                <span className="zl-rank">{i + 1}</span>
                <span className="zl-name">
                  {z.zoneName}
                  <span className="muted small">{z.borough}, {v.detail}</span>
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
    </div>
  );
}

// What each row shows in the two map modes.
export const demandValue = (z: ZoneRow) => ({
  main: count(z.pickups),
  detail: `${percent(z.pickupShare)} of pickups`,
});
export const shortageValue = (z: ZoneRow) => ({
  main: count(Math.abs(z.imbalance)),
  mainClass: z.imbalance > 0 ? "short" : z.imbalance < 0 ? "surplus" : "",
  detail: `${count(z.pickups)} pickups, ${count(z.dropoffs)} drop-offs`,
});
