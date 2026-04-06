import { Request, Response, NextFunction } from "express";
import { config } from "../config";

if (!config.apiKey) {
  throw new Error(
    "[outlets-service] FATAL: OUTLETS_SERVICE_API_KEY is not set. Refusing to start without API key authentication."
  );
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"];
  if (key !== config.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
