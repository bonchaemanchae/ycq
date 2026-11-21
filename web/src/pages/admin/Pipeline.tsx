import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PipelineDiagram from "./PipelineDiagram";
import Proves from "./Proves";
import ReasonBars from "./ReasonBars";
import RejectedRows from "./RejectedRows";
import type { ImportBatch, ReconRun } from "./types";

// Evidence for the loading design: the five steps with live numbers, how the
// validation rules split one month's rows, and the rejected rows themselves.
// Data health links here with ?month=, which opens that month's rows.
export default function Pipeline({ batches, latest }: { batches: ImportBatch[]; latest: Map<string, ReconRun> }) {
  const [params] = useSearchParams();
  const linked = batches.some((b) => b.month === params.get("month")) ? params.get("month") : null;
  const [month, setMonth] = useState(linked ?? batches[batches.length - 1].month);
  useEffect(() => {
    if (linked) document.getElementById("rejected")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [linked]);
  const batch = batches.find((b) => b.month === month) ?? batches[batches.length - 1];

  return (
    <>
      <PipelineDiagram batches={batches} latest={latest} />
      <div className="card">
        <div className="card-head">
          <div className="card-title">Validation rules</div>
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
          <ReasonBars
            title="Rejected rows"
            explain="Can't be trusted, so stored aside with the reason and never counted."
            reasons={batch.rejects} base={batch.rows_rejected} tone="rejected" />
          <ReasonBars
            title="Warnings on kept trips"
            explain="The trip happened but one value looks wrong; share of all kept trips."
            reasons={batch.warnings} base={batch.rows_accepted} tone="warned" />
        </div>
      </div>
      <RejectedRows key={batch.import_batch_id} batch={batch} open={!!linked} />
    </>
  );
}
