// Pure helpers for editorial-email extraction, filtering, scoring and status.
// No I/O — fully unit-testable. Ported from the validated scrape.do technique,
// plus Cloudflare data-cfemail de-obfuscation (many WordPress sites hide emails
// as `data-cfemail="HEX"` / `/cdn-cgi/l/email-protection#HEX`, which the plain
// regex never sees → false empties).

export type EditorialStatus =
  | "found"
  | "found_google"
  | "parked_dead"
  | "no_email_found";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_VALIDATE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|css|js|json|xml|woff2?|ico)$/i;

const DOMAIN_JUNK = new Set([
  "example.com", "example.org", "sentry.io", "wix.com", "wixpress.com",
  "godaddy.com", "scrape.do", "w3.org", "schema.org", "googleapis.com",
  "gstatic.com", "cloudflare.com", "jsdelivr.net", "gravatar.com",
  "sentry-next.wixpress.com", "yourdomain.com", "domain.com", "email.com",
  "test.com", "company.com",
]);

// Local-part priority for editorial-first ordering. Lower score = surfaced first.
const PRIORITY = ["EDITORIAL", "EDITOR", "NEWS", "PRESS", "TIPS", "NEWSROOM", "STORY", "PITCH"];
const GENERIC = new Set(["INFO", "HELLO", "CONTACT", "MAIL"]);

/** Detect a parked / lander domain by its redirect JS (scrape.do passes the body through). */
export function isLander(html: string): boolean {
  return /location\.href="\/lander|\/lander\?oref/.test(html);
}

/** Normalized root domain (strips leading www., keeps the last two labels). */
export function rootDomain(domain: string): string {
  return domain.replace(/^www\./, "").split(".").slice(-2).join(".");
}

/**
 * Decode a Cloudflare-obfuscated email hex string.
 * First byte is the XOR key; remaining bytes are the email chars XORed with it.
 * Returns null if the hex is malformed.
 */
export function decodeCfemail(hex: string): string | null {
  const pairs = hex.match(/../g);
  if (!pairs || pairs.length < 2) return null;
  const bytes = pairs.map((h) => parseInt(h, 16));
  if (bytes.some((b) => Number.isNaN(b))) return null;
  const key = bytes[0];
  return bytes.slice(1).map((x) => String.fromCharCode(x ^ key)).join("");
}

/** Pull every Cloudflare-obfuscated email out of raw HTML (data-cfemail + /cdn-cgi link). */
function cfEmails(html: string): string[] {
  const out: string[] = [];
  const hexes = [
    ...html.matchAll(/data-cfemail="([a-f0-9]+)"/gi),
    ...html.matchAll(/\/cdn-cgi\/l\/email-protection#([a-f0-9]+)/gi),
  ];
  for (const m of hexes) {
    const decoded = decodeCfemail(m[1]);
    if (decoded) out.push(decoded);
  }
  return out;
}

function isJunk(email: string): boolean {
  if (ASSET_RE.test(email)) return true;
  const dom = email.split("@")[1] || "";
  if (DOMAIN_JUNK.has(dom)) return true;
  if (email.includes("..") || email.length > 80) return true;
  if (/^[0-9a-f]{16,}@/.test(email)) return true; // hash-like local part (sentry / tracking)
  return false;
}

/**
 * Extract, decode (cfemail), normalize, filter and dedupe emails from raw HTML
 * (or any text blob, e.g. serialized search results).
 */
export function extractEmails(text: string): string[] {
  const out = new Set<string>();
  const candidates = [...(text.match(EMAIL_RE) || []), ...cfEmails(text)];
  for (const raw of candidates) {
    const e = raw.toLowerCase().replace(/\.$/, "");
    if (!EMAIL_VALIDATE.test(e)) continue; // re-validate decoded cfemail blobs
    if (isJunk(e)) continue;
    out.add(e);
  }
  return [...out];
}

/** Editorial-first score. Lower = higher priority (surfaced first). */
export function scoreEmail(email: string): number {
  const lp = (email.split("@")[0] || "").toUpperCase();
  for (let i = 0; i < PRIORITY.length; i++) {
    if (lp.includes(PRIORITY[i])) return i;
  }
  if (GENERIC.has(lp)) return 50; // generic inbox — last
  return 25; // named person — likely an editor / journalist
}

/** Human-readable role bucket for the silver row (derived from the score). */
export function roleOf(email: string): string {
  const lp = (email.split("@")[0] || "").toUpperCase();
  for (const kw of PRIORITY) if (lp.includes(kw)) return kw.toLowerCase();
  if (GENERIC.has(lp)) return "generic";
  return "named";
}
