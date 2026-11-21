import { useEffect, useState, type FormEvent } from "react";
import { post, setToken, type User } from "../api";
import AuthLayout, { PasswordInput } from "../components/AuthLayout";

type Invite = { email: string; display_name: string; expires_at: string };

const MIN_LENGTH = 12;   // the rule in api/passwords.py

// Opened from the invitation email: /setup#<token>. The token sits after the
// #, which the browser never sends to a server, and is posted in a request
// body instead, so it stays out of logs. The new user sets their own password
// and is logged in; the link then stops working.
export default function Setup({ onDone }: { onDone: (user: User) => void }) {
  const [token] = useState(() => window.location.hash.slice(1));
  const [invite, setInvite] = useState<Invite | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvalid(true);
      return;
    }
    post<Invite>("/auth/invite", { token }).then(setInvite).catch(() => setInvalid(true));
  }, [token]);

  const longEnough = password.length >= MIN_LENGTH;
  const matches = password.length > 0 && password === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!longEnough || !matches) return;
    setBusy(true);
    setError(null);
    try {
      const { token: session, user } = await post<{ token: string; user: User }>("/auth/setup", { token, password });
      setToken(session);
      onDone(user);
    } catch (err) {
      const message = (err as Error).message;
      if (/expired|already been used/i.test(message)) setInvalid(true);
      else setError(message.replace(/^the password/i, "The password"));
    } finally {
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <AuthLayout>
        <div className="auth-state">
          <span className="auth-state-icon" aria-hidden="true">!</span>
          <h1>This link can't be used</h1>
          <p className="auth-lead">
            It may have expired, been used already or been replaced by a newer invitation, so ask your
            administrator to send you a new one
          </p>
          <button className="primary auth-submit" type="button" onClick={() => window.location.assign("/")}>
            Go to log in
          </button>
        </div>
      </AuthLayout>
    );
  }

  if (!invite) {
    return <AuthLayout><p className="muted">Checking your invitation…</p></AuthLayout>;
  }

  const first = invite.display_name.split(/\s+/)[0];
  const expires = new Date(invite.expires_at).toLocaleString("en-GB",
    { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <AuthLayout>
      <span className="auth-eyebrow">Account setup</span>
      <h1>Welcome, {first}</h1>
      <p className="auth-lead">Choose a password for <strong>{invite.email}</strong> to finish setting up your account</p>
      <form className="auth-form" onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="auth-field">
          <label htmlFor="setup-password">New password</label>
          <PasswordInput id="setup-password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
        </div>
        <div className="auth-field">
          <label htmlFor="setup-confirm">Confirm password</label>
          <PasswordInput id="setup-confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </div>
        <ul className="rules" aria-live="polite">
          <li className={longEnough ? "met" : ""}>At least {MIN_LENGTH} characters</li>
          <li className={matches ? "met" : ""}>Both passwords match</li>
        </ul>
        <button className="primary auth-submit" type="submit" disabled={busy || !longEnough || !matches}>
          {busy ? "Setting up…" : "Set password and log in"}
        </button>
      </form>
      <p className="auth-note">This invitation works once and expires on {expires}</p>
    </AuthLayout>
  );
}
