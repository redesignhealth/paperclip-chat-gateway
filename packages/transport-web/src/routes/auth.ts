import type { FastifyInstance } from "fastify";
import type { GatewayDeps } from "../types.js";

const OIDC_TRANSACTION_COOKIE = "pcg_oidc_txn";
const SESSION_COOKIE = "pcg_session";

interface OidcTransactionCookie {
  state: string;
  codeVerifier: string;
}

export function registerAuthRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.get("/auth/login", async (_req, reply) => {
    const login = await deps.oidc.startLogin();
    reply.setCookie(OIDC_TRANSACTION_COOKIE, JSON.stringify({ state: login.state, codeVerifier: login.codeVerifier } satisfies OidcTransactionCookie), {
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
    const txn = JSON.parse(unsigned.value) as OidcTransactionCookie;

    const currentUrl = new URL(req.url, `${req.protocol}://${req.hostname}`);

    let claims;
    try {
      claims = await deps.oidc.handleCallback({
        currentUrl,
        expectedState: txn.state,
        codeVerifier: txn.codeVerifier,
      });
    } catch (error) {
      req.log.warn({ err: error }, "OIDC callback failed");
      reply.code(403).send({ error: "Login failed." });
      return;
    }

    const employeeId = await deps.resolveEmployeeId(claims);
    if (!employeeId) {
      reply.code(403).send({ error: "This identity is not registered with the gateway." });
      return;
    }

    reply.clearCookie(OIDC_TRANSACTION_COOKIE, { path: "/auth" });
    reply.setCookie(SESSION_COOKIE, employeeId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      signed: true,
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    reply.redirect("/");
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.send({ ok: true });
  });
}

/** Reads and verifies the session cookie, returning the employeeId or null. */
export function readSessionEmployeeId(req: { cookies: Record<string, string | undefined>; unsignCookie: (v: string) => { valid: boolean; value: string | null } }): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = req.unsignCookie(raw);
  return result.valid ? result.value : null;
}

export const AUTH_COOKIE_NAMES = { OIDC_TRANSACTION_COOKIE, SESSION_COOKIE };
