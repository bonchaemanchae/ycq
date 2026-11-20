import { useEffect, useState } from "react";
import { DAYS, endLabel, formatDate, hourLabel, type VersionSummary } from "./types";

type Props = {
  planName: string;
  versions: VersionSummary[];
  openVersion: number | null;
  onOpen: (versionNo: number) => void;
  onCompare: (from: number, to: number) => void;
};

// Saved versions of the selected plan, one compact row each: when it was
// saved, its shift as tags, its seal, and a button to open it in the planner.
// Two versions can be compared below.
export default function VersionsPanel({ planName, versions, openVersion, onOpen, onCompare }: Props) {
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
        <div className="card-title">{planName}</div>
        <p className="muted small">No versions yet. Open the planner and save one.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-title">
        {planName} <span className="muted versions-count">{versions.length} {versions.length === 1 ? "version" : "versions"}</span>
      </div>
      <ul className="version-list">
        {versions.map((v) => (
          <li key={v.version_no} className={v.version_no === openVersion ? "selected" : ""}>
            <div className="version-main">
              <span className="version-id">
                <strong>v{v.version_no}</strong> <span className="muted small">{formatDate(v.created_at)}</span>
              </span>
              <span className="version-tags">
                <span className="vpill">{DAYS[v.iso_dow - 1].slice(0, 3)} {hourLabel(v.start_hour)}–{endLabel(v.end_hour)}</span>
                <span className="vpill">{v.fleet_size.toLocaleString()} taxis</span>
                <span className="vpill">{v.zones_used} zones</span>
                {v.edited_rows > 0 && (
                  <span className="vpill edits" title="Numbers changed by hand from the planner's proposal">
                    {v.edited_rows} {v.edited_rows === 1 ? "edit" : "edits"}
                  </span>
                )}
              </span>
              {v.note && <span className="version-note">“{v.note}”</span>}
            </div>
            {v.seal_problem ? (
              <span className="seal bad" title={v.seal_problem}>⚠ Changed after saving</span>
            ) : v.hash && (
              <span className="seal" title={`Sealed with SHA-256 when it was saved, and chained to the version before it, so any later change would be detected.\n${v.hash}`}>
                <span className="seal-badge">✓ Verified</span>
                <code>{v.hash.slice(0, 7)}</code>
              </span>
            )}
            <span className="version-open">
              {v.version_no === openVersion && <span className="tag">In the planner now</span>}
              <button onClick={() => onOpen(v.version_no)}
                      title={`Loads this version's shift and taxis into the planner. Saving there creates a new version; v${v.version_no} stays sealed.`}>
                Open in planner
              </button>
            </span>
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
