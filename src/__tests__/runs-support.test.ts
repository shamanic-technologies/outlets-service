import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createChildRun } from "../services/runs";
import type { OrgContext } from "../middleware/org-context";

const SUPPORT = { kind: "product_feature" as const, reason: "catalogue upkeep" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "run-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body);
}

describe("createChildRun support statement", () => {
  it("marks a ROOT run (no caller run) with the stated support function", async () => {
    const ctx: OrgContext = { orgId: "org-1", brandIds: [] };
    await createChildRun("outlet-price-request-send", ctx, SUPPORT);
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({
      serviceName: "outlets-service",
      taskName: "outlet-price-request-send",
      support: SUPPORT,
    });
  });

  it("never marks a child of a caller run: its cost rides the caller's outcome", async () => {
    const ctx: OrgContext = { orgId: "org-1", brandIds: [], runId: "parent-1" };
    await createChildRun("outlet-price-request-send", ctx, SUPPORT);
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.support).toBeUndefined();
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers["x-run-id"]).toBe("parent-1");
  });

  it("sends no support when none is stated", async () => {
    await createChildRun("discover", { orgId: "org-1", brandIds: [] });
    expect(bodyOf(fetchMock.mock.calls[0]).support).toBeUndefined();
  });
});
