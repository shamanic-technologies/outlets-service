import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";

export interface CompleteRequest {
  message: string;
  systemPrompt: string;
  responseFormat?: "json";
  temperature?: number;
  maxTokens?: number;
}

export interface CompleteResponse {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

function buildHeaders(ctx: OrgContext): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": config.chatServiceApiKey,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.featureSlug) h["x-feature-slug"] = ctx.featureSlug;
  if (ctx.campaignId) h["x-campaign-id"] = ctx.campaignId;
  if (ctx.brandId) h["x-brand-id"] = ctx.brandId;
  if (ctx.workflowName) h["x-workflow-name"] = ctx.workflowName;
  return h;
}

export async function chatComplete(
  req: CompleteRequest,
  ctx: OrgContext
): Promise<CompleteResponse> {
  const res = await fetch(`${config.chatServiceUrl}/complete`, {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`chat-service /complete failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<CompleteResponse>;
}
