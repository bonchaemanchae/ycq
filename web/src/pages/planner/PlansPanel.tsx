import { useState } from "react";
import { DAYS, hourLabel, type PlanSummary } from "./types";

type Props = {
  plans: PlanSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: number, name: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
};

// The analyst's plans: create, pick, rename and delete (CRUD on allocation_plan).
export default function PlansPanel({ plans, selectedId, onSelect, onCreate, onRename, onDelete }: Props) {
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await onCreate(newName.trim());
    setNewName("");
  };

  return (
    <div className="card">
      <div className="card-title">Your plans</div>
      <form className="inline-form" onSubmit={create}>
        <input placeholder="New plan name" value={newName} maxLength={100}
               onChange={(e) => setNewName(e.target.value)} />
        <button className="primary" disabled={!newName.trim()}>Create</button>
      </form>

      {plans.length === 0 && <p className="muted small">No plans yet. Create one, then preview and save.</p>}
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
              ) : (
                <button className="plan-item" onClick={() => onSelect(p.allocation_plan_id)}>
                  <span className="plan-name">{p.name}</span>
                  <span className="muted small">
                    {p.latest_version
                      ? `v${p.latest_version} · ${DAYS[p.iso_dow! - 1].slice(0, 3)} ${hourLabel(p.start_hour!)}–${hourLabel(p.end_hour!)} · fleet ${p.fleet_size}`
                      : "no versions yet"}
                  </span>
                </button>
              )}

              {selected && renaming !== p.allocation_plan_id && (
                <div className="plan-actions">
                  {confirmDelete === p.allocation_plan_id ? (
                    <>
                      <span className="small">Delete this plan and all its versions?</span>
                      <button className="danger" onClick={async () => {
                        await onDelete(p.allocation_plan_id);
                        setConfirmDelete(null);
                      }}>Delete</button>
                      <button onClick={() => setConfirmDelete(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      <button className="link" onClick={() => { setRenaming(p.allocation_plan_id); setRenameTo(p.name); }}>
                        Rename
                      </button>
                      <button className="link danger-text" onClick={() => setConfirmDelete(p.allocation_plan_id)}>
                        Delete
                      </button>
                    </>
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
