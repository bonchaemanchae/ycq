import { useEffect, useState } from "react";
import { api, type User } from "../../api";

type Account = {
  user_id: number; email: string; display_name: string;
  is_active: boolean; roles: string[]; plans: number;
};
type Deleted = { deleted_views: number; deleted_plans: number };

// Accounts, and deleting one together with its saved plans (PostgreSQL) and
// saved views (MongoDB). Routes in api/routers/users.py.
export default function Users() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [me, setMe] = useState<User | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = () => api<Account[]>("/admin/users").then(setAccounts);

  useEffect(() => {
    Promise.all([load(), api<User>("/auth/me").then(setMe)])
      .catch((e: Error) => setMessage({ kind: "error", text: e.message }));
  }, []);

  const remove = async (a: Account) => {
    if (!window.confirm(`Delete ${a.email}, their ${a.plans} saved plan(s) and all their saved views? ` +
                        "This can't be undone.")) return;
    setBusy(a.user_id);
    setMessage(null);
    try {
      const r = await api<Deleted>(`/admin/users/${a.user_id}`, { method: "DELETE" });
      setMessage({ kind: "ok", text: `Deleted ${a.email}: ${r.deleted_plans} plan(s), ${r.deleted_views} saved view(s).` });
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(null);
      await load().catch(() => undefined);
    }
  };

  return (
    <div className="card">
      <div className="card-title">Users</div>
      <p className="muted small">
        Deleting a user also deletes their saved plans and saved views. If it stops part way, the user is
        left inactive (unable to log in) and Delete can simply be pressed again.
      </p>
      {message && <div className={`alert ${message.kind}`}>{message.text}</div>}
      {accounts && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Email</th><th>Name</th><th>Roles</th><th>Status</th><th className="num">Plans</th><th /></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.user_id}>
                  <td>{a.email}</td>
                  <td>{a.display_name}</td>
                  <td>{a.roles.join(", ") || "none"}</td>
                  <td>{a.is_active ? "active" : <span className="tag warn">inactive</span>}</td>
                  <td className="num">{a.plans}</td>
                  <td>
                    {a.user_id === me?.user_id
                      ? <span className="muted small">you</span>
                      : <button className="danger" disabled={busy !== null} onClick={() => remove(a)}>
                          {busy === a.user_id ? "Deleting…" : "Delete"}
                        </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
