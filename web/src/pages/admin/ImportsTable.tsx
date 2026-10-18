import { n, pct, when, type ImportBatch } from "./types";

// The import record of each file, for checking against the expected counts.
export default function ImportsTable({ batches }: { batches: ImportBatch[] }) {
  return (
    <details className="card more-card">
      <summary className="card-title">Imported files</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Month</th><th>File</th><th>SHA-256</th>
              <th className="num">Read</th><th className="num">Accepted</th>
              <th className="num">Rejected</th><th className="num">Warned</th>
              <th>Status</th><th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.import_batch_id}>
                <td><strong>{b.month}</strong></td>
                <td>{b.source_file}</td>
                <td><code>{b.checksum_prefix}…</code></td>
                <td className="num">{n(b.rows_read)}</td>
                <td className="num">{n(b.rows_accepted)}</td>
                <td className="num">{n(b.rows_rejected)} <span className="muted small">{pct(b.rows_rejected, b.rows_read)}</span></td>
                <td className="num">{n(b.rows_warned)}</td>
                <td>{b.status}</td>
                <td>{when(b.finished_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
