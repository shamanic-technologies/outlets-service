import { z } from "zod";

// Enums
export const outletStatusEnum = z.enum(["open", "ended", "denied", "served", "skipped"]);

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
  reason: z.string().optional(),
});

export const listOutletsQuerySchema = z.object({
  campaignId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  status: outletStatusEnum.optional(),
  runId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const bulkCreateOutletsSchema = z.object({
  outlets: z.array(createOutletSchema).min(1).max(500),
});

export const searchOutletsSchema = z.object({
  query: z.string().min(1),
  campaignId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
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

export const campaignOutletResponseSchema = outletResponseSchema.extend({
  campaignId: z.string().uuid(),
  brandId: z.string().uuid(),
  whyRelevant: z.string(),
  whyNotRelevant: z.string(),
  relevanceScore: z.number(),
  status: outletStatusEnum,
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

// --- Stats ---

const statsGroupByEnum = z.enum([
  "workflowSlug",
  "featureSlug",
  "brandId",
  "campaignId",
  "workflowDynastySlug",
  "featureDynastySlug",
]);

export const statsQuerySchema = z.object({
  brandId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  workflowSlug: z.string().optional(),
  featureSlug: z.string().optional(),
  workflowDynastySlug: z.string().optional(),
  featureDynastySlug: z.string().optional(),
  groupBy: statsGroupByEnum.optional(),
});

export const statsResponseSchema = z.object({
  outletsDiscovered: z.number(),
  avgRelevanceScore: z.number(),
  searchQueriesUsed: z.number(),
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
      brandId: z.string().uuid(),
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

// Type exports
export type CreateOutlet = z.infer<typeof createOutletSchema>;
export type UpdateOutlet = z.infer<typeof updateOutletSchema>;
export type UpdateOutletStatus = z.infer<typeof updateOutletStatusSchema>;
export type ListOutletsQuery = z.infer<typeof listOutletsQuerySchema>;
export type BulkCreateOutlets = z.infer<typeof bulkCreateOutletsSchema>;
export type SearchOutlets = z.infer<typeof searchOutletsSchema>;
export type StatsQuery = z.infer<typeof statsQuerySchema>;
