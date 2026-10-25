import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dayLabel, hourLabel, type Series } from "./types";

type Props = {
  series: Series;
  bucket: "hour" | "day";
  onBucket: (b: "hour" | "day") => void;
  hourlyAllowed: boolean;     // hourly is only offered for short date ranges
};

// Pickups and drop-offs over time, with a moving average of pickups.
export default function ActivityChart({ series, bucket, onBucket, hourlyAllowed }: Props) {
  const data = series.points.map((p) => ({
    ...p,
    label: series.bucket === "hour" ? `${dayLabel(p.localDate)} ${hourLabel(p.localHour ?? 0)}` : dayLabel(p.localDate),
  }));
  const span = series.bucket === "hour" ? `${series.window} hours` : `${series.window} days`;

  return (
    <div>
      <div className="dash-chart-head">
        <span className="muted small">Moving average over the last {span} shown.</span>
        <div className="dash-pills">
          <button className={bucket === "day" ? "active" : ""} onClick={() => onBucket("day")}>Per day</button>
          <button className={bucket === "hour" ? "active" : ""} disabled={!hourlyAllowed}
                  title={hourlyAllowed ? "" : "Pick 31 days or fewer to see hours"}
                  onClick={() => onBucket("hour")}>Per hour</button>
        </div>
      </div>
      {data.length === 0 ? <p className="muted">No hours match the filters.</p> : (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#e3e1da" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
            <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v: number) => v.toLocaleString()} />
            <Tooltip formatter={(v: number) => v.toLocaleString()} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="pickups" name="Pickups" stroke="#d6aa00" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="dropoffs" name="Drop-offs" stroke="#9a988f" dot={false} strokeWidth={1} />
            <Line type="monotone" dataKey="movingAveragePickups" name="Pickups, moving average"
                  stroke="#1c1c1a" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
