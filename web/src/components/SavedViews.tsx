import { useEffect, useState } from "react";
import { api, del, patch, post } from "../api";
import "./saved-views.css";

// What GET /views returns (api/saved_views.py). Filters and widgets are the
// page's own: each page turns them back into its state in onOpen.
export type SavedView = {
  _id: string;
  name: string;
  page: "dashboard" | "flows";
  filters: Record<string, unknown>;
  widgets?: Record<string, unknown>;
  updatedAt: string;
};

export type ViewState = { filters: Record<string, unknown>; widgets: Record<string, unknown> };

type Props = {
  page: SavedView["page"];
  current: ViewState | null;              // what "Save" stores; null while the page loads
  describe: (filters: Record<string, unknown>) => string;
  onOpen: (view: SavedView) => void;
};

// Order-independent comparison, so a view reads as unchanged however its
// keys were ordered when stored.
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length &&
      ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
};

// Saved views: the user's own filter sets for one page, kept in MongoDB
// (saved_analysis_views). Create, open, update, rename and delete.
export default function SavedViews({ page, current, describe, onOpen }: Props) {
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SavedView[]>(`/views?page=${page}`).then(setViews).catch((e: Error) => setError(e.message));
  }, [page]);

  // Every change goes through here: one at a time, errors shown above the list.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const replace = (v: SavedView) =>
    setViews((list) => [v, ...(list ?? []).filter((x) => x._id !== v._id)]);   // newest first

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !name.trim()) return;
    run(async () => {
      const v = await post<SavedView>("/views", { name: name.trim(), page, ...current });
      replace(v);
      setOpenId(v._id);
      setName("");
    });
  };
  const open = (v: SavedView) => {
    setOpenId(v._id);
    setConfirmDelete(null);
    onOpen(v);
  };
  const update = (v: SavedView) => run(async () => replace(await patch<SavedView>(`/views/${v._id}`, current)));
  const rename = (v: SavedView) => run(async () => {
    replace(await patch<SavedView>(`/views/${v._id}`, { name: renameTo }));
    setRenaming(null);
  });
  const remove = (v: SavedView) => run(async () => {
    await del(`/views/${v._id}`);
    setViews((list) => (list ?? []).filter((x) => x._id !== v._id));
    if (openId === v._id) setOpenId(null);
    setConfirmDelete(null);
  });

  const changed = (v: SavedView) =>
    !!current && !(same(current.filters, v.filters) && same(current.widgets, v.widgets ?? {}));

  return (
    <div className="card saved-views">
      <div className="card-head">
        <div className="card-title">
          Saved views <span className="muted small">yours only, kept in MongoDB</span>
        </div>
      </div>

      <form className="saved-form" onSubmit={save}>
        <input placeholder="Name the current view, e.g. Weekday mornings" value={name} maxLength={100}
               onChange={(e) => setName(e.target.value)} disabled={!current} />
        <button className="primary" disabled={busy || !current || !name.trim()}>Save view</button>
      </form>
      {error && <div className="alert error"><span>{error}</span></div>}

      {views === null && !error && <p className="muted small">Loading…</p>}
      {views?.length === 0 && <p className="muted small">No saved views yet. Set the page up, name it and save.</p>}
      {!!views?.length && (
        <ul className="saved-list">
          {views.map((v) => {
            const isOpen = v._id === openId;
            return (
              <li key={v._id} className={isOpen ? "open" : ""}>
                {renaming === v._id ? (
                  <form className="saved-form" onSubmit={(e) => { e.preventDefault(); rename(v); }}>
                    <input autoFocus value={renameTo} maxLength={100} onChange={(e) => setRenameTo(e.target.value)} />
                    <button className="primary" disabled={busy || !renameTo.trim()}>Rename</button>
                    <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                  </form>
                ) : (
                  <button className="saved-item" onClick={() => open(v)} title="Open this view">
                    <span className="saved-name">
                      {v.name}
                      {isOpen && <span className="tag">{changed(v) ? "open, changed" : "open"}</span>}
                    </span>
                    <span className="muted small">{describe(v.filters)}</span>
                  </button>
                )}

                {renaming !== v._id && (
                  <div className="saved-actions">
                    {confirmDelete === v._id ? (
                      <>
                        <span className="small">Delete “{v.name}”?</span>
                        <button className="danger" disabled={busy} onClick={() => remove(v)}>Delete</button>
                        <button onClick={() => setConfirmDelete(null)}>Keep</button>
                      </>
                    ) : (
                      <>
                        {isOpen && changed(v) && (
                          <button className="link" disabled={busy} onClick={() => update(v)}
                                  title="Store the page as it is now in this view">
                            Save changes
                          </button>
                        )}
                        <button className="link" onClick={() => { setRenaming(v._id); setRenameTo(v.name); }}>
                          Rename
                        </button>
                        <button className="link danger-text" onClick={() => setConfirmDelete(v._id)}>Delete</button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
