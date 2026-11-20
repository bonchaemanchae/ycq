import { useEffect, useState } from "react";
import { api } from "../../api";

// `path` is the path `data` was fetched from: until a new answer arrives the
// previous one stays shown, so code that must not act on an older answer
// compares it with the path it asked for.
export type Loaded<T> = { data: T | null; error: string; loading: boolean; path?: string };

// GET a path and keep the latest answer. When the path changes before the
// previous request finishes, that request is aborted and its answer ignored,
// so quick changes to the controls can never show an older result.
// A null path fetches nothing.
export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: "", loading: path !== null });

  useEffect(() => {
    if (path === null) return;
    const request = new AbortController();
    setState((s) => ({ ...s, error: "", loading: true }));
    api<T>(path, { signal: request.signal })
      .then((data) => {
        if (!request.signal.aborted) setState({ data, error: "", loading: false, path });
      })
      .catch((e) => {
        if (!request.signal.aborted) setState({ data: null, error: (e as Error).message, loading: false, path });
      });
    return () => request.abort();
  }, [path]);

  return state;
}
