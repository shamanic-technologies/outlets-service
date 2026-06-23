/**
 * Centralized outlet-domain normalization + validation.
 *
 * outlets-service must NEVER persist or serve a non-domain value (the "-"
 * placeholder for "no domain", a path-bearing value like "a.com/section",
 * whitespace, empty string) as an outlet's domain — a junk value poisons every
 * downstream ahref enrichment call (ahref-service 400s the whole batch on the
 * first un-normalizable entry).
 *
 * The rule, applied at EVERY write site and mirrored by the ahref read skip:
 *   raw domain -> normalize (trim, lowercase, strip leading "www.")
 *             -> if it is a valid bare host, keep it; otherwise -> null.
 *
 * Junk -> null, fail-loud. No silent fallback to a fake domain.
 */

/** Normalize the same way ahref-service does (trim, case-fold, strip leading www.). */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^www\./, "");
}

/**
 * True iff `domain` is a valid BARE HOST (registrable hostname, no scheme, no
 * path, no port, no whitespace) — e.g. "techcrunch.com", "abc.net.au". Rejects
 * "-", "", "a.com/section", "a b.com", "localhost" (single label), trailing dots.
 * Expects an already-normalized (lowercased) input.
 */
export function isValidBareHost(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253 || domain.includes("..")) return false;

  const labels = domain.split(".");
  if (labels.length < 2) return false;

  const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!labels.every((label) => labelPattern.test(label))) return false;

  // TLD must be alphabetic (rejects path/port fragments and numeric-only tails).
  return /^[a-z]{2,63}$/.test(labels[labels.length - 1]);
}

/**
 * Normalize a raw domain to a valid bare host, or return `null` when it is not a
 * real domain (missing, empty, "-", path-bearing, whitespace, etc.). This is THE
 * function used at every outlet-domain write site and by the ahref read skip, so
 * stored/served values and the values sent to ahref share one definition.
 */
export function normalizeOutletDomain(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const normalized = normalizeDomain(raw);
  return isValidBareHost(normalized) ? normalized : null;
}

/** Extract the bare host from a URL string, or null if it doesn't parse. */
export function extractHostFromUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Resolve the outlet domain to store, preferring an explicit domain and falling
 * back to the URL's real host (NOT a fake value) when the explicit one is junk.
 * Returns a valid bare host or `null`.
 */
export function resolveOutletDomain(
  domain: string | null | undefined,
  url?: string | null
): string | null {
  return normalizeOutletDomain(domain) ?? normalizeOutletDomain(extractHostFromUrl(url));
}
