import ApiExample from "../components/ApiExample";

// TODO (Sean): build the Administration page here: imports, rejections,
// reconciliation and benchmark results.
// Backend routes go in api/routers/admin.py.
export default function Admin() {
  return (
    <section>
      <h1>Administration</h1>
      <ApiExample path="/admin/example" />
    </section>
  );
}
