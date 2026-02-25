import { Request, Response, NextFunction } from "express";
import { config } from "../config";

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health" || req.path === "/openapi.json") {
    return next();
  }

  const key = req.headers["x-api-key"];
  if (!config.apiKey) {
    return next();
  }
  if (key !== config.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
