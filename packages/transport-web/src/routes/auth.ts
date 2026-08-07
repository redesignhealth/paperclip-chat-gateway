import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EmailDomainNotAllowedError, EmailNotVerifiedError, MissingEmailClaimError } from "@paperclip-chat-gateway/auth-oidc";
import type { GatewayDeps } from "../types.js";

const OIDC_TRANSACTION_COOKIE = "pcg_oidc_txn";
const SESSION_COOKIE = "pcg_session";
const CSRF_COOKIE = "pcg_csrf";
const CSRF_HEADER = "x-csrf-token";

/** Server-side session expiry, independent of the cookie's own (client-enforced) maxAge. */
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface OidcTransactionCookie {
  state: string;
  codeVerifier: string;
  nonce: string;
}

interface SessionCookiePayload {
  employeeId: string;
  issuedAt: number;
  /**
   * Verified email at the time of login, lowercased. Carried in the
   * (signed, httpOnly) session cookie purely so the admin-allowlist check
   * (`GATEWAY_ADMIN_EMAILS`, see `requireAdmin` in routes/admin.ts) doesn't
   * need a fresh identity-provider round trip on every admin request.
   * Never used for authorization decisions other than the admin allowlist
   * — chat routes and the agent broker route both key exclusively on
   * `employeeId` via BindingTable, per that class's own invariants.
   */
  email?: string;
}

function isKnownAuthPolicyError(error: unknown): boolean {
  return (
    error instanceof EmailDomainNotAllowedError ||
    error instanceof MissingEmailClaimError ||
    error instanceof EmailNotVerifiedError
  );
}

function issueCsrfCookie(reply: FastifyReply): void {
  const token = randomBytes(24).toString("base64url");
  // Deliberately NOT httpOnly: the double-submit pattern requires
  // client-side JS to read this cookie and echo it back in a header, which
  // a cross-site form/script can't do without already being able to read
  // same-site cookies (i.e. same-origin).
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });
}

/**
 * Double-submit CSRF check for state-changing routes: the CSRF cookie value
 * must be present and must exactly match the `x-csrf-token` header. Since
 * the CSRF cookie is set alongside the session cookie and isn't `httpOnly`,
 * only same-origin JS (which can read it) can construct a request that
 * passes this check — SameSite=Lax cookie scoping is not, by itself,
 * sufficient CSRF protection for a write endpoint that sends the user's
 * message content.
 */
export async function requireCsrf(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cookieToken = req.cookies[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || typeof headerToken !== "string" || !headerToken) {
    reply.code(403).send({ error: "Missing CSRF token." });
    return;
  }
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(headerToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    reply.code(403).send({ error: "Invalid CSRF token." });
    return;
  }
}

export function registerAuthRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.get("/auth/login", async (_req, reply) => {
    const login = await deps.oidc.startLogin();
    const txn: OidcTransactionCookie = { state: login.state, codeVerifier: login.codeVerifier, nonce: login.nonce };
    reply.setCookie(OIDC_TRANSACTION_COOKIE, JSON.stringify(txn), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      signed: true,
      path: "/auth",
      maxAge: 600,
    });
    reply.redirect(login.authorizationUrl);
  });

  app.get("/auth/callback", async (req, reply) => {
    const raw = req.cookies[OIDC_TRANSACTION_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value) {
      reply.code(400).send({ error: "Missing or invalid OIDC transaction cookie. Start login again." });
      return;
    }

    let txn: OidcTransactionCookie;
    try {
      txn = JSON.parse(unsigned.value) as OidcTransactionCookie;
    } catch {
      reply.code(400).send({ error: "Malformed OIDC transaction cookie. Start login again." });
      return;
    }

    const currentUrl = new URL(req.url, `${req.protocol}://${req.hostname}`);

    let claims;
    try {
      claims = await deps.oidc.handleCallback({
        currentUrl,
        expectedState: txn.state,
        codeVerifier: txn.codeVerifier,
        expectedNonce: txn.nonce,
      });
    } catch (error) {
      if (isKnownAuthPolicyError(error)) {
        req.log.warn({ err: error }, "OIDC callback rejected by identity policy");
        reply.code(403).send({ error: "Login failed." });
        return;
      }
      // Anything else (discovery/network failure, token endpoint outage,
      // state/PKCE/nonce mismatch, etc.) is an infrastructure problem, not
      // a policy rejection — surface it as a 5xx so on-call can tell the
      // difference between "this login is not allowed" and "the IdP is
      // down," instead of a blanket, misleading 403.
      req.log.error({ err: error }, "OIDC callback failed unexpectedly");
      reply.code(502).send({ error: "Sign-in is temporarily unavailable. Please try again shortly." });
      return;
    }

    const employeeId = await deps.resolveEmployeeId(claims);
    if (!employeeId) {
      reply.code(403).send({ error: "This identity is not registered with the gateway." });
      return;
    }

    reply.clearCookie(OIDC_TRANSACTION_COOKIE, { path: "/auth" });
    const payload: SessionCookiePayload = {
      employeeId,
      issuedAt: Date.now(),
      email: claims.email?.toLowerCase(),
    };
    reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      signed: true,
      path: "/",
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
    issueCsrfCookie(reply);
    reply.redirect("/");
  });

  app.post("/auth/logout", { preHandler: requireCsrf }, async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    reply.send({ ok: true });
  });
}

/**
 * Reads and verifies the session cookie, returning the employeeId or null.
 * Enforces server-side expiry on `issuedAt`, independent of the cookie's
 * own (client-controlled, advisory-only) maxAge attribute — a captured
 * signed cookie stops working after `SESSION_MAX_AGE_MS` even if replayed
 * without its original maxAge/expires metadata.
 */
export function readSessionEmployeeId(req: {
  cookies: Record<string, string | undefined>;
  unsignCookie: (v: string) => { valid: boolean; value: string | null };
}): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = req.unsignCookie(raw);
  if (!result.valid || !result.value) return null;

  let payload: SessionCookiePayload;
  try {
    payload = JSON.parse(result.value) as SessionCookiePayload;
  } catch {
    return null;
  }
  if (typeof payload.employeeId !== "string" || typeof payload.issuedAt !== "number") return null;
  if (Date.now() - payload.issuedAt > SESSION_MAX_AGE_MS) return null;

  return payload.employeeId;
}

/**
 * Reads the verified email captured in the session cookie at login time, or
 * null if there is no valid session or the IdP asserted no email. Used only
 * by the admin-allowlist check (routes/admin.ts) — see
 * `SessionCookiePayload.email`'s doc comment for why this is safe to trust
 * without a fresh IdP round trip.
 */
export function readSessionEmail(req: {
  cookies: Record<string, string | undefined>;
  unsignCookie: (v: string) => { valid: boolean; value: string | null };
}): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = req.unsignCookie(raw);
  if (!result.valid || !result.value) return null;

  let payload: SessionCookiePayload;
  try {
    payload = JSON.parse(result.value) as SessionCookiePayload;
  } catch {
    return null;
  }
  if (typeof payload.employeeId !== "string" || typeof payload.issuedAt !== "number") return null;
  if (Date.now() - payload.issuedAt > SESSION_MAX_AGE_MS) return null;

  return typeof payload.email === "string" ? payload.email : null;
}

/**
 * Route-scoped auth guard shared by every authenticated route
 * (chat, admin). See routes/chat.ts's original doc comment for why this is
 * attached per-route via `preHandler` rather than a blanket
 * `app.addHook("preHandler", ...)`.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const employeeId = readSessionEmployeeId(req);
  if (!employeeId) {
    reply.code(401).send({ error: "Not authenticated." });
    return;
  }
  (req as { employeeId?: string }).employeeId = employeeId;
}

export const AUTH_COOKIE_NAMES = { OIDC_TRANSACTION_COOKIE, SESSION_COOKIE, CSRF_COOKIE };
