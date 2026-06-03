import { z } from "zod";

// Enums
/** DB-level statuses (what gets written to campaign_outlets). */
export const outletStatusEnum = z.enum(["open", "served", "skipped"]);

// --- Outlets ---

export const createOutletSchema = z.object({
  outletName: z.string().min(1),
  outletUrl: z.string().url(),
  outletDomain: z.string().min(1),
  whyRelevant: z.string(),
  whyNotRelevant: z.string(),
  relevanceScore: z.number().min(0).max(100),
  overallRelevance: z.string().optional(),
  relevanceRationale: z.string().optional(),
  status: outletStatusEnum.optional().default("open"),
  statusReason: z.string().optional(),
  statusDetail: z.string().optional(),
});

export const updateOutletSchema = z.object({
  outletName: z.string().min(1).optional(),
  outletUrl: z.string().url().optional(),
  outletDomain: z.string().min(1).optional(),
  whyRelevant: z.string().optional(),
  whyNotRelevant: z.string().optional(),
  relevanceScore: z.number().min(0).max(100).optional(),
  overallRelevance: z.string().optional(),
  relevanceRationale: z.string().optional(),
});

export const updateOutletStatusSchema = z.object({
  status: outletStatusEnum,
  statusReason: z.string().optional(),
  statusDetail: z.string().optional(),
});

export const listOutletsQuerySchema = z.object({
  campaignId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  status: outletStatusEnum.optional(),
  runId: z.string().optional(),
  featureSlugs: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const bulkCreateOutletsSchema = z.object({
  outlets: z.array(createOutletSchema).min(1).max(500),
});

export const searchOutletsSchema = z.object({
  query: z.string().min(1),
  campaignId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

// --- Response schemas ---

export const outletResponseSchema = z.object({
  id: z.string().uuid(),
  outletName: z.string(),
  outletUrl: z.string(),
  outletDomain: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Status counts schema — hybrid: open/served/skipped from outlets-service, email fields from journalists-service. */
export const statusCountsSchema = z.object({
  open: z.number(),
  served: z.number(),
  skipped: z.number(),
  contacted: z.number(),
  sent: z.number(),
  delivered: z.number(),
  opened: z.number(),
  clicked: z.number(),
  replied: z.number(),
  repliesPositive: z.number(),
  repliesNegative: z.number(),
  repliesNeutral: z.number(),
  bounced: z.number(),
  unsubscribed: z.number(),
});

export const campaignOutletResponseSchema = outletResponseSchema.extend({
  campaignId: z.string().uuid(),
  brandIds: z.array(z.string().uuid()),
  whyRelevant: z.string(),
  whyNotRelevant: z.string(),
  relevanceScore: z.number(),
  overallRelevance: z.string().nullable(),
  relevanceRationale: z.string().nullable(),
  runId: z.string().nullable(),
});

export const healthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
});

export const errorResponseSchema = z.object({
  error: z.string(),
});

// --- Internal ---

export const transferBrandBodySchema = z.object({
  sourceBrandId: z.string().uuid(),
  sourceOrgId: z.string().min(1),
  targetOrgId: z.string().min(1),
  targetBrandId: z.string().uuid().optional(),
});

export const transferBrandResponseSchema = z.object({
  updatedTables: z.array(
    z.object({
      tableName: z.string(),
      count: z.number(),
    })
  ),
});

export const internalOutletsBodySchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
  campaignId: z.string().uuid().optional(),
}).refine((data) => (data.ids && data.ids.length > 0) || data.campaignId, {
  message: "At least one of ids or campaignId is required",
});

// --- Stats ---

const statsGroupByEnum = z.enum([
  "workflowSlug",
  "featureSlug",
  "brandId",
  "campaignId",
  "workflowDynastySlug",
]);

export const statsQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  workflowSlug: z.string().optional(),
  workflowSlugs: z.string().optional(),
  featureSlug: z.string().optional(),
  featureSlugs: z.string().optional(),
  workflowDynastySlug: z.string().optional(),
  groupBy: statsGroupByEnum.optional(),
});

export const statsResponseSchema = z.object({
  outletsDiscovered: z.number(),
  avgRelevanceScore: z.number(),
  searchQueriesUsed: z.number(),
  byOutreachStatus: statusCountsSchema.optional(),
});

export const statsGroupedResponseSchema = z.object({
  groups: z.array(
    z.object({
      key: z.string(),
      outletsDiscovered: z.number(),
      avgRelevanceScore: z.number(),
      searchQueriesUsed: z.number(),
    })
  ),
});

// --- Buffer Next ---

export const bufferNextSchema = z.object({
  count: z.number().int().min(1).max(50).optional().default(1),
  idempotencyKey: z.string().min(1).optional(),
});

export const bufferNextResponseSchema = z.object({
  outlets: z.array(
    z.object({
      outletId: z.string().uuid(),
      outletName: z.string(),
      outletUrl: z.string(),
      outletDomain: z.string(),
      campaignId: z.string().uuid(),
      brandIds: z.array(z.string().uuid()),
      relevanceScore: z.number(),
      whyRelevant: z.string(),
      whyNotRelevant: z.string(),
      overallRelevance: z.string().nullable(),
      runId: z.string().nullable(),
    })
  ),
});

export type BufferNext = z.infer<typeof bufferNextSchema>;

// --- Discover ---

export const discoverSchema = z.object({
  count: z.number().int().min(1).max(200).optional().default(15),
});

export const discoverResponseSchema = z.object({
  runId: z.string(),
  discovered: z.number(),
});

export type Discover = z.infer<typeof discoverSchema>;

// --- Stats Costs ---

const statsCostsGroupByEnum = z.enum(["outletId", "runId"]);

export const statsCostsQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  groupBy: statsCostsGroupByEnum.optional(),
});

export const statsCostsResponseSchema = z.object({
  groups: z.array(
    z.object({
      dimensions: z.record(z.string().nullable()),
      totalCostInUsdCents: z.number(),
      actualCostInUsdCents: z.number(),
      provisionedCostInUsdCents: z.number(),
      runCount: z.number(),
    })
  ),
});

// --- Editorial Emails ---

export const editorialEmailDiscoverSchema = z.object({
  outletName: z.string().min(1),
  domain: z.string().min(1),
  url: z.string().url(),
});

export const editorialEmailDiscoverBatchSchema = z.object({
  outlets: z.array(editorialEmailDiscoverSchema).min(1).max(50),
});

const editorialEmailStatusEnum = z.enum([
  "found",
  "found_google",
  "parked_dead",
  "no_email_found",
]);

export const editorialEmailItemSchema = z.object({
  email: z.string(),
  score: z.number(),
  source: z.string(),
});

export const editorialEmailResultSchema = z.object({
  domain: z.string(),
  status: editorialEmailStatusEnum,
  emails: z.array(editorialEmailItemSchema),
});

export const editorialEmailBatchResultSchema = z.object({
  results: z.array(editorialEmailResultSchema),
});

export type EditorialEmailDiscover = z.infer<typeof editorialEmailDiscoverSchema>;
export type EditorialEmailDiscoverBatch = z.infer<typeof editorialEmailDiscoverBatchSchema>;

// Type exports
export type CreateOutlet = z.infer<typeof createOutletSchema>;
export type UpdateOutlet = z.infer<typeof updateOutletSchema>;
export type UpdateOutletStatus = z.infer<typeof updateOutletStatusSchema>;
export type ListOutletsQuery = z.infer<typeof listOutletsQuerySchema>;
export type BulkCreateOutlets = z.infer<typeof bulkCreateOutletsSchema>;
export type SearchOutlets = z.infer<typeof searchOutletsSchema>;
export type StatsQuery = z.infer<typeof statsQuerySchema>;
