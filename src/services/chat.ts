import { config } from "../config";
import type { OrgContext } from "../middleware/org-context";
import { buildServiceHeaders } from "./headers";

const CHAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — LLM calls with thinking can be slow

export interface CompleteRequest {
  provider: string;
  model: string;
  message: string;
  systemPrompt: string;
  responseFormat?: "json";
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
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
  const start = Date.now();
  console.log(`[outlets-service] chatComplete: calling chat-service model=${req.model} provider=${req.provider} maxTokens=${req.maxTokens ?? "default"} thinkingBudget=${req.thinkingBudget ?? "none"}`);

  let res: Response;
  try {
    res = await fetch(`${config.chatServiceUrl}/complete`, {
      method: "POST",
      headers: buildServiceHeaders(config.chatServiceApiKey, ctx),
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] chat-service /complete timed out after ${elapsed}ms (limit=${CHAT_TIMEOUT_MS}ms, model=${req.model}, provider=${req.provider})`);
    }
    throw new Error(`[outlets-service] chat-service /complete fetch failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
  }

  const elapsed = Date.now() - start;

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] chat-service /complete failed (${res.status}) after ${elapsed}ms: ${body}`);
  }

  console.log(`[outlets-service] chatComplete: completed in ${elapsed}ms model=${req.model}`);
  return res.json() as Promise<CompleteResponse>;
}

export interface PlatformCompleteRequest {
  provider: string;
  model: string;
  message: string;
  systemPrompt: string;
  responseFormat?: "json";
  responseSchema?: Record<string, unknown>;
  temperature?: number;
}

/**
 * Org-less platform LLM completion. Hits chat-service /internal/platform-complete,
 * which creates its OWN platform run and declares token (+ search) cost on it,
 * failing loud (502) if the cost can't be tracked. So outlets-service does NOT
 * declare any cost here — it just forwards the call with the platform api-key
 * (no org/user/run identity headers).
 */
export async function platformComplete(
  req: PlatformCompleteRequest
): Promise<CompleteResponse> {
  const start = Date.now();
  console.log(`[outlets-service] platformComplete: calling chat-service model=${req.model} provider=${req.provider}`);

  let res: Response;
  try {
    res = await fetch(`${config.chatServiceUrl}/internal/platform-complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.chatServiceApiKey,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`[outlets-service] chat-service /internal/platform-complete timed out after ${elapsed}ms (limit=${CHAT_TIMEOUT_MS}ms, model=${req.model}, provider=${req.provider})`);
    }
    throw new Error(`[outlets-service] chat-service /internal/platform-complete fetch failed after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
  }

  const elapsed = Date.now() - start;

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[outlets-service] chat-service /internal/platform-complete failed (${res.status}) after ${elapsed}ms: ${body}`);
  }

  console.log(`[outlets-service] platformComplete: completed in ${elapsed}ms model=${req.model}`);
  return res.json() as Promise<CompleteResponse>;
}
