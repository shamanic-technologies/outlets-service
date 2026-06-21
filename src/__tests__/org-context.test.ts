import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireOrgId } from "../middleware/org-context";

function run(headers: Record<string, string | undefined>) {
  const req = { headers } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  requireOrgId(req, res, next);
  return { req, res, next };
}

describe("requireOrgId", () => {
  it("parses x-audience-id into orgContext (cost attribution)", () => {
    const { req, next } = run({
      "x-org-id": "org-1",
      "x-run-id": "run-1",
      "x-audience-id": "aud-9",
    });
    expect(next).toHaveBeenCalledOnce();
    expect(req.orgContext?.audienceId).toBe("aud-9");
    expect(req.orgContext?.runId).toBe("run-1");
  });

  it("leaves audienceId undefined when header absent", () => {
    const { req } = run({ "x-org-id": "org-1" });
    expect(req.orgContext?.audienceId).toBeUndefined();
  });

  it("400s without x-org-id", () => {
    const { res, next } = run({ "x-audience-id": "aud-9" });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
