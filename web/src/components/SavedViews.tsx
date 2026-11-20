import { useEffect, useRef, useState } from "react";
import { api, ApiError, del, patch, post } from "../api";
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
  page: SavedView["page"];                // the page new views are saved for
  // pages whose views are listed; the dashboard also lists views saved on the
  // old Flow Explorer page, which now open its Flow Explorer panel
  pages?: SavedView["page"][];
  current: ViewState | null;              // what "Save" stores; null while the page loads
  // what "Save changes" stores for a view of another page (null: can't update it now)
  currentFor?: (view: SavedView) => ViewState | null;
  describe: (filters: Record<string, unknown>, page: SavedView["page"]) => string;
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

// Saved views: the user's own named views of the page, kept in MongoDB
// (saved_analysis_views). Create, open, update, rename and delete, from a
// compact "Views" menu beside the filters.
export default function SavedViews({ page, pages = [page], current, currentFor, describe, onOpen }: Props) {
  const [views, setViews] = useState<SavedView[] | null>(null);
  const [shown, setShown] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  // the menu closes on a click anywhere else
  useEffect(() => {
    if (!shown) return;
    const close = (e: MouseEvent) => {
      if (menu.current && !menu.current.contains(e.target as Node)) setShown(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [shown]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const listed = pages.join(",");
  const load = () => api<SavedView[]>(pages.length === 1 ? `/views?page=${pages[0]}` : "/views")
    .then((all) => setViews(all.filter((v) => pages.includes(v.page))));
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [listed]);

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
      setShown(true);
    });
  };
  const open = (v: SavedView) => {
    setOpenId(v._id);
    setConfirmDelete(null);
    setShown(false);
    onOpen(v);
  };
  // A change says which state of the view it was made from. If the view was
  // changed in another tab since, the API refuses (409) rather than overwrite
  // that change, and the list is loaded again so it shows what is stored.
  const change = async (v: SavedView, body: object) => {
    try {
      replace(await patch<SavedView>(`/views/${v._id}`, { ...body, expectedUpdatedAt: v.updatedAt }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await load();
      throw e;
    }
  };
  const stateOf = (v: SavedView) => (v.page === page ? current : currentFor?.(v) ?? null);
  const update = (v: SavedView) => run(() => change(v, stateOf(v)!));
  const rename = (v: SavedView) => run(async () => {
    await change(v, { name: renameTo });
    setRenaming(null);
  });
  const remove = (v: SavedView) => run(async () => {
    await del(`/views/${v._id}`);
    setViews((list) => (list ?? []).filter((x) => x._id !== v._id));
    if (openId === v._id) setOpenId(null);
    setConfirmDelete(null);
  });

  const changed = (v: SavedView) => {
    const now = stateOf(v);
    return !!now && !(same(now.filters, v.filters) && same(now.widgets, v.widgets ?? {}));
  };

  return (
    <div className="saved-views" ref={menu}>
      <button className={`views-button ${shown ? "on" : ""}`} onClick={() => setShown(!shown)}
              aria-expanded={shown} title="Save what you are looking at, or open a saved view">
        Views{views?.length ? ` (${views.length})` : ""} ▾
      </button>
      {shown && (
      <div className="views-menu" role="dialog" aria-label="Saved views">
        <form className="saved-form" onSubmit={save}>
          <input autoFocus placeholder="Name this view, e.g. JFK weekday evenings" value={name} maxLength={100}
                 onChange={(e) => setName(e.target.value)} disabled={!current} />
          <button className="primary" disabled={busy || !current || !name.trim()}>Save</button>
        </form>
        <p className="muted small views-note">Yours only, kept in MongoDB.</p>
      {error && <div className="alert error"><span>{error}</span></div>}

      {views?.length === 0 && <p className="muted small saved-empty">No saved views yet.</p>}
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
                    <span className="muted small">{describe(v.filters, v.page)}</span>
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
      )}
    </div>
  );
}
