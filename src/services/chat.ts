import { config } from "../config";

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

export async function chatComplete(
  req: CompleteRequest,
  headers: { orgId: string; userId: string; runId: string }
): Promise<CompleteResponse> {
  const res = await fetch(`${config.chatServiceUrl}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.chatServiceApiKey,
      "x-org-id": headers.orgId,
      "x-user-id": headers.userId,
      "x-run-id": headers.runId,
    },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`chat-service /complete failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<CompleteResponse>;
}
