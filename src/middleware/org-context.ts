import { Request, Response, NextFunction } from "express";

export interface OrgContext {
  orgId: string;
  userId: string;
  runId: string;
  featureSlug?: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
}

declare global {
  namespace Express {
    interface Request {
      orgContext?: OrgContext;
    }
  }
}

const EXEMPT_PATHS = ["/health", "/openapi.json"];

export function extractOrgContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (EXEMPT_PATHS.includes(req.path)) {
    return next();
  }

  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const brandId = req.headers["x-brand-id"] as string | undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;

  if (!orgId || !userId || !runId) {
    res.status(400).json({ error: "x-org-id, x-user-id, and x-run-id headers are required" });
    return;
  }

  req.orgContext = { orgId, userId, runId, featureSlug, campaignId, brandId, workflowSlug };
  next();
}
