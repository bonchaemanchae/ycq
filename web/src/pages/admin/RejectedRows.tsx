import { useEffect, useState } from "react";
import { api } from "../../api";
import { PLAIN, local, n, type ImportBatch, type RejectedPage } from "./types";

// The rejected rows themselves, 50 per page, optionally for one rule. Raw
// values are shown exactly as they were in the file.
export default function RejectedRows({ batch }: { batch: ImportBatch }) {
  const [code, setCode] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RejectedPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams({ batch: String(batch.import_batch_id), page: String(page) });
    if (code) q.set("code", code);
    let current = true;   // ignore a slow response once the filter or page has changed
    setError(null);
    api<RejectedPage>(`/admin/rejected?${q}`)
      .then((d) => current && setData(d))
      .catch((e: Error) => current && setError(e.message));
    return () => { current = false; };
  }, [batch.import_batch_id, code, page]);

  return (
    <details className="card more-card">
      <summary className="card-title">Inspect the rejected rows for {batch.month}</summary>
      <div className="row">
        <label className="small">
          Rule{" "}
          <select value={code} onChange={(e) => { setCode(e.target.value); setPage(1); }}>
            <option value="">All rules</option>
            {batch.rejects.map((r) => (
              <option key={r.code} value={r.code}>{r.code} · {PLAIN[r.code] ?? r.description} ({n(r.rows)})</option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="alert error">{error}</div>}
      {!data ? <p className="muted">Loading…</p> : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Row in file</th><th>Rule</th><th>Vendor</th><th>Pickup</th><th>Drop-off</th>
                  <th className="num">Pickup zone</th><th className="num">Drop-off zone</th><th className="num">Payment</th>
                  <th className="num">Passengers</th><th className="num">Miles</th>
                  <th className="num">Fare</th><th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.source_row_number}>
                    <td className="num">{r.source_row_number.toLocaleString()}</td>
                    <td><span className="code-chip" title={PLAIN[r.code]}>{r.code}</span></td>
                    <td>{r.vendor_id ?? "–"}</td>
                    <td>{local(r.pickup_ts)}</td>
                    <td>{local(r.dropoff_ts)}</td>
                    <td className="num">{r.pickup_location_id ?? "–"}</td>
                    <td className="num">{r.dropoff_location_id ?? "–"}</td>
                    <td className="num">{r.payment_type_id ?? "–"}</td>
                    <td className="num">{r.passenger_count ?? "–"}</td>
                    <td className="num">{r.trip_distance ?? "–"}</td>
                    <td className="num">{r.fare_amount ?? "–"}</td>
                    <td className="num">{r.total_amount ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <button onClick={() => setPage(page - 1)} disabled={page <= 1}>Previous</button>
            <span className="muted small">Page {data.page} of {data.pages} · {n(data.total)} rows</span>
            <button onClick={() => setPage(page + 1)} disabled={page >= data.pages}>Next</button>
          </div>
        </>
      )}
    </details>
  );
}
