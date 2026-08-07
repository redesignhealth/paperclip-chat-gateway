/**
 * Verifies Paperclip agent run tokens (the JWT Paperclip hands an agent
 * process via `PAPERCLIP_API_KEY`) so this gateway can broker calls FROM
 * agents without trusting any spoofable claim inside the token.
 *
 * ## What possession of a valid token proves
 *
 * That the bearer is (or very recently was) a live Paperclip agent run:
 * specifically, the run identified by `run_id`, executing as the agent
 * identified by `sub` (agentId), for a company on this gateway's own
 * `expectedCompanyIds` allowlist. That's it. See the README's "Trust model"
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
 * ## `company_id` is verified, not merely used to pick a key
 *
 * `company_id` is read from the token's own (not-yet-verified) claims to
 * select which candidate key to try — the same trust pattern as a `kid`
 * header in JWKS-based verification. But unlike a `kid`, the *value* of
 * `company_id` also matters to this gateway: this deployment is scoped to
 * one (or an explicit allowlist of) company, so a validly-signed token
 * minted by Paperclip for a *different* company on the same control-plane
 * instance must still be rejected. `config.expectedCompanyIds` is checked
 * BEFORE key derivation for exactly that reason — a mismatched company_id
 * never even gets a chance to select a signature-verifying key.
 */

import { createHmac } from "node:crypto";
import { compactVerify, decodeJwt, decodeProtectedHeader } from "jose";

// NOTE: pinned to jose@5.x deliberately, not jose@6.x (already present
// transitively via auth-oidc's openid-client). jose 6 dropped Node <20 and
// changed several export shapes; this package's `engines.node` allows 20+
// so it may well be compatible, but that hasn't been verified against this
// module's exact API surface (compactVerify/decodeJwt/decodeProtectedHeader)
// as part of this change. This module also intentionally hand-rolls
// exp/nbf/iss/aud/max-age checks rather than jose's own `jwtVerify(...,
// { issuer, audience, clockTolerance })` — that would work, but the
// per-company-derived-key + expectedCompanyIds gate this module implements
// isn't something jwtVerify's options can express, so this file would still
// need custom claim logic around it either way. Left as a follow-up rather
// than folded into this security-fix pass to avoid combining a dependency
// bump with control-flow changes to a trust boundary in one diff.

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
   * The company id(s) this gateway deployment is scoped to. REQUIRED and
   * non-empty: without it, a validly-signed token minted for any other
   * company on the same Paperclip control-plane instance would verify
   * successfully here, defeating company-scoping entirely. A token whose
   * `company_id` is not in this list is rejected before its signature is
   * ever checked against a derived key. Usually a single-element array;
   * an allowlist is supported only for the rare deployment that
   * legitimately brokers for more than one company — never accept an
   * arbitrary/unvalidated company id.
   */
  expectedCompanyIds: string[];
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
  /**
   * If set, reject tokens whose `aud` claim doesn't include this value.
   * `aud` may be a single string or (per RFC 7519) an array of strings;
   * either form is accepted as long as this value appears in it.
   */
  audience?: string;
  /**
   * Mirrors Paperclip's own `PAPERCLIP_AGENT_JWT_ENABLE_LEGACY_FALLBACK`.
   * When false (the default — the fail-closed posture), a token must
   * verify against the per-company derived key; the raw-master-secret
   * legacy path is not attempted at all. Set true only for a deployment
   * that must still accept tokens minted before per-company derivation
   * existed, and only for as long as such a token could still be
   * outstanding (bounded by the token TTL) — this path lets ANY holder of
   * the raw master secret mint tokens this gateway accepts.
   */
  enableLegacyFallback?: boolean;
  /**
   * Clock-skew tolerance (seconds) applied to `exp` and `nbf` checks, to
   * absorb small differences between this gateway's clock and Paperclip's.
   * Defaults to 5 seconds. Keep this small — it directly extends how long
   * an expired token remains accepted.
   */
  clockToleranceSeconds?: number;
  /**
   * If set, reject tokens whose `iat` is more than this many seconds in
   * the past, independent of `exp`. Useful as a defense-in-depth bound
   * against an unusually long-lived token even if the issuer's own `exp`
   * horizon is generous. Unset by default (no additional bound beyond `exp`).
   */
  maxTokenAgeSeconds?: number;
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

/** Attempts an HS256 compact verify against one key, swallowing any failure into `null`. */
async function tryVerify(token: string, key: Uint8Array): Promise<{ payload: Uint8Array } | null> {
  try {
    const result = await compactVerify(token, key, { algorithms: [JWT_ALGORITHM] });
    return { payload: result.payload };
  } catch {
    return null;
  }
}

/**
 * Verifies a Paperclip agent run token end to end: signature (HS256 only,
 * against the correctly-derived key, with the documented legacy-secret
 * fallback), `company_id` against this deployment's allowlist, `exp`/`nbf`/
 * max-age, and the presence of `sub`/`run_id`. Throws
 * `AgentTokenVerificationError` for every failure mode — there is no
 * "partially trust this token" return value.
 */
export async function verifyAgentRunToken(token: string, config: AgentTokenConfig): Promise<VerifiedAgentToken> {
  if (!token) throw new AgentTokenVerificationError("empty token");
  if (!config.expectedCompanyIds || config.expectedCompanyIds.length === 0) {
    // A misconfigured deployment with no allowlist must fail closed, not
    // silently accept every company — see AgentTokenConfig.expectedCompanyIds.
    throw new AgentTokenVerificationError("gateway misconfigured: no expectedCompanyIds configured");
  }

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
    // candidate key to try and to gate on the expected-company allowlist.
    // Nothing read here is trusted for anything else; see module docstring.
    unverifiedClaims = decodeJwt(token);
  } catch {
    throw new AgentTokenVerificationError("malformed token");
  }

  const companyId = typeof unverifiedClaims.company_id === "string" ? unverifiedClaims.company_id : null;
  if (!companyId) {
    throw new AgentTokenVerificationError("missing company_id claim");
  }

  // Reject a company_id outside this deployment's allowlist BEFORE it is
  // ever used to derive a signing key. This is the check that makes
  // company-scoping real: without it, a validly-signed token for a
  // different company on the same control-plane instance would still
  // verify successfully below.
  if (!config.expectedCompanyIds.includes(companyId)) {
    throw new AgentTokenVerificationError("company_id not on this gateway's allowlist");
  }

  const instanceId = config.instanceId ?? "default";
  const derivedKey = deriveCompanySigningKey(config.secret, companyId, instanceId);
  const legacyKey = new TextEncoder().encode(config.secret);

  // Always attempt every enabled verification path concurrently, rather
  // than short-circuiting to the legacy path only after the derived-key
  // path fails. This keeps verification time independent of *which* path
  // (if any) succeeds, closing the timing side-channel that sequential
  // "try derived, then try legacy" attempts would otherwise create between
  // "wrong signature entirely" and "valid only via the legacy path".
  const [derivedResult, legacyResult] = await Promise.all([
    tryVerify(token, derivedKey),
    config.enableLegacyFallback ? tryVerify(token, legacyKey) : Promise.resolve(null),
  ]);
  const verified = derivedResult ?? legacyResult;
  if (!verified) {
    throw new AgentTokenVerificationError("signature verification failed");
  }
  const verifiedPayload = verified.payload;

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

  const clockTolerance = config.clockToleranceSeconds ?? 5;
  const now = Math.floor(Date.now() / 1000);
  if (exp < now - clockTolerance) {
    throw new AgentTokenVerificationError("token expired");
  }

  const nbf = typeof claims.nbf === "number" ? claims.nbf : null;
  if (nbf !== null && nbf > now + clockTolerance) {
    throw new AgentTokenVerificationError("token not yet valid (nbf)");
  }

  if (config.maxTokenAgeSeconds !== undefined) {
    const iat = typeof claims.iat === "number" ? claims.iat : null;
    if (iat === null) {
      throw new AgentTokenVerificationError("missing iat claim required to enforce maxTokenAgeSeconds");
    }
    if (now - iat > config.maxTokenAgeSeconds + clockTolerance) {
      throw new AgentTokenVerificationError("token exceeds maximum allowed age");
    }
  }

  if (config.issuer !== undefined) {
    const iss = typeof claims.iss === "string" ? claims.iss : undefined;
    if (iss !== config.issuer) {
      throw new AgentTokenVerificationError("issuer mismatch");
    }
  }
  if (config.audience !== undefined) {
    const aud = claims.aud;
    const audMatches =
      (typeof aud === "string" && aud === config.audience) ||
      (Array.isArray(aud) && aud.some((entry) => entry === config.audience));
    if (!audMatches) {
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
