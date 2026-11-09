import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

/**
 * Who is calling. Two ways in (see ops/traefik/mycanvas-local.yaml):
 *
 * - Public (https://mycanvas.luisserrano.es): Cloudflare Access signs in the
 *   person and forwards a signed JWT (Cf-Access-Jwt-Assertion). We verify it
 *   against the team's public keys and use its email. Traefik marks these
 *   requests `X-MyCanvas-Route: public`; without a valid JWT they're refused.
 * - Local (https://canva.local, LAN only) and dev: no Cloudflare in front, so
 *   the request belongs to the configured owner (MYCANVAS_LOCAL_USER).
 */

const TEAM_DOMAIN = process.env.MYCANVAS_ACCESS_TEAM_DOMAIN?.trim() ?? "";
const ACCESS_AUD = process.env.MYCANVAS_ACCESS_AUD?.trim() ?? "";
const configuredLocalUser = process.env.MYCANVAS_LOCAL_USER?.trim();
export const LOCAL_USER = configuredLocalUser !== undefined && configuredLocalUser !== "" ? configuredLocalUser : "local";
/** Optional extra gate on top of the Access policy (comma-separated). */
const ALLOWED_EMAILS = new Set(
  (process.env.MYCANVAS_ALLOWED_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
);
const CERTS_TTL_MS = 60 * 60 * 1000;

export interface Identity {
  email: string;
  via: "access" | "local";
}
export type AuthResult = { ok: true; identity: Identity } | { ok: false; status: 401 | 403; error: string };

let certs: { keys: Map<string, KeyObject>; fetchedAt: number } | null = null;

async function accessKeys(force = false): Promise<Map<string, KeyObject>> {
  if (!force && certs && Date.now() - certs.fetchedAt < CERTS_TTL_MS) {
    return certs.keys;
  }
  const res = await fetch(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) {
    throw new Error(`Access certs: HTTP ${String(res.status)}`);
  }
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kid) {
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
  }
  certs = { keys, fetchedAt: Date.now() };
  return keys;
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

/** Verifies a Cloudflare Access JWT; returns its email, or null when invalid. */
async function verifyAccessJwt(token: string): Promise<string | null> {
  if (!TEAM_DOMAIN || !ACCESS_AUD) {
    return null;
  }
  const [headerPart, payloadPart, signaturePart] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart) {
    return null;
  }
  try {
    const header = decodePart<{ alg?: string; kid?: string }>(headerPart);
    if (header.alg !== "RS256" || !header.kid) {
      return null;
    }
    let key = (await accessKeys()).get(header.kid);
    // Keys rotate; refresh once for an unknown kid.
    key ??= (await accessKeys(true)).get(header.kid);
    if (!key) {
      return null;
    }
    const signed = Buffer.from(`${headerPart}.${payloadPart}`);
    if (!verify("RSA-SHA256", signed, key, Buffer.from(signaturePart, "base64url"))) {
      return null;
    }
    const payload = decodePart<{ aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string }>(payloadPart);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const now = Date.now() / 1000;
    if (!audiences.includes(ACCESS_AUD) || payload.iss !== `https://${TEAM_DOMAIN}`) {
      return null;
    }
    if (payload.exp === undefined || payload.exp < now || (payload.nbf !== undefined && payload.nbf > now + 60)) {
      return null;
    }
    const email = payload.email?.trim().toLowerCase();
    return email !== undefined && email !== "" ? email : null;
  } catch (error) {
    console.error("access jwt verification failed", error);
    return null;
  }
}

export async function identify(headers: { get(name: string): string | null | undefined }): Promise<AuthResult> {
  const jwt = headers.get("cf-access-jwt-assertion");
  const route = headers.get("x-mycanvas-route");
  if (jwt) {
    const email = await verifyAccessJwt(jwt);
    if (!email) {
      return { ok: false, status: 401, error: "Sign-in could not be verified" };
    }
    if (ALLOWED_EMAILS.size > 0 && !ALLOWED_EMAILS.has(email)) {
      return { ok: false, status: 403, error: "This account has no access" };
    }
    return { ok: true, identity: { email, via: "access" } };
  }
  if (route === "public") {
    return { ok: false, status: 401, error: "Sign-in required" };
  }
  return { ok: true, identity: { email: LOCAL_USER, via: "local" } };
}
