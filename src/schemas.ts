import { z } from "zod";

// Enums
export const outletStatusEnum = z.enum(["open", "ended", "denied"]);
export const categoryScoreEnum = z.enum([
  "city",
  "state_or_province",
  "country",
  "multi-country_region",
  "international",
]);
// --- Outlets ---

export const createOutletSchema = z.object({
  outletName: z.string().min(1),
  outletUrl: z.string().url(),
  outletDomain: z.string().min(1),
  campaignId: z.string().uuid(),
  whyRelevant: z.string(),
  whyNotRelevant: z.string(),
  relevanceScore: z.number().min(0).max(100),
  overalRelevance: z.string().optional(),
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
  overalRelevance: z.string().optional(),
  relevanceRationale: z.string().optional(),
});

export const updateOutletStatusSchema = z.object({
  status: outletStatusEnum,
  reason: z.string().optional(),
});

export const listOutletsQuerySchema = z.object({
  campaignId: z.string().uuid().optional(),
  status: outletStatusEnum.optional(),
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

export const byIdsQuerySchema = z.object({
  ids: z.string().min(1),
});

// --- Categories ---

export const createCategorySchema = z.object({
  campaignId: z.string().uuid(),
  categoryName: z.string().min(1),
  scope: categoryScoreEnum.optional(),
  region: z.string().optional(),
  exampleOutlets: z.string().optional(),
  whyRelevant: z.string().default(""),
  whyNotRelevant: z.string().default(""),
  relevanceScore: z.number().min(0).max(100).default(0),
});

export const updateCategorySchema = z.object({
  categoryName: z.string().min(1).optional(),
  scope: categoryScoreEnum.optional(),
  region: z.string().nullable().optional(),
  exampleOutlets: z.string().nullable().optional(),
  whyRelevant: z.string().optional(),
  whyNotRelevant: z.string().optional(),
  relevanceScore: z.number().min(0).max(100).optional(),
});

export const listCategoriesQuerySchema = z.object({
  campaignId: z.string().uuid(),
});

// --- Response schemas ---

export const outletResponseSchema = z.object({
  id: z.string().uuid(),
  outletName: z.string(),
  outletUrl: z.string(),
  outletDomain: z.string(),
  status: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const campaignOutletResponseSchema = outletResponseSchema.extend({
  campaignId: z.string().uuid(),
  whyRelevant: z.string(),
  whyNotRelevant: z.string(),
  relevanceScore: z.number(),
  outletStatus: outletStatusEnum,
  overalRelevance: z.string().nullable(),
  relevanceRationale: z.string().nullable(),
});

export const categoryResponseSchema = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  categoryName: z.string(),
  scope: categoryScoreEnum.nullable(),
  region: z.string().nullable(),
  exampleOutlets: z.string().nullable(),
  whyRelevant: z.string(),
  whyNotRelevant: z.string(),
  relevanceScore: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const healthResponseSchema = z.object({
  status: z.string(),
  service: z.string(),
});

export const errorResponseSchema = z.object({
  error: z.string(),
});

// Type exports
export type CreateOutlet = z.infer<typeof createOutletSchema>;
export type UpdateOutlet = z.infer<typeof updateOutletSchema>;
export type UpdateOutletStatus = z.infer<typeof updateOutletStatusSchema>;
export type ListOutletsQuery = z.infer<typeof listOutletsQuerySchema>;
export type BulkCreateOutlets = z.infer<typeof bulkCreateOutletsSchema>;
export type SearchOutlets = z.infer<typeof searchOutletsSchema>;
export type CreateCategory = z.infer<typeof createCategorySchema>;
export type UpdateCategory = z.infer<typeof updateCategorySchema>;
