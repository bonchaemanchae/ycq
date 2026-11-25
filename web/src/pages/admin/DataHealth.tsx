import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, del } from "../../api";
import { n, pct, when, type ImportBatch, type ReconRun } from "./types";

type Orphans = { views: number; orphaned: number; owners: number[] };
type Seals = { versions: number; problems: { allocation_plan_id: number; version_no: number; problem: string }[] };

// Whether PostgreSQL and MongoDB agree for one month; hover for both counts.
function BothDatabases({ run }: { run: ReconRun | undefined }) {
  if (!run) return <span className="muted">Not checked</span>;
  const diffs = (run.zone_hour_mismatches ?? 0) + (run.od_mismatches ?? 0);
  const counts = [
    `Hourly summaries: PostgreSQL ${n(run.pg_hour_rows)}, MongoDB ${n(run.mongo_hour_docs)}`,
    `Pickups: PostgreSQL ${n(run.pg_pickups)}, MongoDB ${n(run.mongo_pickups)}`,
    `Drop-offs: PostgreSQL ${n(run.pg_dropoffs)}, MongoDB ${n(run.mongo_dropoffs)}`,
    `Checked ${when(run.finished_at)}`,
  ].join("\n");
  return run.passed ? (
    <span className="file-badge ok" title={counts}>✓ Match</span>
  ) : (
    <span className="file-badge bad" title={counts}>
      {diffs > 0 ? `${n(diffs)} ${diffs === 1 ? "difference" : "differences"}` : "! Failed"}
    </span>
  );
}

// What an administrator checks day to day: four guarantees at the top, each
// saying how to fix it when it fails, then one row per month (rows read,
// warned and rejected, the file's checksum, and whether the two databases
// agree). A month's rejected count links to its rows on Data pipeline.
export default function DataHealth({ batches, latest }: { batches: ImportBatch[]; latest: Map<string, ReconRun> }) {
  const [orphans, setOrphans] = useState<Orphans | null>(null);
  const [seals, setSeals] = useState<Seals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const loadOrphans = () => api<Orphans>("/admin/orphaned-views").then(setOrphans).catch((e: Error) => setError(e.message));
  useEffect(() => {
    loadOrphans();
    api<Seals>("/admin/plan-seals").then(setSeals).catch((e: Error) => setError(e.message));
  }, []);
  const removeOrphans = async () => {
    try {
      await del("/admin/orphaned-views");
      setConfirming(false);
      await loadOrphans();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const notLoaded = batches.filter((b) => b.status !== "completed").map((b) => b.month);
  const notMatching = batches.filter((b) => latest.get(b.month)?.passed !== true).map((b) => b.month);
  const loaded = batches.length - notLoaded.length;
  const passed = batches.length - notMatching.length;
  const run = (script: string, month: string) => `docker compose run --rm loader python etl/${script} --month ${month}`;
  const viewsOk = orphans ? orphans.orphaned === 0 : null;
  const sealsOk = seals ? seals.problems.length === 0 : null;

  const tiles = [
    {
      ok: loaded === batches.length, title: "Imports complete",
      value: `${loaded} of ${batches.length} months`,
      help: "Each monthly file loaded in full and matched its SHA-256 checksum pinned in the repository. Loading a month again replaces it instead of adding duplicates.",
      fix: notLoaded.length > 0 && {
        text: `Delete ${notLoaded.join(", ")} and load it again, one month at a time, then run docker compose up -d:`,
        commands: [run("delete_month.py", notLoaded[0])],
      },
    },
    {
      ok: passed === batches.length, title: "Both databases agree",
      value: `${passed} of ${batches.length} months`,
      help: "After each load, MongoDB's hourly summaries, pickups and drop-offs are compared with PostgreSQL zone by zone and hour by hour. A month passes only if every number matches.",
      fix: notMatching.length > 0 && {
        text: `PostgreSQL is the source of truth, so rebuild MongoDB for ${notMatching.join(", ")}, one month at a time:`,
        commands: ["build_aggregates.py", "load_mongo.py", "reconcile.py"].map((s) => run(s, notMatching[0])),
      },
    },
    {
      ok: viewsOk, title: "Saved views have owners",
      value: orphans ? (orphans.views === 0 ? "No views yet" : orphans.orphaned === 0 ? `All ${n(orphans.views)}` : `${n(orphans.orphaned)} orphaned`) : "…",
      help: "Saved views live in MongoDB and users in PostgreSQL, so no foreign key can link them. This check does it instead, live, each time the page opens.",
      fix: viewsOk === false && { text: "Nobody can open these views. Delete them with the button below.", commands: [] as string[] },
    },
    {
      ok: sealsOk, title: "Saved plans untouched",
      value: seals ? (sealsOk ? `All ${n(seals.versions)} versions` : `${n(seals.problems.length)} altered`) : "…",
      help: "Each saved plan version is sealed with a SHA-256 hash of its contents and of the seal before it. The hashes are recomputed each time the page opens, so an edited version shows up here.",
      fix: sealsOk === false && {
        text: "A saved version was edited directly in the database. Treat it as a security incident and check who had database access; the planner marks the version as not verified.",
        commands: [] as string[],
      },
    },
  ];

  return (
    <>
      {error && <div className="alert error"><span>{error}</span></div>}
      <div className="check-tiles">
        {tiles.map((t) => (
          <div key={t.title} className={`check-tile ${t.ok === null ? "" : t.ok ? "ok" : "bad"}`} title={t.help}>
            <div className="check-tile-head">
              <span className="check-tile-icon" aria-hidden="true">{t.ok === null ? "…" : t.ok ? "✓" : "!"}</span>
              <span className="check-tile-title">{t.title}</span>
            </div>
            <div className="check-tile-value">{t.value}</div>
            {t.fix && (
              <div className="check-tile-fix">
                <strong>How to fix:</strong> {t.fix.text}
                {t.fix.commands.map((c) => <code key={c}>{c}</code>)}
              </div>
            )}
          </div>
        ))}
      </div>

      {orphans && orphans.orphaned > 0 && (
        <div className="alert error">
          <span>
            {n(orphans.orphaned)} saved {orphans.orphaned === 1 ? "view belongs" : "views belong"} to users that no longer
            exist (user ids {orphans.owners.join(", ")}). Nobody can open them.
          </span>
          {confirming ? (
            <span className="row">
              <button className="danger" onClick={removeOrphans}>Delete them</button>
              <button onClick={() => setConfirming(false)}>Keep</button>
            </span>
          ) : <button onClick={() => setConfirming(true)}>Delete orphaned views</button>}
        </div>
      )}
      {seals && seals.problems.length > 0 && (
        <div className="alert error">
          <span>
            Altered plan versions:{" "}
            {seals.problems.map((p) => `plan ${p.allocation_plan_id} version ${p.version_no} (${p.problem})`).join("; ")}
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-title section-title">
          Data imports
        </div>
        <div className="table-wrap">
          <table className="months">
            <colgroup>
              <col style={{ width: "10%" }} />
              {[1, 2, 3, 4, 5, 6].map((i) => <col key={i} style={{ width: "15%" }} />)}
            </colgroup>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Rows read</th>
                <th className="num" title="Warned trips are real and still counted; a suspicious value is only left out of the averages it would distort.">Warned</th>
                <th className="num" title="Rows that can't be trusted: stored aside with the reason and never counted.">Rejected</th>
                <th>Checksum</th>
                <th>Both databases</th>
                <th>Loaded</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const done = b.status === "completed";
                return (
                  <tr key={b.import_batch_id}>
                    <td><strong>{b.month}</strong></td>
                    <td className="num">{n(b.rows_read)}</td>
                    <td className="num">{n(b.rows_warned)} <span className="muted small">{pct(b.rows_warned, b.rows_read)}</span></td>
                    <td className="num">
                      <Link to={`/evaluation/pipeline?month=${b.month}`} title={`See the ${b.month} rejected rows and their rules`}>
                        {n(b.rows_rejected)}
                      </Link>{" "}
                      <span className="muted small">{pct(b.rows_rejected, b.rows_read)}</span>
                    </td>
                    <td>
                      <span className={`file-badge ${done ? "ok" : "bad"}`}
                            title={`${b.source_file}\nSHA-256 ${b.checksum_prefix}…, matched the pinned value`}>
                        {done ? "✓ Verified" : `! ${b.status}`}
                      </span>
                    </td>
                    <td><BothDatabases run={latest.get(b.month)} /></td>
                    <td className="small nowrap">{when(b.finished_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
