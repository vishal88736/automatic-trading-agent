import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/** A Google account identity taken from a verified ID token. */
export interface GoogleIdentity {
  subject: string;
  email: string;
  displayName: string;
}

type Jwk = JsonWebKey & { kid?: string };
export type GoogleKeySource = () => Promise<Jwk[]>;

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW_SECONDS = 60;

/** Google's signing keys, cached for the lifetime its Cache-Control header allows. */
export function googleKeys(fetcher: typeof fetch = fetch): GoogleKeySource {
  let cached: { keys: Jwk[]; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.keys;
    const response = await fetcher(CERTS_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error("Google signing keys are unavailable");
    const { keys } = (await response.json()) as { keys?: Jwk[] };
    if (!Array.isArray(keys) || !keys.length)
      throw Error("Google signing keys are unavailable");
    const maxAge = Number(
      /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1],
    );
    cached = {
      keys,
      until: Date.now() + (Number.isFinite(maxAge) ? maxAge : 3600) * 1000,
    };
    return keys;
  };
}

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Verifies a Google Sign-In ID token: RS256 signature from Google's published keys,
 * issuer, audience (this deployment's client ID), expiry and a verified email.
 * Returns null for any token that fails a check.
 */
export async function verifyGoogleIdToken(
  token: string,
  clientId: string,
  keys: GoogleKeySource,
  now = Date.now() / 1000,
): Promise<GoogleIdentity | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const jwk = (await keys()).find((key) => key.kid === header.kid);
  if (!jwk) return null;
  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2], "base64url"),
  );
  if (!signed) return null;
  const { iss, aud, exp, iat, sub, email, email_verified, name } = claims;
  if (
    typeof iss !== "string" ||
    !ISSUERS.has(iss) ||
    aud !== clientId ||
    typeof exp !== "number" ||
    exp + CLOCK_SKEW_SECONDS < now ||
    (typeof iat === "number" && iat - CLOCK_SKEW_SECONDS > now) ||
    typeof sub !== "string" ||
    !sub ||
    typeof email !== "string" ||
    (email_verified !== true && email_verified !== "true")
  )
    return null;
  const displayName =
    (typeof name === "string" && name.trim().slice(0, 80)) ||
    email.split("@")[0].slice(0, 80) ||
    "Krono user";
  return { subject: sub, email, displayName };
}
