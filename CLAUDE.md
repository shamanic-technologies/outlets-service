# outlets-service-v1

## Route Structure

| Tier | Prefix | Auth | Example |
|------|--------|------|---------|
| Public | `/` | None | `GET /health`, `GET /openapi.json` |
| Internal | `/internal/*` | `x-api-key` | `POST /internal/enrich` |
| Org-scoped | `/orgs/*` | `x-api-key` + `x-org-id` | `GET /orgs/outlets`, `POST /orgs/outlets/discover` |

## Auth Model

Two middlewares, applied in `app.ts`:
1. **`apiKeyAuth`** — validates `x-api-key` against `OUTLETS_SERVICE_API_KEY`. Crashes at startup if env var missing.
2. **`requireOrgId`** — requires `x-org-id`, parses all other identity headers as optional into `req.orgContext` (`OrgContext` type).

Middleware order in `app.ts`:
```
Public routes (no middleware)
  └─ apiKeyAuth
       ├─ /internal/* (API key only)
       └─ requireOrgId
            └─ /orgs/* (API key + org context)
```

## Tenant Isolation

Every `/orgs/*` SQL query MUST include `WHERE org_id = $N` — no exceptions. This prevents cross-org data leaks.

## OrgContext Type

```typescript
interface OrgContext {
  orgId: string;        // required (from x-org-id)
  userId?: string;      // optional (from x-user-id)
  runId?: string;       // optional (from x-run-id)
  campaignId?: string;  // optional (from x-campaign-id)
  brandIds: string[];   // optional (from x-brand-id, comma-split)
  featureSlug?: string; // optional (from x-feature-slug)
  workflowSlug?: string;// optional (from x-workflow-slug)
}
```

## Header Forwarding

`buildServiceHeaders(apiKey, ctx)` in `src/services/headers.ts` — includes `x-api-key` and `x-org-id` unconditionally, all others only when present.

## Cross-service enrichment: fail-loud vs best-effort

Two classes of cross-service read enrichment, and they have OPPOSITE failure modes — don't apply one rule to both:

- **Core data → fail-loud.** Enrichment the endpoint's purpose depends on (e.g. journalist outreach status from journalists-service on `GET /orgs/outlets`, which drives `byOutreachStatus`). On failure, throw → 500. `fetchOutletStatuses` is the reference.
- **Decorative annotation → best-effort.** Enrichment that's nice-to-have (e.g. Domain Rating from ahref-service). On failure, `console.warn` + serve the field as `null`. Never 500 the endpoint for it. `getDrStatus` in the route handlers is the reference (the ahref *client* stays fail-loud; the *route* catches and degrades).

**Before choosing fail-loud for a cross-service read, confirm the dependency is deployed in EVERY target environment.** A prod-only dependency + fail-loud read = the non-prod environment 500s the whole endpoint. `ahref-service` is **prod-only** (no staging); Railway private DNS is environment-scoped, so `ahref-service.railway.internal` does not resolve from the staging environment. That's exactly why the DR read is best-effort (degrades to `null` on staging, real values in prod).

## Domain Rating (ahref-service)

- DR is owned by **ahref-service** (domain-keyed cache; it owns the Apify scrape spend). outlets-service stays cost-free.
- **discover** (`POST /orgs/outlets/discover`) fires `POST /orgs/domains/dr-compute` **non-blocking** (`.catch` + log) for the freshly-discovered domains (deduped across cycles) — a trigger, never awaited, never fails discover.
- **Reads** (`GET /orgs/outlets`, `GET /orgs/outlets/:id`) merge `domainRating` live from ahref `GET /orgs/domains/dr-status` (best-effort, see above). `null` = not yet scraped OR ahref unreachable.
- `discoverCycle` / `discoverOutletsInCategory` in `category-discovery.ts` return `{ inserted, domains }` so the route can collect discovered domains for the trigger. The `buffer/next` discovery path does NOT trigger dr-compute (follow-up, not yet wired).
- Env vars: `AHREF_SERVICE_URL`, `AHREF_SERVICE_API_KEY` (the key = ahref's own inbound key, shared).

## Pricing ingestion (bronze → silver → sell)

Per-article purchase pricing flows `outlet_price_sources` (bronze, raw notes, append-only) → `outlet_pricing` (silver, one row/outlet) → `sell_price_cents` (generated = `round(amount_cents × sales_multiplier)`, default ×2.0). `amount_cents` is the INTERNAL retail cost — never crosses the `/orgs` boundary. Two derivation paths feed the SAME silver table:

- **Messy notes → LLM extraction.** Journalist email replies / doc-sheet pastes go through `extractAndUpsertPricing` (`pricing.ts`), which calls the platform LLM (**Gemini Flash** — `provider:"google", model:"flash"`). Only path that should spend LLM tokens. Broker notes (`source_id` set) fan out one extraction per member outlet.
- **Structured catalogs → deterministic import, NO LLM.** A clean broker rate-card CSV is imported by `scripts/import-tremplin-catalog.ts` (`tsx scripts/... --file <csv> [--dry-run]`): pure column parse → `outlet_pricing` (`model='deterministic-import'`, `confidence=1.0`). Running the LLM per row over a clean price column would only burn ~Nk calls and risk hallucinating an exact price. Parse/map helpers live in `src/lib/tremplin-catalog.ts` (unit-tested); the script is thin DB glue (not part of the deployed service).

Idempotency: outlets upsert on domain; bronze guarded on `(outlet_id, captured_by)` (month-stamped marker, e.g. `tremplin-2026-06`) so re-imports append a fresh snapshot without dups; silver upserts on `outlet_id`. `sales_multiplier` is left out of every UPDATE so a manual per-outlet margin override survives re-derivation. The sensitive-topic 2–3× surcharge is a sell-side, per-order rule — NOT baked into `amount_cents`. Catalog DR/traffic/lang columns are ignored on import (DR stays ahref-service's).
