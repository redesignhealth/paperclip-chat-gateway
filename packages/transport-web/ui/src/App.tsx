import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  id: string;
  body: string;
  authorType: string;
  createdAt: string;
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    const res = await fetch("/api/chat/messages", { credentials: "include" });
    if (res.status === 401) {
      setAuthRequired(true);
      return;
    }
    setAuthRequired(false);
    const data = (await res.json()) as { messages: ChatMessage[] };
    setMessages(data.messages);
  }

  useEffect(() => {
    void refresh();
    pollRef.current = setInterval(() => void refresh(), 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function sendMessage() {
    if (!draft.trim()) return;
    setSending(true);
    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft }),
      });
      if (res.ok) {
        setDraft("");
        await refresh();
      }
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
