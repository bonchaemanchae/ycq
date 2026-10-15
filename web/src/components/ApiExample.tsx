import { useEffect, useState } from "react";
import { api } from "../api";

// Shows the raw JSON from one backend route. Placeholder for the stub pages:
// it proves the page -> /api -> FastAPI -> database path works. Delete it from
// your page once you show real data.
export default function ApiExample({ path }: { path: string }) {
  const [result, setResult] = useState("loading...");
  useEffect(() => {
    api<unknown>(path)
      .then((r) => setResult(JSON.stringify(r, null, 2)))
      .catch((e: Error) => setResult(`Error: ${e.message}`));
  }, [path]);

  return (
    <div>
      <p>Response from <code>GET /api{path}</code>:</p>
      <pre className="example">{result}</pre>
    </div>
  );
}
