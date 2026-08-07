import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  id: string;
  body: string;
  authorType: string;
  createdAt: string;
}

interface ErrorBody {
  error?: string;
}

/** Reads a non-httpOnly cookie by name (used for the double-submit CSRF token). */
function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null;
  return body?.error ?? fallback;
}

/**
 * Minimal chat pane: login -> message list -> composer -> send -> poll for
 * the agent's reply. No streaming yet (v1 polls /api/chat/messages);
 * upgrading to Paperclip's live-run stream is a documented follow-up, see
 * docs/paperclip-api.md.
 */
export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function refresh() {
    // Guard against overlapping requests: the 3s poll can otherwise stack
    // up in-flight requests if one is slow, racing each other for which
    // response lands last.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch("/api/chat/messages", { credentials: "include" });
      if (res.status === 401) {
        setAuthRequired(true);
        stopPolling();
        return;
      }
      if (!res.ok) {
        setError(await extractErrorMessage(res, `Could not load messages (status ${res.status}).`));
        return;
      }
      setAuthRequired(false);
      setError(null);
      const data = (await res.json()) as { messages?: ChatMessage[] };
      setMessages(data.messages ?? []);
    } catch {
      setError("Could not reach the gateway. Retrying...");
    } finally {
      inFlightRef.current = false;
    }
  }

  useEffect(() => {
    void refresh();
    pollRef.current = setInterval(() => void refresh(), 3000);
    return () => stopPolling();
  }, []);

  async function sendMessage() {
    if (!draft.trim()) return;
    setSending(true);
    try {
      const csrfToken = readCookie("pcg_csrf");
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: JSON.stringify({ body: draft }),
      });
      if (res.status === 401) {
        setAuthRequired(true);
        stopPolling();
        return;
      }
      if (!res.ok) {
        setError(await extractErrorMessage(res, `Could not send message (status ${res.status}).`));
        return;
      }
      setError(null);
      setDraft("");
      await refresh();
    } catch {
      setError("Could not reach the gateway. Your message was not sent.");
    } finally {
      setSending(false);
    }
  }

  if (authRequired) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: 32 }}>
        <h1>Paperclip Chat Gateway</h1>
        <p>You need to sign in to chat with your agent.</p>
        <a href="/auth/login">Sign in</a>
      </main>
    );
  }

  return (
    <main style={{ fontFamily: "sans-serif", padding: 32, maxWidth: 640, margin: "0 auto" }}>
      <h1>Paperclip Chat Gateway</h1>
      {error && (
        <div
          role="alert"
          style={{ border: "1px solid #c00", background: "#fee", color: "#900", borderRadius: 8, padding: 12, marginBottom: 16 }}
        >
          {error}
        </div>
      )}
      <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, minHeight: 240, marginBottom: 16 }}>
        {messages.length === 0 && <p style={{ color: "#888" }}>No messages yet. Say hello.</p>}
        {messages.map((message) => (
          <p key={message.id}>
            <strong>{message.authorType === "agent" ? "Agent" : "You"}:</strong> {message.body}
          </p>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1, padding: 8 }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void sendMessage();
          }}
          placeholder="Message your agent..."
        />
        <button onClick={() => void sendMessage()} disabled={sending}>
          Send
        </button>
      </div>
    </main>
  );
}
