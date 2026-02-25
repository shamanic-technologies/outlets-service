import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { validateBody, validateQuery } from "../middleware/validate";
import {
  createCategorySchema,
  updateCategorySchema,
  updateOutletStatusSchema,
  listCategoriesQuerySchema,
} from "../schemas";

const router = Router();

// POST /categories
router.post(
  "/",
  validateBody(createCategorySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const b = req.body;
      const result = await pool.query(
        `INSERT INTO press_categories (campaign_id, category_name, scope, region, example_outlets, why_relevant, why_not_relevant, relevance_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [b.campaignId, b.categoryName, b.scope || null, b.region || null, b.exampleOutlets || null, b.whyRelevant, b.whyNotRelevant, b.relevanceScore]
      );

      const r = result.rows[0];
      res.status(201).json({
        id: r.id,
        campaignId: r.campaign_id,
        categoryName: r.category_name,
        scope: r.scope,
        region: r.region,
        exampleOutlets: r.example_outlets,
        whyRelevant: r.why_relevant,
        whyNotRelevant: r.why_not_relevant,
        relevanceScore: Number(r.relevance_score),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    } catch (err) {
      console.error("Error creating category:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /categories
router.get(
  "/",
  validateQuery(listCategoriesQuerySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { campaignId } = req.query as any;
      const result = await pool.query(
        `SELECT * FROM press_categories WHERE campaign_id = $1 ORDER BY created_at DESC`,
        [campaignId]
      );

      res.json({
        categories: result.rows.map((r: any) => ({
          id: r.id,
          campaignId: r.campaign_id,
          categoryName: r.category_name,
          scope: r.scope,
          region: r.region,
          exampleOutlets: r.example_outlets,
          whyRelevant: r.why_relevant,
          whyNotRelevant: r.why_not_relevant,
          relevanceScore: Number(r.relevance_score),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      });
    } catch (err) {
      console.error("Error listing categories:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PATCH /categories/:id
router.patch(
  "/:id",
  validateBody(updateCategorySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const b = req.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (b.categoryName !== undefined) { sets.push(`category_name = $${idx++}`); params.push(b.categoryName); }
      if (b.scope !== undefined) { sets.push(`scope = $${idx++}`); params.push(b.scope); }
      if (b.region !== undefined) { sets.push(`region = $${idx++}`); params.push(b.region); }
      if (b.exampleOutlets !== undefined) { sets.push(`example_outlets = $${idx++}`); params.push(b.exampleOutlets); }
      if (b.whyRelevant !== undefined) { sets.push(`why_relevant = $${idx++}`); params.push(b.whyRelevant); }
      if (b.whyNotRelevant !== undefined) { sets.push(`why_not_relevant = $${idx++}`); params.push(b.whyNotRelevant); }
      if (b.relevanceScore !== undefined) { sets.push(`relevance_score = $${idx++}`); params.push(b.relevanceScore); }

      if (sets.length === 0) {
        res.status(400).json({ error: "No fields to update" });
        return;
      }

      sets.push(`updated_at = CURRENT_TIMESTAMP`);
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE press_categories SET ${sets.join(", ")} WHERE id = $${idx}
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Category not found" });
        return;
      }

      const r = result.rows[0];
      res.json({
        id: r.id,
        campaignId: r.campaign_id,
        categoryName: r.category_name,
        scope: r.scope,
        region: r.region,
        exampleOutlets: r.example_outlets,
        whyRelevant: r.why_relevant,
        whyNotRelevant: r.why_not_relevant,
        relevanceScore: Number(r.relevance_score),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    } catch (err) {
      console.error("Error updating category:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// PATCH /categories/:id/status — not a standard field, but we can update relevance_score as a proxy
router.patch(
  "/:id/status",
  validateBody(updateCategorySchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const b = req.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (b.relevanceScore !== undefined) { sets.push(`relevance_score = $${idx++}`); params.push(b.relevanceScore); }
      if (b.whyRelevant !== undefined) { sets.push(`why_relevant = $${idx++}`); params.push(b.whyRelevant); }
      if (b.whyNotRelevant !== undefined) { sets.push(`why_not_relevant = $${idx++}`); params.push(b.whyNotRelevant); }

      if (sets.length === 0) {
        res.status(400).json({ error: "No fields to update" });
        return;
      }

      sets.push(`updated_at = CURRENT_TIMESTAMP`);
      params.push(req.params.id);

      const result = await pool.query(
        `UPDATE press_categories SET ${sets.join(", ")} WHERE id = $${idx}
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: "Category not found" });
        return;
      }

      const r = result.rows[0];
      res.json({
        id: r.id,
        campaignId: r.campaign_id,
        categoryName: r.category_name,
        relevanceScore: Number(r.relevance_score),
        updatedAt: r.updated_at,
      });
    } catch (err) {
      console.error("Error updating category status:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
