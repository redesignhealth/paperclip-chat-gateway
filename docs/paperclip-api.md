# Paperclip API surface used by this gateway

This gateway talks to Paperclip through a single interface, `PaperclipClient`
(`packages/core/src/paperclip-client.ts`), so that if Paperclip's HTTP shape
changes, exactly one file needs to change. This document records what that
implementation was coded against: real endpoints and auth behavior found by
reading the Paperclip server source, with upstream file references so this
can be re-verified against a newer Paperclip checkout.

Paperclip has no chat product. There is no "send a message to an agent"
endpoint. Instead, the gateway rides Paperclip's existing issue-comment
model: posting a comment on an issue is how a human (or, here, the gateway
on a human's behalf) talks to the assigned agent, and Paperclip's own
comment-handling code wakes that agent as a side effect. This matches the
"issue-backed conversation" design in Paperclip's own (unbuilt) chat plan,
`doc/plans/2026-03-11-agent-chat-ui-and-issue-backed-conversations.md`.

## Auth

`Authorization: Bearer <scoped agent API key>`

The key is a per-agent Paperclip agent API key — the same credential model
Hermes gateway uses (see `doc/HERMES_GATEWAY_ONBOARDING.md`: claim a
`PAPERCLIP_API_KEY` once via the join/approve/claim-key flow, never a
shared board key). Paperclip authenticates it in
`server/src/middleware/auth.ts`: the bearer token is SHA-256 hashed and
looked up against the `agent_api_keys` table, and the resulting request
actor has `type: "agent"` scoped to that one agent.

## Endpoints coded against

All paths are relative to Paperclip's API base URL (`/api` by convention).

| Method | Path | Upstream reference | Used for |
| --- | --- | --- | --- |
| `GET` | `/issues/:id` | `server/src/routes/issues.ts:5978` | Reading issue status/assignee before posting |
| `POST` | `/issues/:id/comments` | `server/src/routes/issues.ts:10961`, schema `addIssueCommentSchema` in `packages/shared/src/validators/issue.ts:668` | **Sending a chat message.** Body: `{ body, reopen?, resume?, interrupt?, presentation?, metadata? }`. Paperclip wakes the assignee agent (`heartbeat.wakeup(...)`, reason `issue_commented`) as a side effect — see `server/src/routes/issues.ts:2029`. |
| `GET` | `/issues/:id/comments` | `server/src/routes/issues.ts:10106` | Rendering message history |
| `GET` | `/issues/:issueId/active-run` | `server/src/routes/agents.ts:4004` | Polling for "agent is thinking" status |
| `GET` | `/issues/:issueId/live-runs` | `server/src/routes/agents.ts:3949` | Documented but not wired in v1 — see gap below |

### `addIssueCommentSchema` (from `packages/shared/src/validators/issue.ts:668`)

```ts
{
  body: string;               // min length 1
  onBehalfOfUserId?: string;  // agent actors setting this get audited/denied — do not use
  authorType?: "...";
  presentation?: {...} | null;
  metadata?: {...} | null;
  reopen?: boolean;
  resume?: boolean;           // set true so a done/blocked issue resumes on reply
  interrupt?: boolean;
}
```

The gateway sends `{ body, resume: true }`. `resume: true` mirrors normal
board behavior when a human replies to a finished or blocked issue — it's
what makes "reply and the agent picks it back up" work without the gateway
having to reason about issue status transitions itself.

## What the design doc assumed that didn't survive contact with the real API

- **There is no "create a conversation" endpoint scoped the way a chat
  gateway would want.** Issue creation upstream (`POST /issues` and
  `POST /issues/:id/children`, see `server/src/routes/issues.ts`) requires
  a `companyId` and expects project/goal linkage that this gateway has no
  reason to know about — the gateway's whole point is narrow, per-agent
  scoping, not full Paperclip company administration. `PaperclipClient.
  createConversationIssue` is implemented as a documented stub
  (`NotImplementedError`) rather than guessed at. Closing this gap needs a
  real Paperclip deployment to test the minimal-permission shape of that
  call against, which is out of scope for this scaffold PR.
- **No dedicated wakeup/invocation endpoint exists.** The onboarding doc's
  language ("wake the agent through the normal Paperclip heartbeat path")
  turned out to mean: wakeup is not something the API caller requests
  directly at all. It's an implicit side effect of `POST .../comments`
  inside `server/src/routes/issues.ts`. `PaperclipClient` has no
  `wake()` method for this reason — `postComment` *is* the wake call.
- **Streaming is not wired in v1.** `GET /issues/:issueId/live-runs` and
  `GET /issues/:issueId/active-run` exist and were read
  (`server/src/routes/agents.ts:3949` and `:4004`), and `PaperclipClient.
  getActiveRun` wraps the latter, but the web transport currently polls
  `GET /api/chat/messages` rather than consuming either run stream. Wiring
  live-run output into the chat pane (so replies stream token-by-token
  instead of appearing on poll) is a good v1.1 follow-up.
- **Session identity is issue identity, full stop.** The design doc's
  "session = issue-backed durable object" idea held up as-is: this gateway
  has no separate session store beyond an in-memory
  `(employeeId, agentId) -> issueId` map (`packages/core/src/session.ts`),
  since Paperclip's issue + comment history is already the durable record.
