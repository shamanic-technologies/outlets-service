import { Request, Response, NextFunction } from "express";

export interface OrgContext {
  orgId: string;
  userId: string;
  runId: string;
  featureSlug: string;
  campaignId: string;
  brandIds: string[];
  workflowSlug: string;
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
  const rawBrandId = req.headers["x-brand-id"] as string | undefined;
  const brandIds = String(rawBrandId ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;

  const missing = [
    !orgId && "x-org-id",
    !userId && "x-user-id",
    !runId && "x-run-id",
    !campaignId && "x-campaign-id",
    !rawBrandId && "x-brand-id",
    !featureSlug && "x-feature-slug",
    !workflowSlug && "x-workflow-slug",
  ].filter(Boolean);

  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required headers: ${missing.join(", ")}` });
    return;
  }

  req.orgContext = { orgId: orgId!, userId: userId!, runId: runId!, featureSlug: featureSlug!, campaignId: campaignId!, brandIds, workflowSlug: workflowSlug! };
  next();
}
