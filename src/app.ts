import express from "express";
import { apiKeyAuth } from "./middleware/auth";
import { extractOrgContext } from "./middleware/org-context";
import outletsRouter from "./routes/outlets";
import categoriesRouter from "./routes/categories";
import viewsRouter from "./routes/views";
import internalRouter from "./routes/internal";
import path from "path";
import fs from "fs";

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(apiKeyAuth);
  app.use(extractOrgContext);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "outlets-service" });
  });

  // OpenAPI spec
  app.get("/openapi.json", (_req, res) => {
    const specPath = path.join(__dirname, "..", "openapi.json");
    if (fs.existsSync(specPath)) {
      res.sendFile(specPath);
    } else {
      res.status(404).json({ error: "OpenAPI spec not generated" });
    }
  });

  // View routes (must be before /outlets/:id to avoid path conflicts)
  app.use("/outlets", viewsRouter);

  // CRUD routes
  app.use("/outlets", outletsRouter);
  app.use("/categories", categoriesRouter);

  // Internal routes
  app.use("/internal", internalRouter);

  return app;
}
