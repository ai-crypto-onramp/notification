import crypto from "node:crypto";

/** HS256 service-token JWT auth for Fastify.
 *
 * Validates `Authorization: Bearer <jwt>` against the shared
 * `SERVICE_TOKEN_SECRET` env var. /healthz, /readyz and /metrics bypass auth.
 * In `DEV_MODE=1` with an unset secret the hook is a no-op. Mirrors the
 * orchestrator-tx internal/authtoken middleware shape.
 */

const SKIP_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

interface Claims {
  sub: string;
  iat: number;
  exp: number;
  [k: string]: unknown;
}

function b64urlDecode(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s + pad, "base64url");
}

function b64urlEncode(b: Buffer): string {
  return b.toString("base64url").replace(/=+$/, "");
}

function verify(token: string, secret: string): Claims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = b64urlEncode(
    crypto.createHmac("sha256", secret).update(signingInput).digest(),
  );
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) {
    throw new Error("invalid signature");
  }
  let claims: Claims;
  try {
    claims = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch {
    throw new Error("malformed payload");
  }
  if (typeof claims.exp === "number" && Math.floor(Date.now() / 1000) > claims.exp) {
    throw new Error("token expired");
  }
  return claims;
}

function secretFromEnv(): { secret: string; bypass: boolean } {
  const s = process.env.SERVICE_TOKEN_SECRET ?? "";
  if (s) return { secret: s, bypass: false };
  if (process.env.DEV_MODE === "1") {
    // eslint-disable-next-line no-console
    console.warn(
      "warn: SERVICE_TOKEN_SECRET unset and DEV_MODE=1; service-token auth disabled (NOT FOR PRODUCTION)",
    );
    return { secret: "", bypass: true };
  }
  // eslint-disable-next-line no-console
  console.error(
    "FATAL: SERVICE_TOKEN_SECRET not set and DEV_MODE!=1; refusing to start in production mode",
  );
  process.exit(1);
}

/** Issue a 24h HS256 JWT for the named service. Used by internal callers and tests. */
export function issue(serviceName: string, secret: string): string {
  if (!secret) throw new Error("authtoken: secret is required to issue a token");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims: Claims = { sub: serviceName, iat: now, exp: now + 24 * 60 * 60 };
  const hb = b64urlEncode(Buffer.from(JSON.stringify(header)));
  const cb = b64urlEncode(Buffer.from(JSON.stringify(claims)));
  const sig = b64urlEncode(
    crypto.createHmac("sha256", secret).update(`${hb}.${cb}`).digest(),
  );
  return `${hb}.${cb}.${sig}`;
}

export interface AuthState {
  secret: string;
  bypass: boolean;
}

export function resolveAuth(): AuthState {
  const { secret, bypass } = secretFromEnv();
  return { secret, bypass };
}

/** Fastify onRequest hook validating the service-token JWT. */
export function makeAuthHook(state: AuthState) {
  return async (req: { url: string; headers: Record<string, string | string[]> }, reply: { code: (c: number) => { send: (b: unknown) => void } }) => {
    const path = req.url.split("?")[0];
    if (state.bypass || SKIP_PATHS.has(path)) return;
    const auth = (req.headers.authorization as string | undefined) ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!token) {
      reply.code(401).send({ error: { code: "unauthorized", message: "missing or malformed Authorization header" } });
      return;
    }
    try {
      verify(token, state.secret);
    } catch (e) {
      reply.code(401).send({ error: { code: "unauthorized", message: (e as Error).message } });
    }
  };
}