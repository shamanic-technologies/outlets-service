import { Request, Response, NextFunction } from "express";

/**
 * Org context extracted from headers.
 * Only orgId is guaranteed (enforced by requireOrgId middleware).
 * All other headers are optional — used if present, ignored if absent.
 */
export interface OrgContext {
  orgId: string;
  userId?: string;
  runId?: string;
  featureSlug?: string;
  campaignId?: string;
  brandIds: string[];
  workflowSlug?: string;
  audienceId?: string;
}

declare global {
  namespace Express {
    interface Request {
      orgContext?: OrgContext;
    }
  }
}

/**
 * Middleware for /org routes.
 * Requires x-org-id. Parses all other identity headers as optional.
 */
export function requireOrgId(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const orgId = req.headers["x-org-id"] as string | undefined;
  if (!orgId) {
    res.status(400).json({ error: "Missing required header: x-org-id" });
    return;
  }

  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const rawBrandId = req.headers["x-brand-id"] as string | undefined;
  const brandIds = String(rawBrandId ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const audienceId = req.headers["x-audience-id"] as string | undefined;

  req.orgContext = {
    orgId,
    userId: userId || undefined,
    runId: runId || undefined,
    featureSlug: featureSlug || undefined,
    campaignId: campaignId || undefined,
    brandIds,
    workflowSlug: workflowSlug || undefined,
    audienceId: audienceId || undefined,
  };
  next();
}
