import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import Proves from "./Proves";
import ReasonBars from "./ReasonBars";
import RejectedRows from "./RejectedRows";
import { compact, mb, n, pct, when, type ImportBatch, type ReconRun, type Stores } from "./types";

type StepId = 1 | 2 | 3 | 4 | 5;

// How the data gets from TLC's files into both databases, as five steps.
// Each step shows one number and the techniques it uses; clicking it opens
// the evidence underneath, so the page reads left to right like the talk:
// files, checks, PostgreSQL, MongoDB, then the cross-check.
// Data health links here with ?month=, which opens step 2 on that month.
export default function Pipeline({ batches, latest }: { batches: ImportBatch[]; latest: Map<string, ReconRun> }) {
  const [params] = useSearchParams();
  const linked = batches.some((b) => b.month === params.get("month")) ? params.get("month") : null;
  const [step, setStep] = useState<StepId>(linked ? 2 : 1);
  const [stores, setStores] = useState<Stores | null>(null);
  const [storesError, setStoresError] = useState<string | null>(null);
  useEffect(() => {
    api<Stores>("/admin/stores").then(setStores).catch((e: Error) => setStoresError(e.message));
  }, []);

  const sum = (k: "rows_read" | "rows_accepted" | "rows_rejected") => batches.reduce((s, b) => s + (b[k] ?? 0), 0);
  const read = sum("rows_read"), accepted = sum("rows_accepted"), rejected = sum("rows_rejected");
  const passed = batches.filter((b) => latest.get(b.month)?.passed === true).length;
  const allPassed = passed === batches.length;
  const format = (batches[0]?.source_file.split(".").pop() ?? "").replace(/^parquet$/i, "Parquet");
  const documents = stores?.mongo.reduce((n, c) => n + c.documents, 0);

  const steps: { id: StepId; title: string; value: string; unit: string; tags: string[]; tone?: string }[] = [
    { id: 1, title: "Trip files", value: compact(read), unit: "rows from NYC TLC", tags: [format, "checksum pinned"] },
    { id: 2, title: "Quality checks", value: pct(rejected, read), unit: "rejected, kept aside", tags: ["9 reject rules", "9 warning rules"] },
    { id: 3, title: "PostgreSQL", value: compact(accepted), unit: "trips, the source of truth", tags: ["COPY", "partitioned by month"] },
    { id: 4, title: "MongoDB", value: documents ? compact(documents) : "…", unit: `documents in ${stores?.mongo.length ?? 5} collections`,
      tags: ["time-series", "pre-summed"] },
    { id: 5, title: "Cross-check", value: `${passed} of ${batches.length}`, unit: "months match", tags: ["reconciliation"],
      tone: allPassed ? "good" : "bad" },
  ];

  return (
    <>
      <div className="card">
        <ol className="flow" aria-label="Data pipeline">
          {steps.map((s) => (
            <li key={s.id}>
              <button className={`flow-step ${s.id === step ? "on" : ""} ${s.tone ?? ""}`} onClick={() => setStep(s.id)}
                      aria-pressed={s.id === step}>
                <span className="flow-no">{s.id}</span>
                <span className="flow-title">{s.title}</span>
                <span className="flow-value">{s.value}</span>
                <span className="flow-unit">{s.unit}</span>
                <span className="flow-tags">{s.tags.map((t) => <span key={t} className="flow-tag">{t}</span>)}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      {step === 1 && (
        <Detail step={1} title="Trip files from NYC TLC" proves="repeatable loads with checksums">
          <div className="table-wrap">
            <table className="detail-table">
              <thead><tr><th>Month</th><th>File</th><th className="num">Rows</th><th>Checksum</th><th>Loaded</th></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.import_batch_id}>
                    <td><strong>{b.month}</strong></td>
                    <td><code>{b.source_file}</code></td>
                    <td className="num">{n(b.rows_read)}</td>
                    <td>
                      <span className={`file-badge ${b.status === "completed" ? "ok" : "bad"}`}
                            title={`SHA-256 ${b.checksum_prefix}…, matched the value pinned in the repository`}>
                        {b.status === "completed" ? "✓ Verified" : `! ${b.status}`}
                      </span>
                    </td>
                    <td className="small nowrap">{when(b.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Detail>
      )}

      {step === 2 && <Checks batches={batches} linked={linked} />}

      {step === 3 && (
        <Detail step={3} title="What PostgreSQL stores" proves="a partitioned relational design">
          {!stores ? <p className="muted">{storesError ?? "Loading…"}</p> : (
            <StoreList unit="row" rows={stores.postgres.tables.map((t) => ({
              ...t, count: t.rows,
              extra: t.name === "trip" ? (
                <span className="partitions">
                  {stores.postgres.partitions.map((p) => (
                    <span key={p.name} className="partition" title={`${p.name}, ${n(p.rows)} rows, ${mb(p.bytes)} with indexes`}>
                      {p.name.replace(/^trip_(\d{4})_(\d{2})$/, "$1-$2")} <strong>{compact(p.rows)}</strong>
                    </span>
                  ))}
                </span>
              ) : null,
            }))} />
          )}
        </Detail>
      )}

      {step === 4 && (
        <Detail step={4} title="What MongoDB stores" proves="documents shaped by the questions they answer">
          {!stores ? <p className="muted">{storesError ?? "Loading…"}</p> : (
            <StoreList unit="document" rows={stores.mongo.map((c) => ({ ...c, count: c.documents, extra: null }))} />
          )}
        </Detail>
      )}

      {step === 5 && (
        <Detail step={5} title="Both databases checked against each other" proves="consistency across two databases">
          <p className="detail-text">
            After every load, each hourly summary, pickup and drop-off in MongoDB is compared with PostgreSQL, zone by
            zone and hour by hour
          </p>
          <div className="month-checks">
            {batches.map((b) => {
              const ok = latest.get(b.month)?.passed === true;
              return <span key={b.month} className={`file-badge ${ok ? "ok" : "bad"}`}>{ok ? "✓" : "!"} {b.month}</span>;
            })}
            <Link to="/admin/health" className="detail-link">See it on Data health →</Link>
          </div>
        </Detail>
      )}
    </>
  );
}

// One table per database, the same columns for both: the name and its kind,
// what one row or document is, what in the app reads it, and how many.
function StoreList({ unit, rows }: {
  unit: "row" | "document";
  rows: { name: string; kind: string; one: string; used_by: string[]; count: number; extra: ReactNode }[];
}) {
  return (
    <div className="table-wrap">
      <table className="detail-table stores">
        <colgroup>
          <col style={{ width: "30%" }} /><col style={{ width: "30%" }} /><col style={{ width: "28%" }} /><col style={{ width: "12%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>{unit === "row" ? "Table" : "Collection"}</th><th>One {unit} is</th><th>Used by</th>
            <th className="num">{unit === "row" ? "Rows" : "Documents"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>
                <code>{r.name}</code>
                {r.kind !== "table" && <span className={`kind-tag ${r.kind === "time-series" ? "hot" : ""}`}>{r.kind}</span>}
                {r.extra}
              </td>
              <td>{r.one}</td>
              <td><span className="used-by">{r.used_by.map((u) => <span key={u} className="used-tag">{u}</span>)}</span></td>
              <td className="num"><strong>{n(r.count)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ step, title, proves, children }: { step: number; title: string; proves: string; children: ReactNode }) {
  return (
    <div className="card flow-detail">
      <div className="card-head">
        <div className="card-title section-title"><span className="detail-step">Step {step}</span>{title}</div>
        <Proves>{proves}</Proves>
      </div>
      {children}
    </div>
  );
}

// Step 2: how the rules split one month's rows, and the rejected rows themselves.
function Checks({ batches, linked }: { batches: ImportBatch[]; linked: string | null }) {
  const [month, setMonth] = useState(linked ?? batches[batches.length - 1].month);
  const batch = batches.find((b) => b.month === month) ?? batches[batches.length - 1];
  useEffect(() => {
    if (linked) document.getElementById("rejected")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [linked]);

  return (
    <>
      <div className="card flow-detail">
        <div className="card-head">
          <div className="card-title section-title"><span className="detail-step">Step 2</span>Quality checks</div>
          <div className="segmented" role="group" aria-label="Month">
            {batches.map((b) => (
              <button key={b.month} className={b.month === batch.month ? "on" : ""} onClick={() => setMonth(b.month)}>
                {b.month}
              </button>
            ))}
          </div>
          <Proves>validation rules and quarantine of bad rows</Proves>
        </div>
        <div className="split">
          <ReasonBars title="Rejected rows" explain="Can't be trusted, so stored aside with the rule and never counted"
                      reasons={batch.rejects} base={batch.rows_rejected} tone="rejected" />
          <ReasonBars title="Warnings on kept trips" explain="The trip happened but one value looks wrong"
                      reasons={batch.warnings} base={batch.rows_accepted} tone="warned" />
        </div>
      </div>
      <RejectedRows key={batch.import_batch_id} batch={batch} open={!!linked} />
    </>
  );
}
