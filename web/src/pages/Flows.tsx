import ApiExample from "../components/ApiExample";
import ZoneMap from "../components/ZoneMap";

// TODO (Caleb): build the Flow Explorer here: top ten destinations from a zone
// by month, day type and time of day, drawn as lines on the map.
// Backend routes go in api/routers/flows.py.
export default function Flows() {
  return (
    <section>
      <h1>Flow Explorer</h1>
      <ApiExample path="/flows/example" />
      <ZoneMap />
    </section>
  );
}
