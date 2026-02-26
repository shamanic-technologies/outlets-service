import { Request, Response, NextFunction } from "express";

export interface OrgContext {
  orgId: string | undefined;
  userId: string | undefined;
}

declare global {
  namespace Express {
    interface Request {
      orgContext?: OrgContext;
    }
  }
}

export function extractOrgContext(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  req.orgContext = {
    orgId: req.headers["x-org-id"] as string | undefined,
    userId: req.headers["x-user-id"] as string | undefined,
  };
  next();
}
