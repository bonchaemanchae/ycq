import { SOURCE_LABEL, type Answered } from "./types";

// Where an answer came from and how long MongoDB took, under each chart.
export default function Source({ answer }: { answer: Answered | null }) {
  if (!answer) return null;
  const ms = answer.queryMs < 10 ? answer.queryMs.toFixed(1) : Math.round(answer.queryMs);
  return (
    <p className="muted small dash-source" title={`MongoDB collection ${answer.source}`}>
      Read from the {SOURCE_LABEL[answer.source] ?? answer.source} in {ms} ms
    </p>
  );
}
