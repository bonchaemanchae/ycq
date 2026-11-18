import { useMemo, useState } from "react";
import type { Zone } from "../flows/types";

type Props = {
  zones: Zone[];
  selected: number[];
  max: number;
  onAdd: (zoneId: number) => void;
  onRemove: (zoneId: number) => void;
};

// Pick zones to compare by name, grouped by borough. Chips show the ones picked.
export default function ZonePicker({ zones, selected, max, onAdd, onRemove }: Props) {
  const [choice, setChoice] = useState("");
  const name = useMemo(() => new Map(zones.map((z) => [z.location_id, z.zone_name])), [zones]);
  const byBorough = useMemo(() => {
    const groups: Record<string, Zone[]> = {};
    for (const z of zones) {
      if (!groups[z.borough]) groups[z.borough] = [];
      groups[z.borough].push(z);
    }
    for (const list of Object.values(groups)) list.sort((a, b) => a.zone_name.localeCompare(b.zone_name));
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [zones]);
  const full = selected.length >= max;

  return (
    <div className="zone-picker">
      <form className="zone-picker-form" onSubmit={(e) => {
        e.preventDefault();
        if (choice) onAdd(Number(choice));
        setChoice("");
      }}>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={full} aria-label="Zone to compare">
          <option value="">{full ? `${max} zones picked (remove one to add another)` : "Choose a zone to compare…"}</option>
          {byBorough.map(([borough, list]) => (
            <optgroup key={borough} label={borough}>
              {list.map((z) => (
                <option key={z.location_id} value={z.location_id} disabled={selected.includes(z.location_id)}>
                  {z.zone_name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button className="primary" disabled={!choice || full}>Add</button>
      </form>
      <div className="chips">
        {selected.map((id) => (
          <span key={id} className="chip on">
            {name.get(id) ?? `Zone ${id}`}
            <button className="chip-x" onClick={() => onRemove(id)} aria-label={`Remove ${name.get(id) ?? id}`}>×</button>
          </span>
        ))}
      </div>
    </div>
  );
}
