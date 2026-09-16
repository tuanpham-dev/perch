import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

type Status = "checking" | "authorized" | "unauthorized";

// GET /api/auth is a no-op probe: it 204s once the request carries a valid
// token (via the ?token= param here, or the cookie that minted on a prior
// call) or the gate is off, and 401s otherwise. A successful call with
// `token` set also mints the auth cookie server-side (see index.ts).
async function probeAuth(token?: string): Promise<boolean> {
  const url = token ? `/api/auth?token=${encodeURIComponent(token)}` : "/api/auth";
  const res = await fetch(url, { credentials: "same-origin" });
  return res.status === 204;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const urlToken = new URLSearchParams(location.search).get("token") ?? undefined;
    probeAuth(urlToken).then((ok) => {
      if (ok && urlToken) {
        // The cookie is minted now — drop the secret from the address bar
        // (and future browser history entries) rather than leaving it there.
        const url = new URL(location.href);
        url.searchParams.delete("token");
        history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
      setStatus(ok ? "authorized" : "unauthorized");
    });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(false);
    const ok = await probeAuth(token);
    if (ok) {
      // Reload rather than setStatus("authorized") — App and its extensions
      // haven't loaded any data yet, so a fresh boot is simpler than trying
      // to unwind partial "unauthorized" state.
      location.reload();
      return;
    }
    setSubmitting(false);
    setError(true);
  };

  if (status === "checking") return null;
  if (status === "authorized") return <>{children}</>;

  return (
    <div className="dialog-overlay">
      <div className="dialog" role="dialog">
        <div className="dialog-title">Authentication required</div>
        <form onSubmit={submit}>
          <div className="dialog-message">Enter the access token to continue.</div>
          <input
            className="dialog-input"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {error && <div className="auth-gate-error">Invalid token.</div>}
          <div className="dialog-buttons">
            <button
              className="dialog-button primary"
              type="submit"
              disabled={submitting || !token}
            >
              {submitting ? "Checking…" : "Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
