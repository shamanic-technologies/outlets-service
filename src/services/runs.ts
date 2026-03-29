import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

export async function createChildRun(
  taskName: string,
  ctx: OrgContext
): Promise<string> {
  const res = await fetch(`${config.runsServiceUrl}/v1/runs`, {
    method: "POST",
    headers: buildServiceHeaders(config.runsServiceApiKey, ctx),
    body: JSON.stringify({
      serviceName: "outlets-service",
      taskName,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`runs-service POST /v1/runs failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function closeRun(
  runId: string,
  status: "completed" | "failed",
  ctx: OrgContext
): Promise<void> {
  const res = await fetch(`${config.runsServiceUrl}/v1/runs/${runId}`, {
    method: "PATCH",
    headers: buildServiceHeaders(config.runsServiceApiKey, ctx),
    body: JSON.stringify({ status }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`runs-service PATCH /v1/runs/${runId} failed (${res.status}): ${body}`);
  }
}
