import ApiExample from "../components/ApiExample";
import ZoneMap from "../components/ZoneMap";

// TODO (Kessler): build the Activity Dashboard here: filtered zone map, top
// zones, imbalances, hourly charts and comparisons.
// Backend routes go in api/routers/dashboard.py.
export default function Dashboard() {
  return (
    <section>
      <h1>Activity Dashboard</h1>
      <ApiExample path="/dashboard/example" />
      <ZoneMap />
    </section>
  );
}
