import { config } from "../config";

const IDENTITY_HEADERS = [
  "x-org-id",
  "x-user-id",
  "x-brand-id",
  "x-campaign-id",
  "x-workflow-slug",
  "x-feature-slug",
] as const;

export async function traceEvent(
  runId: string,
  payload: {
    service: string;
    event: string;
    detail?: string;
    level?: "info" | "warn" | "error";
    data?: Record<string, unknown>;
  },
  headers: Record<string, string | string[] | undefined>
): Promise<void> {
  if (!config.runsServiceUrl || !config.runsServiceApiKey) {
    console.error("[outlets-service] traceEvent: RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
    return;
  }

  try {
    const fwdHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": config.runsServiceApiKey,
    };

    for (const key of IDENTITY_HEADERS) {
      const value = headers[key];
      if (value) {
        fwdHeaders[key] = Array.isArray(value) ? value.join(",") : value;
      }
    }

    await fetch(`${config.runsServiceUrl}/v1/runs/${runId}/events`, {
      method: "POST",
      headers: fwdHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error("[outlets-service] traceEvent failed:", err instanceof Error ? err.message : err);
  }
}
