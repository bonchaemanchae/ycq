import { useState } from "react";
import { DAYS, endLabel, hourLabel, type PlanSummary } from "./types";

type Props = {
  plans: PlanSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onRename: (id: number, name: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
};

// The analyst's plans: pick, rename and delete (CRUD on allocation_plan; a
// plan is created by saving one in the planner). Each plan is two short lines:
// its name, and its latest version's shift and taxis.
export default function PlansPanel({ plans, selectedId, onSelect, onRename, onDelete }: Props) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  return (
    <div className="card plans-card">
      <div className="card-title">Your plans</div>
      {plans.length === 0 && <p className="muted small">No plans yet. Build one in the planner and save it.</p>}
      <ul className="plan-list">
        {plans.map((p) => {
          const selected = p.allocation_plan_id === selectedId;
          return (
            <li key={p.allocation_plan_id} className={selected ? "selected" : ""}>
              {renaming === p.allocation_plan_id ? (
                <form className="inline-form" onSubmit={async (e) => {
                  e.preventDefault();
                  await onRename(p.allocation_plan_id, renameTo);
                  setRenaming(null);
                }}>
                  <input autoFocus value={renameTo} maxLength={100} onChange={(e) => setRenameTo(e.target.value)} />
                  <button className="primary" disabled={!renameTo.trim()}>Save</button>
                  <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : confirmDelete === p.allocation_plan_id ? (
                <div className="plan-confirm">
                  <span className="small">Delete “{p.name}” and all its versions?</span>
                  <button className="danger" onClick={async () => {
                    await onDelete(p.allocation_plan_id);
                    setConfirmDelete(null);
                  }}>Delete</button>
                  <button onClick={() => setConfirmDelete(null)}>Keep</button>
                </div>
              ) : (
                <div className="plan-row">
                  <button className="plan-item" onClick={() => onSelect(p.allocation_plan_id)}>
                    <span className="plan-name">{p.name}</span>
                    <span className="muted small">
                      {p.latest_version
                        ? `${DAYS[p.iso_dow! - 1].slice(0, 3)} ${hourLabel(p.start_hour!)}–${endLabel(p.end_hour!)}, ${p.fleet_size!.toLocaleString()} taxis`
                        : "No versions yet"}
                    </span>
                  </button>
                  {selected && (
                    <span className="plan-icons">
                      <button className="icon-btn" title="Rename" aria-label={`Rename ${p.name}`}
                              onClick={() => { setRenaming(p.allocation_plan_id); setRenameTo(p.name); }}>✎</button>
                      <button className="icon-btn danger-icon" title="Delete" aria-label={`Delete ${p.name}`}
                              onClick={() => setConfirmDelete(p.allocation_plan_id)}>🗑</button>
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
