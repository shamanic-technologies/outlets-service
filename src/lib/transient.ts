// Shared classifier for TRANSIENT TRANSPORT failures on an outbound fetch.
//
// A cold-start / pool-saturation on a sibling service surfaces as a rejected
// fetch (`TypeError: fetch failed`) whose cause walks down to ECONNRESET /
// ETIMEDOUT / ECONNREFUSED, or as an AbortSignal `TimeoutError`. These are
// connect-phase failures where the request never completed — write-safe to
// retry, and (for a best-effort rung) safe to degrade past.
//
// An HTTP 5xx is NOT transient here: the request reached the service and got a
// real answer, so it stays fail-loud (propagates). The `scraping-service POST
// /scrape failed (502)` message deliberately does NOT match the regex below.
export function isTransientTransportError(err: unknown): boolean {
  const codes = new Set([
    "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  ]);
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { name?: string; code?: string; message?: string; cause?: unknown; errors?: unknown[] };
    if (e.name === "TimeoutError") return true;
    if (typeof e.code === "string" && codes.has(e.code)) return true;
    if (typeof e.message === "string" && /fetch failed|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(e.message)) return true;
    if (Array.isArray(e.errors) && e.errors.some((sub) => isTransientTransportError(sub))) return true;
    cur = e.cause;
  }
  return false;
}
