import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

export interface CompleteRequest {
  provider: string;
  model: string;
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

export async function chatComplete(
  req: CompleteRequest,
  ctx: OrgContext
): Promise<CompleteResponse> {
  const res = await fetch(`${config.chatServiceUrl}/complete`, {
    method: "POST",
    headers: buildServiceHeaders(config.chatServiceApiKey, ctx),
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`chat-service /complete failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<CompleteResponse>;
}
