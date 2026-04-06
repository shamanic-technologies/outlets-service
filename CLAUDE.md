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
