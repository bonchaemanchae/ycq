import { useState, type FormEvent } from "react";
import { post, setToken, type User } from "../api";
import AuthLayout, { PasswordInput } from "../components/AuthLayout";

// Shown instead of the app until someone logs in. There is no sign-up: an
// administrator invites each person, who sets their password from the link
// in the invitation (pages/Setup.tsx).
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
      const message = (err as Error).message;
      setError(/wrong email or password/i.test(message) ? "That email and password don't match an account"
        : /disabled/i.test(message) ? "This account has been disabled, contact your administrator to turn it back on"
        : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout signUpHint>
      <h1>Log in</h1>
      <p className="auth-lead">Welcome back, log in with your work email</p>
      <form className="auth-form" onSubmit={submit}>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="auth-field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" autoComplete="username" required autoFocus value={email}
                 onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="auth-field">
          <label htmlFor="login-password">Password</label>
          <PasswordInput id="login-password" value={password} onChange={setPassword} autoComplete="current-password" />
        </div>
        <button className="primary auth-submit" type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
      </form>
    </AuthLayout>
  );
}
