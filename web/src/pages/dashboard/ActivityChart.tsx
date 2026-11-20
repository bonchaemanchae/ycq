import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DAYS } from "../planner/types";
import { dayLabel, hourLabel, type Point, type Series } from "./types";

type Props = {
  series: Series;
  bucket: "hour" | "day";
  onBucket: (b: "hour" | "day") => void;
  hourlyAllowed: boolean;     // hourly is only offered for short date ranges
};

const COLOURS = { pickups: "#d6aa00", dropoffs: "#9a988f", average: "#1c1c1a", unusual: "#c2382b" };
const n = (v: number | null | undefined) => (v === null || v === undefined ? "–" : Math.round(v).toLocaleString());

// Pickups and drop-offs over time, with a moving average of pickups. The
// unusual days are red dots; hovering one says how far it was from a normal
// day of the same weekday. The legend names everything, so no text is needed
// above the chart.
export default function ActivityChart({ series, bucket, onBucket, hourlyAllowed }: Props) {
  const data = series.points.map((p) => ({
    ...p,
    label: series.bucket === "hour" ? `${dayLabel(p.localDate)} ${hourLabel(p.localHour ?? 0)}` : dayLabel(p.localDate),
  }));
  const average = series.bucket === "hour" ? `${series.window}-hour average` : `${series.window}-day average`;
  const unusual = new Set(series.bucket === "day" ? series.unusualDays : []);

  return (
    <div>
      <div className="dash-chart-head">
        <div className="dash-pills">
          <button className={bucket === "day" ? "active" : ""} onClick={() => onBucket("day")}>Per day</button>
          <button className={bucket === "hour" ? "active" : ""} disabled={!hourlyAllowed}
                  title={hourlyAllowed ? "" : "Choose 31 days or fewer in Filters to see hours"}
                  onClick={() => onBucket("hour")}>Per hour</button>
        </div>
      </div>
      {data.length === 0 ? <p className="muted">No hours match the filters.</p> : (
        <>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#e3e1da" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 13 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 13 }} width={56} tickFormatter={(v: number) => v.toLocaleString()} />
              <Tooltip content={<ChartTip average={average} unusual={unusual} />} />
              <Line type="monotone" dataKey="pickups" name="Pickups" stroke={COLOURS.pickups} dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="dropoffs" name="Drop-offs" stroke={COLOURS.dropoffs} dot={false} strokeWidth={1} />
              <Line type="monotone" dataKey="movingAveragePickups" name={average}
                    stroke={COLOURS.average} dot={false} strokeWidth={2} />
              {data.filter((p) => unusual.has(p.localDate)).map((p) => (
                <ReferenceDot key={p.localDate} x={p.label} y={p.pickups} r={6} fill={COLOURS.unusual} stroke="#fff" strokeWidth={2} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <div className="chart-legend">
            <span><span className="legend-line" style={{ background: COLOURS.pickups }} /> Pickups</span>
            <span><span className="legend-line thin" style={{ background: COLOURS.dropoffs }} /> Drop-offs</span>
            <span><span className="legend-line thick" style={{ background: COLOURS.average }} /> {average}</span>
            {unusual.size > 0 && <span><span className="legend-dot" style={{ background: COLOURS.unusual }} /> Unusual day</span>}
          </div>
        </>
      )}
    </div>
  );
}

// The box shown on hover: whole numbers, and for an unusual day how far it was
// from a normal day of the same day of the week.
function ChartTip({ active, payload, average, unusual }: {
  active?: boolean; payload?: { payload: Point & { label: string } }[]; average: string; unusual: Set<string>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const odd = unusual.has(p.localDate) && p.typicalPickups;
  const weekday = p.isoDayOfWeek ? DAYS[p.isoDayOfWeek - 1] : "day";
  const change = p.change === null || p.change === undefined ? null : Math.round(p.change * 100);
  return (
    <div className="chart-tip">
      <div className="chart-tip-head">
        {p.label}{odd && <span className="chart-tip-badge">Unusual day</span>}
      </div>
      <div style={{ color: "#8a6d00" }}>Pickups: {n(p.pickups)}</div>
      {odd && (
        <div>
          Normal {weekday}: {n(p.typicalPickups)}{" "}
          {change !== null && <strong className="chart-tip-odd">({change > 0 ? "+" : "−"}{Math.abs(change)}%)</strong>}
        </div>
      )}
      <div>{average[0].toUpperCase() + average.slice(1)}: {n(p.movingAveragePickups)}</div>
      <div className="muted">Drop-offs: {n(p.dropoffs)}</div>
    </div>
  );
}
