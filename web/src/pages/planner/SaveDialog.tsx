import { useEffect } from "react";
import type { PlanSummary } from "./types";

type Props = {
  plans: PlanSummary[];
  planId: number | null;            // null: save as a new plan
  onPickPlan: (value: string) => void;
  newName: string;
  onNewName: (name: string) => void;
  note: string;
  onNote: (note: string) => void;
  nextVersion: number;
  blocker: string | null;           // why it can't be saved yet
  error: string | null;             // why the last attempt failed
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
};

// Saving, asked only when the analyst is ready: a new plan or a new version of
// one of theirs, with an optional note. Saved versions are sealed for good.
export default function SaveDialog({ plans, planId, onPickPlan, newName, onNewName, note, onNote, nextVersion, blocker,
                                     error, busy, onSave, onClose }: Props) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog card" role="dialog" aria-modal="true" aria-labelledby="save-title">
        <div className="card-head">
          <div className="card-title" id="save-title">Save this plan</div>
          <button className="link" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label className="field">
          <span>Save to</span>
          <select value={planId ?? "new"} onChange={(e) => onPickPlan(e.target.value)}>
            <option value="new">A new plan…</option>
            {plans.map((p) => <option key={p.allocation_plan_id} value={p.allocation_plan_id}>{p.name}</option>)}
          </select>
        </label>
        {planId === null ? (
          <label className="field">
            <span>Name</span>
            <input autoFocus placeholder="e.g. Thursday evening rush" value={newName} maxLength={100}
                   onChange={(e) => onNewName(e.target.value)} />
          </label>
        ) : (
          <p className="muted small">Saved as version {nextVersion}. Earlier versions stay as they were.</p>
        )}
        <label className="field">
          <span>Note <span className="muted small">(optional)</span></span>
          <input placeholder="What changed, or why" value={note} maxLength={500} onChange={(e) => onNote(e.target.value)} />
        </label>
        {error && <div className="alert error"><span>{error}</span></div>}
        <div className="card-foot">
          <span className={`small ${blocker ? "danger-text" : "muted"}`}>
            {blocker ?? "A saved version can't be changed afterwards."}
          </span>
          <span className="dialog-actions">
            <button className="link" onClick={onClose}>Cancel</button>
            <button className="primary" onClick={onSave} disabled={busy || blocker !== null}>
              {busy ? "Saving…" : planId === null ? "Save" : `Save as v${nextVersion}`}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
