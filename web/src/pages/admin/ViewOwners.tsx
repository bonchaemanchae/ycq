import { useEffect, useState } from "react";
import { api, del } from "../../api";
import { n } from "./types";

type Orphans = { views: number; orphaned: number; owners: number[] };

// The one link between the databases no constraint can hold: every saved view
// (MongoDB) must belong to a user that exists (PostgreSQL). Checked live from
// GET /admin/orphaned-views each time the page opens.
export default function ViewOwners() {
  const [data, setData] = useState<Orphans | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = () => api<Orphans>("/admin/orphaned-views").then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);

  const remove = async () => {
    try {
      await del("/admin/orphaned-views");
      setConfirming(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <div className="alert error"><span>{error}</span></div>;
  if (!data) return null;
  const ok = data.orphaned === 0;
  return (
    <div className={`recon-month view-owners ${ok ? "ok" : "bad"}`}>
      <div className="recon-head">
        <strong>Saved views ↔ users</strong>
        <span className={`status-pill ${ok ? "ok" : "bad"}`}>{ok ? "✓ every owner exists" : "! orphaned views"}</span>
      </div>
      <p className="muted small">
        {ok
          ? `All ${n(data.views)} saved views in MongoDB belong to users that exist in PostgreSQL.`
          : `${n(data.orphaned)} of ${n(data.views)} saved views belong to users that no longer exist ` +
            `(user ids ${data.owners.join(", ")}). Nobody can open them.`}
      </p>
      {!ok && (confirming ? (
        <div className="row">
          <span className="small">Delete these {n(data.orphaned)} views?</span>
          <button className="danger" onClick={remove}>Delete</button>
          <button onClick={() => setConfirming(false)}>Keep</button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)}>Delete orphaned views</button>
      ))}
    </div>
  );
}
