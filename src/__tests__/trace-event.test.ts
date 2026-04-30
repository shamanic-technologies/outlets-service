import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MOCK_RUNS_URL = "https://runs.test";
const MOCK_RUNS_KEY = "sk-runs-test";

// Mock config before importing traceEvent
vi.mock("../config", () => ({
  config: {
    runsServiceUrl: "https://runs.test",
    runsServiceApiKey: "sk-runs-test",
  },
}));

const { traceEvent } = await import("../lib/trace-event");

describe("traceEvent", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the correct URL with the correct body", async () => {
    await traceEvent(
      "run-123",
      { service: "outlets-service", event: "discover-start", detail: "test detail", level: "info", data: { count: 5 } },
      {}
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MOCK_RUNS_URL}/v1/runs/run-123/events`);
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      service: "outlets-service",
      event: "discover-start",
      detail: "test detail",
      level: "info",
      data: { count: 5 },
    });
  });

  it("forwards all identity headers when present", async () => {
    const headers: Record<string, string | string[] | undefined> = {
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-brand-id": "brand-1,brand-2",
      "x-campaign-id": "camp-1",
      "x-workflow-slug": "discover",
      "x-feature-slug": "outlets",
      "host": "localhost",
    };

    await traceEvent("run-123", { service: "outlets-service", event: "test" }, headers);

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentHeaders = opts.headers as Record<string, string>;
    expect(sentHeaders["x-api-key"]).toBe(MOCK_RUNS_KEY);
    expect(sentHeaders["x-org-id"]).toBe("org-1");
    expect(sentHeaders["x-user-id"]).toBe("user-1");
    expect(sentHeaders["x-brand-id"]).toBe("brand-1,brand-2");
    expect(sentHeaders["x-campaign-id"]).toBe("camp-1");
    expect(sentHeaders["x-workflow-slug"]).toBe("discover");
    expect(sentHeaders["x-feature-slug"]).toBe("outlets");
    expect(sentHeaders).not.toHaveProperty("host");
  });

  it("omits identity headers that are not present", async () => {
    await traceEvent("run-123", { service: "outlets-service", event: "test" }, { "x-org-id": "org-1" });

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentHeaders = opts.headers as Record<string, string>;
    expect(sentHeaders["x-api-key"]).toBe(MOCK_RUNS_KEY);
    expect(sentHeaders["x-org-id"]).toBe("org-1");
    expect(sentHeaders).not.toHaveProperty("x-user-id");
    expect(sentHeaders).not.toHaveProperty("x-brand-id");
    expect(sentHeaders).not.toHaveProperty("x-campaign-id");
    expect(sentHeaders).not.toHaveProperty("x-workflow-slug");
    expect(sentHeaders).not.toHaveProperty("x-feature-slug");
  });

  it("never throws on fetch failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));

    await expect(
      traceEvent("run-123", { service: "outlets-service", event: "test" }, {})
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("never throws on non-ok response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("bad", { status: 500 }));

    await expect(
      traceEvent("run-123", { service: "outlets-service", event: "test" }, {})
    ).resolves.toBeUndefined();

    // Should not throw — fire and forget
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("traceEvent with missing config", () => {
  it("silently returns and logs error if runsServiceUrl is empty", async () => {
    vi.resetModules();
    vi.doMock("../config", () => ({
      config: { runsServiceUrl: "", runsServiceApiKey: "sk-test" },
    }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { traceEvent: traceNoUrl } = await import("../lib/trace-event");
    await traceNoUrl("run-1", { service: "outlets-service", event: "test" }, {});

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });
});
