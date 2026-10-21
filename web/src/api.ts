// Every call to the backend goes through here. "/api" is forwarded to
// FastAPI by Vite (npm run dev) or nginx (Docker).
//
// The login token is kept in sessionStorage: it is sent with every call and
// forgotten when the tab is closed. A 401 means it expired or the account was
// removed, so the token is dropped and App shows the login page again.

const TOKEN_KEY = "ycq.token";
export const LOGOUT_EVENT = "ycq-logout";

export type User = { user_id: number; email: string; display_name: string; roles: string[] };

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (token: string) => sessionStorage.setItem(TOKEN_KEY, token);

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event(LOGOUT_EVENT));
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401 && token) logout();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // FastAPI puts the message in "detail" (a list for validation errors).
    const detail = Array.isArray(body.detail)
      ? body.detail.map((d: { msg: string }) => d.msg).join("; ")
      : body.detail;
    throw new ApiError(res.status, detail ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const del = (path: string) => api<void>(path, { method: "DELETE" });

export type Borough = { borough_id: number; name: string };
