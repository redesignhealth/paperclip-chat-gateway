/**
 * Verifies Paperclip agent run tokens (the JWT Paperclip hands an agent
 * process via `PAPERCLIP_API_KEY`) so this gateway can broker calls FROM
 * agents without trusting any spoofable claim inside the token.
 *
 * ## What possession of a valid token proves
 *
 * That the bearer is (or very recently was) a live Paperclip agent run:
 * specifically, the run identified by `run_id`, executing as the agent
 * identified by `sub` (agentId). That's it. See the README's "Trust model"
 * section for the full writeup.
 *
 * ## The signing key is NOT a single static secret
 *
 * Paperclip does not sign these tokens with its raw `BETTER_AUTH_SECRET`.
 * It derives a per-company (and per-control-plane-instance) HMAC key from
 * that master secret:
 *
 *   derivedKey = HMAC-SHA256(masterSecret, `jwt:${instanceId}:${companyId}`)
 *
 * and signs the token with `derivedKey`, not `masterSecret` (source:
 * paperclip's `server/src/agent-auth-jwt.ts`, `deriveCompanySigningKey` /
 * `verifyLocalAgentJwt`, read read-only against commit 75acc4650 while
 * building this). It also accepts a legacy fallback — verifying directly
 * against the raw master secret — for tokens minted before per-company
 * derivation existed. We mirror both paths here: a generic "HS256 JWT,
 * verify with the shared secret" implementation would silently reject every
 * real Paperclip-issued token once Paperclip enables per-company signing
 * (or would need code changes to catch up), so this module treats the
 * derivation as load-bearing, not optional.
 *
 * `company_id` is read from the token's own (not-yet-verified) claims only
 * to select which candidate key to try — this is the same trust pattern as
 * a `kid` header in JWKS-based verification. It never influences the
 * result unless the cryptographic signature check against the key derived
 * from it actually passes; a forged `company_id` just picks the wrong key
 * and verification fails.
 */

import { createHmac } from "node:crypto";
import { compactVerify, decodeJwt, decodeProtectedHeader } from "jose";

/** The only algorithm this verifier will ever accept. Pinned, not configurable. */
const JWT_ALGORITHM = "HS256";

export interface AgentTokenConfig {
  /**
   * The master secret this token's signing key is derived from — i.e.
   * Paperclip's `PAPERCLIP_AGENT_JWT_SECRET` / `BETTER_AUTH_SECRET`. Must
   * come from the deployment's own secret store (env var backed by a
   * secrets manager); there is no default and there must never be one —
   * a default here would mean every deployment of this gateway trusts the
   * same forgeable value.
   */
  secret: string;
  /**
   * Paperclip's control-plane `instanceId` used in its derived-key scheme.
   * The live control plane uses `"default"`; forks/worktrees mint tokens
   * under a distinct id specifically so they cannot authenticate against a
   * different plane (see paperclip's PAP-12896/PAP-12899). Defaults to
   * `"default"` — set this explicitly if the gateway is meant to accept
   * tokens from a non-default Paperclip instance.
   */
  instanceId?: string;
  /** If set, reject tokens whose `iss` claim (when present) doesn't match. */
  issuer?: string;
  /** If set, reject tokens whose `aud` claim (when present) doesn't match. */
  audience?: string;
  /**
   * Mirrors Paperclip's own `PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK`.
   * When false (default), a token that fails the per-company derived-key
   * check is retried against the raw master secret, for compatibility with
   * tokens minted before per-company derivation. Set true once you're
   * confident no such legacy token can still be outstanding (bounded by the
   * token TTL) to close that verification path entirely.
   */
  disableLegacyFallback?: boolean;
}

/**
 * The ONLY facts this module will hand back about a verified token.
 * Deliberately does not include `responsible_user_id`, `company_id`, or any
 * other raw claim — see the module docstring and README for why
 * `responsible_user_id` in particular must never influence identity
 * resolution downstream of this call.
 */
export interface VerifiedAgentToken {
  /** The agent identity the token's `sub` claim names — NOT a human. */
  agentId: string;
  runId: string;
}

export class AgentTokenVerificationError extends Error {
  constructor(reason: string) {
    super(`Agent run token rejected: ${reason}`);
    this.name = "AgentTokenVerificationError";
  }
}

/**
 * Mirrors Paperclip's `deriveCompanySigningKey` exactly, including a detail
 * that's easy to get wrong: Paperclip's derivation produces a *hex string*
 * digest, and that hex string — its UTF-8 bytes, not the raw 32-byte
 * digest — is what gets used as the HMAC key for signing/verifying the
 * token. Using the raw digest bytes here (a very natural-looking "fix")
 * silently produces a key that never matches a real Paperclip-signed
 * token.
 */
function deriveCompanySigningKey(masterSecret: string, companyId: string, instanceId: string): Uint8Array {
  const hexDigest = createHmac("sha256", masterSecret).update(`jwt:${instanceId}:${companyId}`).digest("hex");
  return new TextEncoder().encode(hexDigest);
}

/**
 * Verifies a Paperclip agent run token end to end: signature (HS256 only,
 * against the correctly-derived key, with the documented legacy-secret
 * fallback), `exp`, and the presence of `sub`/`run_id`. Throws
 * `AgentTokenVerificationError` for every failure mode — there is no
 * "partially trust this token" return value.
 */
export async function verifyAgentRunToken(token: string, config: AgentTokenConfig): Promise<VerifiedAgentToken> {
  if (!token) throw new AgentTokenVerificationError("empty token");

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AgentTokenVerificationError("malformed token");
  }

  // Fail closed on `alg: none` and any asymmetric algorithm before ever
  // touching key material. This check — not the `algorithms` allowlist
  // passed to `compactVerify` below — is the real gate: it runs before any
  // key derivation, so an attacker can never induce this code into treating
  // an unsigned or wrongly-signed-algorithm token as authenticated.
  if (header.alg !== JWT_ALGORITHM) {
    throw new AgentTokenVerificationError(`unsupported algorithm "${header.alg}" — only ${JWT_ALGORITHM} is accepted`);
  }

  let unverifiedClaims: Record<string, unknown>;
  try {
    // Unverified by design at this point — used only to pick which
    // candidate key to try. Nothing read here is trusted for anything else;
    // see module docstring.
    unverifiedClaims = decodeJwt(token);
  } catch {
    throw new AgentTokenVerificationError("malformed token");
  }

  const companyId = typeof unverifiedClaims.company_id === "string" ? unverifiedClaims.company_id : null;
  if (!companyId) {
    throw new AgentTokenVerificationError("missing company_id claim");
  }

  const instanceId = config.instanceId ?? "default";
  const derivedKey = deriveCompanySigningKey(config.secret, companyId, instanceId);

  let verifiedPayload: Uint8Array;
  try {
    const result = await compactVerify(token, derivedKey, { algorithms: [JWT_ALGORITHM] });
    verifiedPayload = result.payload;
  } catch {
    if (config.disableLegacyFallback) {
      throw new AgentTokenVerificationError("signature verification failed");
    }
    try {
      const legacyKey = new TextEncoder().encode(config.secret);
      const result = await compactVerify(token, legacyKey, { algorithms: [JWT_ALGORITHM] });
      verifiedPayload = result.payload;
    } catch {
      throw new AgentTokenVerificationError("signature verification failed");
    }
  }

  // From here on we only trust `claims` parsed from the cryptographically
  // verified payload — never `unverifiedClaims` from earlier.
  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(verifiedPayload));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    claims = parsed as Record<string, unknown>;
  } catch {
    throw new AgentTokenVerificationError("malformed claims payload");
  }

  const agentId = typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  const runId = typeof claims.run_id === "string" && claims.run_id.length > 0 ? claims.run_id : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!agentId || !runId || exp === null) {
    throw new AgentTokenVerificationError("missing required claim (sub, run_id, or exp)");
  }

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) {
    throw new AgentTokenVerificationError("token expired");
  }

  if (config.issuer !== undefined) {
    const iss = typeof claims.iss === "string" ? claims.iss : undefined;
    if (iss !== config.issuer) {
      throw new AgentTokenVerificationError("issuer mismatch");
    }
  }
  if (config.audience !== undefined) {
    const aud = typeof claims.aud === "string" ? claims.aud : undefined;
    if (aud !== config.audience) {
      throw new AgentTokenVerificationError("audience mismatch");
    }
  }

  // Deliberately NOT returned: `responsible_user_id`. Paperclip sets this
  // from `responsibleUserId`, which is client-settable by any member at
  // issue creation — it is not a property the token's signer attests to in
  // any cryptographic sense, so it must never be allowed to influence who
  // this gateway believes a call is acting on behalf of. We don't merely
  // avoid *using* it — we never even read it out of `claims` here, so no
  // future caller of this module can reach for it by accident.
  return { agentId, runId };
}
