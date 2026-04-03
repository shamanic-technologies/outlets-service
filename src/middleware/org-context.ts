import { Request, Response, NextFunction } from "express";

/** Base context — only the 3 always-required headers. Workflow headers are optional. */
export interface OrgContext {
  orgId: string;
  userId: string;
  runId: string;
  featureSlug?: string;
  campaignId?: string;
  brandIds: string[];
  workflowSlug?: string;
}

/** Full context — all 7 headers required. Used by write/workflow endpoints. */
export interface FullOrgContext {
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

/**
 * Extracts org context from headers. Only the 3 base headers (x-org-id,
 * x-user-id, x-run-id) are required. The 4 workflow headers are parsed
 * if present but not enforced — use requireFullOrgContext for that.
 */
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
  ].filter(Boolean);

  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required headers: ${missing.join(", ")}` });
    return;
  }

  req.orgContext = {
    orgId: orgId!,
    userId: userId!,
    runId: runId!,
    featureSlug: featureSlug || undefined,
    campaignId: campaignId || undefined,
    brandIds,
    workflowSlug: workflowSlug || undefined,
  };
  next();
}

/**
 * Guard middleware for write/workflow endpoints that require all 7 identity
 * headers. Must be applied AFTER extractOrgContext.
 */
export function requireFullOrgContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const ctx = req.orgContext;
  if (!ctx) {
    res.status(400).json({ error: "Missing org context" });
    return;
  }

  const missing = [
    !ctx.campaignId && "x-campaign-id",
    !ctx.brandIds.length && "x-brand-id",
    !ctx.featureSlug && "x-feature-slug",
    !ctx.workflowSlug && "x-workflow-slug",
  ].filter(Boolean);

  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required headers: ${missing.join(", ")}` });
    return;
  }

  next();
}
