# paperclip-chat-gateway

A standalone, transport-agnostic chat gateway for [Paperclip](https://github.com/paperclipai/paperclip) agents.

**The problem:** Paperclip deliberately has no chat surface ("agents have jobs, not chat windows"), and its access model is company-scoped — there is no built-in way to give each human a private, free-text channel to *their own* agent and nobody else's.

**What this does:** one small service with one job —

1. **Authenticate** the human (pluggable auth adapter)
2. **Bind** them 1:1 to their agent (hard lookup, enforced in code)
3. **Deliver** the message via Paperclip's wakeup-with-context API, using a service credential only the gateway holds

Run your agents in protected mode so the gateway is their only wake principal, and the per-person channel scoping Paperclip can't express becomes a property of your deployment.

## Architecture

- **Core:** identity→agent binding + Paperclip API client. No vendor- or org-specific code.
- **Auth adapters:** bring your own (OIDC/anything). First adapter: generic OIDC.
- **Transport adapters:** web UI first; Slack, Signal, etc. as they land.

## Status

Early. Built in the open from day one. Design doc and roadmap forthcoming.

## License

MIT
