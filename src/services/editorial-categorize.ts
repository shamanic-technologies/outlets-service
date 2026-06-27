import type { OrgContext } from "../middleware/org-context";
import { chatComplete } from "./chat";

// LLM model for editorial-email categorization + contact-URL picking. Cheap,
// fast, deterministic-ish. Org-billed via chat-service /complete (the inbound
// org request's identity headers are reused — chat-service owns the cost).
const MODEL = { provider: "google", model: "flash", temperature: 0.1 } as const;

export interface CategorizedEmail {
  email: string;
  category: string;
}

const CATEGORIZE_SYSTEM_PROMPT = `You identify the REAL editorial / press contact email addresses of a news outlet or publication.

You are given a publication name + domain and a list of candidate email addresses that were regex-scraped from web pages (the outlet's own pages and/or third-party press-contact pages). Your job: return ONLY the addresses that are genuine, sendable editorial / press / newsroom contacts for THIS specific publication, ranked best-first.

REJECT (do not return):
- App identifiers, frontend/build identifiers, tracking or telemetry tokens (e.g. "cobertura-ao-vivo-frontend@apps.globoid"), anything that is not a real human-reachable mailbox.
- Addresses on fake / non-real / internal domains (a domain that is not a registrable public domain that accepts mail).
- Vendor, CDN, analytics, ad-tech, or example/placeholder addresses.
- Addresses clearly belonging to a DIFFERENT organization than this publication.
- Pure advertising / sales / subscription inboxes UNLESS no editorial contact exists at all.

RANK best-first:
1. Dedicated editorial / press / newsroom inboxes (editorial@, redacao@, redazione@, imprensa@, presse@, press@, newsroom@, tips@, news@).
2. Named editors / journalists / reporters at this publication.
3. Generic contact inboxes (contact@, contato@, info@, hello@) as a last resort.

Output strict JSON: {"kept": [{"email": "<address>", "category": "editorial|press|newsroom|named|generic"}]}. Only include addresses that appear verbatim in the candidate list. If none qualify, return {"kept": []}.`;

const CATEGORIZE_SCHEMA = {
  type: "object",
  properties: {
    kept: {
      type: "array",
      items: {
        type: "object",
        properties: {
          email: { type: "string" },
          category: { type: "string" },
        },
        required: ["email", "category"],
      },
    },
  },
  required: ["kept"],
};

/**
 * Categorize + rank scraped candidate addresses for an outlet, dropping junk
 * (app identifiers, fake domains, unrelated orgs). Returns the kept addresses
 * best-first. Guards against LLM hallucination: only addresses present in the
 * input candidate set are returned. Empty input → empty output (no LLM call).
 *
 * Fail-loud: a chat-service error propagates (caller treats the cycle as failed).
 */
export async function categorizeEditorialEmails(
  outletName: string,
  domain: string,
  candidates: string[],
  ctx: OrgContext
): Promise<CategorizedEmail[]> {
  if (candidates.length === 0) return [];

  const message = `Publication: ${outletName}\nDomain: ${domain}\nCandidate email addresses scraped from the web:\n${candidates
    .map((e) => `- ${e}`)
    .join("\n")}`;

  const response = await chatComplete(
    {
      ...MODEL,
      message,
      systemPrompt: CATEGORIZE_SYSTEM_PROMPT,
      responseFormat: "json",
      responseSchema: CATEGORIZE_SCHEMA,
    },
    ctx
  );

  const json = response.json as { kept?: Array<{ email?: string; category?: string }> } | undefined;
  const candSet = new Set(candidates.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  const out: CategorizedEmail[] = [];
  for (const k of json?.kept ?? []) {
    const email = (k.email ?? "").toLowerCase().trim();
    // Hallucination guard: the LLM must not invent an address that was not scraped.
    if (!email || !candSet.has(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, category: (k.category ?? "editorial").toLowerCase().trim() || "editorial" });
  }
  return out;
}

const PICK_URLS_SYSTEM_PROMPT = `You pick the web pages most likely to list a news outlet's editorial / press / newsroom contact email.

Given a publication name + domain and a list of URLs from the site's sitemap, return the up-to-3 URLs most likely to contain an editorial, press, newsroom, "imprensa", "contato", "contact", "about", "team", or "masthead" contact address. Prefer dedicated press / editorial / contact pages over generic article URLs.

Output strict JSON: {"urls": ["<url>", ...]}. Only include URLs that appear verbatim in the input list. Return at most 3.`;

const PICK_URLS_SCHEMA = {
  type: "object",
  properties: {
    urls: { type: "array", items: { type: "string" } },
  },
  required: ["urls"],
};

/**
 * From a sitemap URL list, pick the up-to-3 pages most likely to hold an
 * editorial/press contact. Guards against hallucination (only input URLs are
 * returned). Empty input → empty output (no LLM call). Fail-loud.
 */
export async function pickContactUrls(
  outletName: string,
  domain: string,
  urls: string[],
  ctx: OrgContext,
  limit = 3
): Promise<string[]> {
  if (urls.length === 0) return [];

  const message = `Publication: ${outletName}\nDomain: ${domain}\nSitemap URLs:\n${urls
    .map((u) => `- ${u}`)
    .join("\n")}`;

  const response = await chatComplete(
    {
      ...MODEL,
      message,
      systemPrompt: PICK_URLS_SYSTEM_PROMPT,
      responseFormat: "json",
      responseSchema: PICK_URLS_SCHEMA,
    },
    ctx
  );

  const json = response.json as { urls?: string[] } | undefined;
  const inputSet = new Set(urls);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of json?.urls ?? []) {
    if (typeof u !== "string" || !inputSet.has(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}
