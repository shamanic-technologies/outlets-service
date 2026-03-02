import { Request, Response, NextFunction } from "express";

export interface OrgContext {
  orgId: string;
  userId: string;
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

  if (!orgId || !userId) {
    res.status(400).json({ error: "x-org-id and x-user-id headers are required" });
    return;
  }

  req.orgContext = { orgId, userId };
  next();
}
