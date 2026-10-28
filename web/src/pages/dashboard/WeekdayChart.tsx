import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { WEEKDAYS, count, hourLabel, type Weekdays } from "./types";

// Average pickups per day for each weekday, and a weekday x hour grid that
// shows when in the week the selected zones are busiest.
export default function WeekdayChart({ data }: { data: Weekdays }) {
  const bars = data.weekdays.map((w) => ({ ...w, label: WEEKDAYS[w.isoDayOfWeek - 1] }));
  const max = Math.max(1, ...data.grid.map((g) => g.averagePickups));
  const cell = new Map(data.grid.map((g) => [`${g.isoDayOfWeek}:${g.hour}`, g.averagePickups]));
  const days = data.weekdays.map((w) => w.isoDayOfWeek);
  const hours = [...new Set(data.grid.map((g) => g.hour))].sort((a, b) => a - b);

  if (bars.length === 0) return <p className="muted">No hours match the filters.</p>;
  return (
    <div className="dash-weekday">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#e3e1da" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v: number) => v.toLocaleString()} />
          <Tooltip formatter={(v: number) => v.toLocaleString()}
                   labelFormatter={(l: string) => `${l} (average per day)`} />
          <Bar dataKey="averagePickups" name="Pickups" fill="#f7c600" />
          <Bar dataKey="averageDropoffs" name="Drop-offs" fill="#cfccc3" />
        </BarChart>
      </ResponsiveContainer>

      <div className="dash-subtitle">Average pickups by weekday and hour</div>
      <div className="table-wrap">
        <table className="dash-grid">
          <thead>
            <tr>
              <th />
              {hours.map((h) => <th key={h} className="num">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d}>
                <th>{WEEKDAYS[d - 1]}</th>
                {hours.map((h) => {
                  const v = cell.get(`${d}:${h}`);
                  return (
                    <td key={h} title={v === undefined ? "" : `${WEEKDAYS[d - 1]} ${hourLabel(h)}: ${count(v)} pickups a day`}
                        style={{ background: v === undefined ? undefined : `rgba(230, 160, 0, ${0.06 + 0.94 * (v / max)})` }} />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small dash-note">Darker = more pickups on an average day. Hover a cell for the number.</p>
    </div>
  );
}
