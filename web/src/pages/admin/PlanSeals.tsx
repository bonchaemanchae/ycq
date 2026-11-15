import { useEffect, useState } from "react";
import { api } from "../../api";
import { n } from "./types";

type Seals = {
  versions: number;
  problems: { allocation_plan_id: number; version_no: number; problem: string }[];
};

// Saved plan versions form a hash chain (sql/017): each is sealed with a
// SHA-256 of its contents and of the seal before it. GET /admin/plan-seals
// recomputes every hash each time the page opens, so a version edited behind
// the database's triggers shows up here.
export default function PlanSeals() {
  const [data, setData] = useState<Seals | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Seals>("/admin/plan-seals").then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="alert error"><span>{error}</span></div>;
  if (!data) return null;
  const ok = data.problems.length === 0;
  return (
    <div className={`recon-month view-owners ${ok ? "ok" : "bad"}`}>
      <div className="recon-head">
        <strong>Saved plan versions ↔ their seals</strong>
        <span className={`status-pill ${ok ? "ok" : "bad"}`}>{ok ? "✓ every hash matches" : "! altered versions"}</span>
      </div>
      <p className="muted small">
        {ok
          ? `All ${n(data.versions)} saved plan versions still match the SHA-256 hash they were sealed with, ` +
            "and each follows the version before it."
          : `${n(data.problems.length)} of ${n(data.versions)} saved plan versions no longer match their seal:`}
      </p>
      {!ok && (
        <ul className="small">
          {data.problems.map((p) => (
            <li key={`${p.allocation_plan_id}:${p.version_no}`}>
              plan {p.allocation_plan_id} version {p.version_no}: {p.problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
