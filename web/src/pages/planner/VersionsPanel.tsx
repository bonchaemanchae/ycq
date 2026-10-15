import { useEffect, useState } from "react";
import { DAYS, formatDate, hourLabel, type VersionSummary } from "./types";

type Props = {
  versions: VersionSummary[];
  openVersion: number | null;
  onOpen: (versionNo: number) => void;
  onCompare: (from: number, to: number) => void;
};

// Saved versions of the selected plan: open one, or compare two.
export default function VersionsPanel({ versions, openVersion, onOpen, onCompare }: Props) {
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  // Default comparison: the newest version against the one before it.
  useEffect(() => {
    setTo(versions[0]?.version_no ?? null);
    setFrom(versions[1]?.version_no ?? null);
  }, [versions]);

  if (versions.length === 0) {
    return (
      <div className="card">
        <div className="card-title">Versions</div>
        <p className="muted small">Every save becomes a new version. Nothing saved yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">Versions</div>
      <ul className="version-list">
        {versions.map((v) => (
          <li key={v.version_no} className={v.version_no === openVersion ? "selected" : ""}>
            <div>
              <div>
                <strong>v{v.version_no}</strong>{" "}
                <span className="muted small">{formatDate(v.created_at)}</span>
              </div>
              <div className="muted small">
                {DAYS[v.iso_dow - 1].slice(0, 3)} {hourLabel(v.start_hour)}–{hourLabel(v.end_hour)} · fleet{" "}
                {v.fleet_size} · {v.zones_used} zones
                {v.edited_rows > 0 && <> · <span className="tag">{v.edited_rows} edited</span></>}
              </div>
              {v.note && <div className="small note">“{v.note}”</div>}
            </div>
            <button onClick={() => onOpen(v.version_no)} disabled={v.version_no === openVersion}>
              {v.version_no === openVersion ? "Opened" : "Open"}
            </button>
          </li>
        ))}
      </ul>

      {versions.length > 1 && (
        <div className="compare-form">
          <span className="small muted">Compare</span>
          <select value={from ?? ""} onChange={(e) => setFrom(Number(e.target.value))}>
            {versions.map((v) => <option key={v.version_no} value={v.version_no}>v{v.version_no}</option>)}
          </select>
          <span className="small muted">→</span>
          <select value={to ?? ""} onChange={(e) => setTo(Number(e.target.value))}>
            {versions.map((v) => <option key={v.version_no} value={v.version_no}>v{v.version_no}</option>)}
          </select>
          <button disabled={from === null || to === null || from === to} onClick={() => onCompare(from!, to!)}>
            Compare
          </button>
        </div>
      )}
    </div>
  );
}
