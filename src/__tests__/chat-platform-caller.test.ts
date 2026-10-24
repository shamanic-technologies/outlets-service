import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: { chatServiceUrl: "http://chat", chatServiceApiKey: "k" },
}));

import { platformComplete } from "../services/chat";

const REQ = { provider: "google", model: "flash", message: "m", systemPrompt: "s" };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ content: "", tokensInput: 0, tokensOutput: 0, model: "x" }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("platformComplete caller statement", () => {
  it("sends the caller's own run as x-run-id and no support field", async () => {
    await platformComplete(REQ, { runId: "11111111-1111-4111-8111-111111111111" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://chat/internal/platform-complete");
    expect(init.headers["x-run-id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(init.body).support).toBeUndefined();
  });

  it("sends a support declaration in the body and no x-run-id", async () => {
    const support = { kind: "product_feature" as const, reason: "r" };
    await platformComplete(REQ, { support });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["x-run-id"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ ...REQ, support });
  });
});
