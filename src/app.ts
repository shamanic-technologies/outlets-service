import express from "express";
import { apiKeyAuth } from "./middleware/auth";
import { requireOrgId } from "./middleware/org-context";
import outletsRouter from "./routes/outlets";
import internalRouter from "./routes/internal";
import bufferRouter from "./routes/buffer";
import statsRouter from "./routes/stats";
import discoverRouter from "./routes/discover";
import path from "path";
import fs from "fs";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // Public routes — no auth
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "outlets-service" });
  });

  app.get("/openapi.json", (_req, res) => {
    const specPath = path.join(__dirname, "..", "openapi.json");
    if (fs.existsSync(specPath)) {
      res.sendFile(specPath);
    } else {
      res.status(404).json({ error: "OpenAPI spec not generated" });
    }
  });

  // All remaining routes require API key
  app.use(apiKeyAuth);

  // Internal routes — API key only, no org context
  app.use("/internal", internalRouter);

  // Org routes — API key + x-org-id required
  app.use("/org", requireOrgId);

  // Stats route (must be before /org/outlets/:id to avoid path conflicts)
  app.use("/org/outlets", statsRouter);

  // Discover route (must be before /org/outlets/:id to avoid path conflicts)
  app.use("/org/outlets", discoverRouter);

  // Buffer route
  app.use("/org/buffer", bufferRouter);

  // CRUD routes
  app.use("/org/outlets", outletsRouter);

  return app;
}
