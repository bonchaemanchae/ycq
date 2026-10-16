import { count, miles, minutes, money, percent, type Slice } from "./types";

// The top 10 destinations of one slice, best first.
export default function DestinationTable({ slice }: { slice: Slice }) {
  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Destination</th>
              <th>Borough</th>
              <th className="num">Trips</th>
              <th className="num">Share</th>
              <th className="num">Avg fare</th>
              <th className="num">Avg distance</th>
              <th className="num">Avg duration</th>
            </tr>
          </thead>
          <tbody>
            {slice.destinations.map((d) => (
              <tr key={d.zoneId}>
                <td className="muted">{d.rank}</td>
                <td>
                  {d.zoneName}
                  {d.zoneId === slice.originZoneId && <span className="tag" title="Trips that start and end in this zone">within zone</span>}
                </td>
                <td>{d.borough}</td>
                <td className="num">{count(d.trips)}</td>
                <td className="num">{percent(d.share)}</td>
                <td className={`num ${d.averageFare === null ? "muted" : ""}`}>{money(d.averageFare)}</td>
                <td className={`num ${d.averageDistance === null ? "muted" : ""}`}>{miles(d.averageDistance)}</td>
                <td className={`num ${d.averageDurationSec === null ? "muted" : ""}`}>{minutes(d.averageDurationSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small flows-note">
        n/a = no metered trips to average (Flex Fare and unusually priced trips are left out of fare averages).
        Share is out of all {count(slice.totalTrips)} trips from this zone in this slice.
        Within-zone trips have no line on the map.
      </p>
    </div>
  );
}
