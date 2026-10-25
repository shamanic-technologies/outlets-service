import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";
import type { SupportKind } from "./chat";

/**
 * Open a run for this service's work. With a caller run (`ctx.runId`) it is that
 * run's child and its cost rides the caller's outcome: never marked. Without one
 * it is a ROOT, and `supportWhenRoot` states the support function it serves
 * (runs-service body `support`, marked in the same transaction), so its subtree's
 * spend never lands undeclared on this service.
 */
export async function createChildRun(
  taskName: string,
  ctx: OrgContext,
  supportWhenRoot?: { kind: SupportKind; reason: string }
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${config.runsServiceUrl}/v1/runs`, {
      method: "POST",
      headers: buildServiceHeaders(config.runsServiceApiKey, ctx),
      body: JSON.stringify({
        serviceName: "outlets-service",
        taskName,
        ...(supportWhenRoot && !ctx.runId ? { support: supportWhenRoot } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] runs-service POST /v1/runs timed out after 30s`);
    }
    throw new Error(`[outlets-service] runs-service POST /v1/runs fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] runs-service POST /v1/runs failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

export interface RunCost {
  runId: string;
  totalCostInUsdCents: number;
  actualCostInUsdCents: number;
  provisionedCostInUsdCents: number;
}

export async function batchRunCosts(
  runIds: string[],
  ctx: OrgContext
): Promise<RunCost[]> {
  if (runIds.length === 0) return [];

  let res: Response;
  try {
    res = await fetch(`${config.runsServiceUrl}/v1/runs/costs/batch`, {
      method: "POST",
      headers: buildServiceHeaders(config.runsServiceApiKey, ctx),
      body: JSON.stringify({ runIds }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] runs-service POST /v1/runs/costs/batch timed out after 30s`);
    }
    throw new Error(`[outlets-service] runs-service POST /v1/runs/costs/batch fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] runs-service POST /v1/runs/costs/batch failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    costs: Array<{
      runId: string;
      totalCostInUsdCents: string;
      actualCostInUsdCents: string;
      provisionedCostInUsdCents: string;
    }>;
  };

  return data.costs.map((c) => ({
    runId: c.runId,
    totalCostInUsdCents: Number(c.totalCostInUsdCents),
    actualCostInUsdCents: Number(c.actualCostInUsdCents),
    provisionedCostInUsdCents: Number(c.provisionedCostInUsdCents),
  }));
}

export async function closeRun(
  runId: string,
  status: "completed" | "failed",
  ctx: OrgContext
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${config.runsServiceUrl}/v1/runs/${runId}`, {
      method: "PATCH",
      headers: buildServiceHeaders(config.runsServiceApiKey, ctx),
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] runs-service PATCH /v1/runs/${runId} timed out after 30s`);
    }
    throw new Error(`[outlets-service] runs-service PATCH /v1/runs/${runId} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] runs-service PATCH /v1/runs/${runId} failed (${res.status}): ${body}`);
  }
}
