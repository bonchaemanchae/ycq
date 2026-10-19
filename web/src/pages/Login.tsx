import { useState, type FormEvent } from "react";
import { post, setToken, type User } from "../api";

// Shown instead of the app until someone logs in. Accounts are created by
// the loader from .env (scripts/seed_users.py); there is no sign-up.
export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await post<{ token: string; user: User }>("/auth/login", { email, password });
      setToken(token);
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card login" onSubmit={submit}>
      <h1>Log in</h1>
      <p className="muted">Yellow Cab Query is for fleet analysts and administrators.</p>
      {error && <div className="alert error">{error}</div>}
      <label>
        <span>Email</span>
        <input type="email" autoComplete="username" required value={email}
               onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        <span>Password</span>
        <input type="password" autoComplete="current-password" required value={password}
               onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button className="primary" type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
    </form>
  );
}
