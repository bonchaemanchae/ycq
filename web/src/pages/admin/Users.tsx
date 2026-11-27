import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, patch, post, type User } from "../../api";

type Status = "active" | "invited" | "disabled";
type Account = {
  user_id: number; email: string; display_name: string; is_active: boolean; created_at: string;
  status: Status; roles: string[]; plans: number; invite_expires_at: string | null;
};
type Invite = { link: string; expires_at: string; emailed: boolean; inbox_url: string | null };
type Invited = Account & { invite: Invite };
type Role = "analyst" | "admin";

const STATUS_LABEL: Record<Status, string> = { active: "Active", invited: "Invited", disabled: "Disabled" };
const FILTERS: ("all" | Status)[] = ["all", "active", "invited", "disabled"];

const day = (t: string) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const moment = (t: string) => new Date(t).toLocaleString("en-GB",
  { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

// User management (routes in api/routers/users.py). Admins invite people by
// email and choose their role; each person sets their own password from the
// link in the invitation. Accounts are disabled rather than deleted, so their
// saved plans and views stay.
export default function Users() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Status>("all");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("analyst");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ account: Invited; again: boolean } | null>(null);

  const [confirming, setConfirming] = useState<Account | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>();
  const say = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };

  const load = () => api<Account[]>("/admin/users").then(setAccounts);
  useEffect(() => {
    Promise.all([load(), api<User>("/auth/me").then(setMe)]).catch((e: Error) => setError(e.message));
    return () => window.clearTimeout(toastTimer.current);
  }, []);

  const sendInvite = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setFormError(null);
    try {
      const account = await post<Invited>("/admin/users", { email, display_name: name, role });
      setSent({ account, again: false });
      setName("");
      setEmail("");
      setRole("analyst");
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const resend = async (a: Account) => {
    setBusy(a.user_id);
    try {
      const account = await post<Invited>(`/admin/users/${a.user_id}/invite`, {});
      setSent({ account, again: true });
      window.scrollTo({ top: 0, behavior: "smooth" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const setActive = async (a: Account, active: boolean) => {
    setBusy(a.user_id);
    setError(null);
    try {
      await patch<Account>(`/admin/users/${a.user_id}`, { is_active: active });
      say(active ? `${a.display_name} can log in again` : `${a.display_name} is disabled`);
      setConfirming(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
      setConfirming(null);
    } finally {
      setBusy(null);
    }
  };

  const count = (f: "all" | Status) => (accounts ?? []).filter((a) => f === "all" || a.status === f).length;
  const shown = (accounts ?? []).filter((a) => filter === "all" || a.status === filter);

  return (
    <>
      <div className="card">
        <div className="card-title section-title">Invite a user</div>
        <form className="invite-form" onSubmit={sendInvite}>
          <div className="form-field">
            <label htmlFor="invite-name">Full name</label>
            <input id="invite-name" required maxLength={100} placeholder="Jordan Lee" value={name}
                   onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="invite-email">Work email</label>
            <input id="invite-email" type="email" required maxLength={254} placeholder="jordan.lee@ycq.local"
                   value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="form-field">
            <span id="invite-role">Role</span>
            <div className="segmented role-pick" role="radiogroup" aria-labelledby="invite-role">
              {(["analyst", "admin"] as Role[]).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={role === r}
                        className={role === r ? "on" : ""} onClick={() => setRole(r)}
                        title={r === "admin" ? "Everything a fleet manager can do, plus Administration"
                                             : "Dashboard and Allocation Planner"}>
                  {r === "admin" ? "Admin" : "Fleet manager"}
                </button>
              ))}
            </div>
          </div>
          <button className="primary invite-send" disabled={sending}>{sending ? "Sending…" : "Send invitation"}</button>
        </form>
        {formError && <div className="alert error">{formError}</div>}
        {sent && <InviteSent {...sent} onClose={() => setSent(null)} />}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title section-title">Accounts</div>
          <div className="segmented account-filter" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : STATUS_LABEL[f]} <span className="count">{count(f)}</span>
              </button>
            ))}
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
        {!accounts ? <p className="muted">Loading…</p> : shown.length === 0 ? (
          <p className="muted empty">No {filter} accounts</p>
        ) : (
          <div className="table-wrap">
            <table className="accounts">
              <colgroup>
                <col style={{ width: "28%" }} />
                {[1, 2, 3, 4].map((i) => <col key={i} style={{ width: "14%" }} />)}
                <col style={{ width: "16%" }} />
              </colgroup>
              <thead>
                <tr><th>User</th><th>Role</th><th>Status</th><th>Plans</th><th>Added</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const self = a.user_id === me?.user_id;
                  const expired = a.status === "invited" && (!a.invite_expires_at || new Date(a.invite_expires_at) < new Date());
                  return (
                    <tr key={a.user_id} className={[a.status === "disabled" && "is-disabled", self && "is-me"].filter(Boolean).join(" ")}>
                      <td>
                        <div className="user-cell">
                          <span className={`user-avatar ${a.status}`} aria-hidden="true">{initials(a.display_name)}</span>
                          <div className="user-text">
                            <div className="user-name">{a.display_name}{self && <span className="you">You</span>}</div>
                            <div className="user-email">{a.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {a.roles.map((r) => (
                          <span key={r} className={`role-pill ${r}`}>
                            {r === "admin" && <ShieldIcon />}{r === "admin" ? "Admin" : "Fleet manager"}
                          </span>
                        ))}
                      </td>
                      <td>
                        <span className={`state-pill ${expired ? "expired" : a.status}`}>
                          <i aria-hidden="true" />{expired ? "Invite expired" : STATUS_LABEL[a.status]}
                        </span>
                        {a.status === "invited" && !expired && a.invite_expires_at && (
                          <div className="state-note">Link expires {moment(a.invite_expires_at)}</div>
                        )}
                      </td>
                      <td>{a.plans}</td>
                      <td className="muted">{day(a.created_at)}</td>
                      <td className="row-actions">
                        {self ? null : (
                          <>
                            {a.status === "invited" && (
                              <button className="ghost" disabled={busy !== null} onClick={() => resend(a)}>
                                {busy === a.user_id ? "Sending…" : expired ? "Send new link" : "Resend"}
                              </button>
                            )}
                            {a.status === "disabled" ? (
                              <button className="ghost" disabled={busy !== null} onClick={() => setActive(a, true)}>
                                {busy === a.user_id ? "Enabling…" : "Enable"}
                              </button>
                            ) : (
                              <button className="ghost ghost-danger" disabled={busy !== null} onClick={() => setConfirming(a)}>
                                Disable
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmDisable account={confirming} busy={busy === confirming.user_id}
                        onConfirm={() => setActive(confirming, false)} onClose={() => setConfirming(null)} />
      )}
      {toast && (
        <div className="toast" role="status"><span className="toast-tick" aria-hidden="true">✓</span>{toast}</div>
      )}
    </>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M8 1.5l5 2v3.6c0 3.2-2.1 5.9-5 6.9-2.9-1-5-3.7-5-6.9V3.5l5-2z" fill="currentColor" />
    </svg>
  );
}

// After sending: the link, to copy in case the email doesn't arrive.
function InviteSent({ account, again, onClose }: { account: Invited; again: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const { invite } = account;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked: the link is selectable in the box
    }
  };

  return (
    <div className={`invite-sent ${invite.emailed ? "" : "not-emailed"}`} role="status">
      <div className="invite-sent-head">
        <span className="invite-sent-icon" aria-hidden="true">{invite.emailed ? "✓" : "!"}</span>
        <div className="invite-sent-text">
          <strong>
            {invite.emailed
              ? `${again ? "New invitation" : "Invitation"} sent to ${account.display_name}`
              : `${account.display_name} was added, but the email couldn't be sent`}
          </strong>
          <span>
            {invite.emailed
              ? <>Emailed to {account.email}, the link works once and expires {moment(invite.expires_at)}</>
              : <>Copy the link below and send it to {account.email} yourself before it expires {moment(invite.expires_at)}</>}
            {again && ", and the previous link no longer works"}
          </span>
        </div>
        <button className="link invite-sent-close" onClick={onClose} aria-label="Dismiss">✕</button>
      </div>
      <div className="invite-link">
        <input readOnly value={invite.link} aria-label="Invitation link" onFocus={(e) => e.target.select()} />
        <button type="button" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        {invite.emailed && invite.inbox_url && (
          <a className="inbox-link" href={invite.inbox_url} target="_blank" rel="noreferrer">Open test inbox ↗</a>
        )}
      </div>
    </div>
  );
}

function ConfirmDisable({ account, busy, onConfirm, onClose }: {
  account: Account; busy: boolean; onConfirm: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const kept = account.plans > 0
    ? `their ${account.plans} saved ${account.plans === 1 ? "plan" : "plans"} and saved views are kept`
    : "anything they saved is kept";

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog card confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="disable-title">
        <div className="card-title section-title" id="disable-title">Disable {account.display_name}?</div>
        <p>
          {account.status === "invited"
            ? <>Their invitation link stops working, and you can enable the account later and send a new link</>
            : <>They'll be logged out at once and can't log in until you enable the account again, and {kept}</>}
        </p>
        <div className="dialog-actions confirm-actions">
          <button onClick={onClose} autoFocus>Cancel</button>
          <button className="danger" onClick={onConfirm} disabled={busy}>{busy ? "Disabling…" : "Disable account"}</button>
        </div>
      </div>
    </div>
  );
}
