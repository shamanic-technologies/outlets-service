import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getDrStatus,
  getDrStatusForEnrich,
  getTrafficForEnrich,
  triggerDrCompute,
  triggerInternalDrCompute,
} from "../services/ahref";
import type { OrgContext } from "../middleware/org-context";

const ctx: OrgContext = {
  orgId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  brandIds: ["55555555-5555-5555-5555-555555555555"],
  runId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

describe("getDrStatus", () => {
  it("maps domains to latestValidDr (null preserved)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson([
        { domain: "techcrunch.com", latestValidDr: 93, needsUpdate: false },
        { domain: "newpaper.com", latestValidDr: null, needsUpdate: true },
      ])
    );

    const map = await getDrStatus(["techcrunch.com", "newpaper.com"], ctx);

    expect(map.get("techcrunch.com")).toBe(93);
    expect(map.get("newpaper.com")).toBeNull();

    // GET dr-status with comma-separated domains + org headers
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/orgs/domains/dr-status?");
    expect(decodeURIComponent(url as string)).toContain("domains=techcrunch.com,newpaper.com");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as any).headers["x-org-id"]).toBe(ctx.orgId);
  });

  it("does not fetch for empty input", async () => {
    const map = await getDrStatus([], ctx);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("chunks large domain lists to keep dr-status URLs bounded", async () => {
    const domains = Array.from(
      { length: 240 },
      (_, i) => `long-domain-${String(i).padStart(3, "0")}-${"a".repeat(40)}.example.com`
    );
    fetchMock.mockImplementation(async (url: string) => {
      const encodedDomains = url.split("domains=")[1] ?? "";
      const chunkDomains = decodeURIComponent(encodedDomains).split(",").filter(Boolean);
      return okJson(chunkDomains.map((domain) => ({ domain, latestValidDr: 42 })));
    });

    const map = await getDrStatus(domains, ctx);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(map.size).toBe(domains.length);
    expect(map.get(domains[0])).toBe(42);
    expect(map.get(domains[domains.length - 1])).toBe(42);
    for (const [url] of fetchMock.mock.calls) {
      expect((url as string).length).toBeLessThanOrEqual(6_000);
    }
  });

  it("throws on non-2xx (fail-loud)", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(503, "down"));
    await expect(getDrStatus(["x.com"], ctx)).rejects.toThrow(/dr-status failed \(503\)/);
  });
});

describe("getTrafficForEnrich", () => {
  it("maps domains to trafficMonthlyAvg (null preserved)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson([
        { domain: "citywire.com", trafficMonthlyAvg: 31800, hasData: true },
        { domain: "newpaper.com", trafficMonthlyAvg: null, hasData: false },
      ])
    );

    const map = await getTrafficForEnrich(["citywire.com", "newpaper.com"], ctx);

    expect(map.get("citywire.com")).toBe(31800);
    expect(map.get("newpaper.com")).toBeNull();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/orgs/domains/traffic-history?");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as any).headers["x-org-id"]).toBe(ctx.orgId);
  });

  it("does not fetch for empty input", async () => {
    const map = await getTrafficForEnrich([], ctx);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tolerates a failed chunk (those domains absent, never throws)", async () => {
    // Wide list forces multiple URL-bounded chunks; fail exactly one of them.
    const domains = Array.from(
      { length: 240 },
      (_, i) => `long-domain-${String(i).padStart(3, "0")}-${"a".repeat(40)}.example.com`
    );
    let call = 0;
    fetchMock.mockImplementation(async (url: string) => {
      call += 1;
      if (call === 1) return errResponse(503, "down");
      const encodedDomains = url.split("domains=")[1] ?? "";
      const chunkDomains = decodeURIComponent(encodedDomains).split(",").filter(Boolean);
      return okJson(chunkDomains.map((domain) => ({ domain, trafficMonthlyAvg: 100 })));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const map = await getTrafficForEnrich(domains, ctx);

    // Some domains resolved from the surviving chunks; the failed chunk's domains are absent.
    expect(map.size).toBeGreaterThan(0);
    expect(map.size).toBeLessThan(domains.length);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("getDrStatusForEnrich", () => {
  it("maps domains to latestValidDr and never throws on total outage", async () => {
    fetchMock.mockResolvedValue(errResponse(503, "down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const map = await getDrStatusForEnrich(["citywire.com"], ctx);

    expect(map.size).toBe(0); // all chunks failed → empty map → caller serves null
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("triggerDrCompute", () => {
  it("POSTs { domains } to dr-compute", async () => {
    fetchMock.mockResolvedValueOnce(okJson([{ domain: "x.com", latestValidDr: null, needsUpdate: true }]));

    await triggerDrCompute(["x.com", "y.com"], ctx);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/orgs/domains/dr-compute");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ domains: ["x.com", "y.com"] });
  });

  it("does not fetch for empty input", async () => {
    await triggerDrCompute([], ctx);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on non-2xx (fail-loud)", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(502, "apify failed"));
    await expect(triggerDrCompute(["x.com"], ctx)).rejects.toThrow(/dr-compute failed \(502\)/);
  });
});

describe("triggerInternalDrCompute", () => {
  it("POSTs { domains } to internal dr-compute with service auth only", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ requested: 2, queued: 1 }));

    await triggerInternalDrCompute(["x.com", "y.com"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/internal/domains/dr-compute");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ domains: ["x.com", "y.com"] });
    expect((init as any).headers["x-api-key"]).toBeDefined();
    expect((init as any).headers["x-org-id"]).toBeUndefined();
    expect((init as any).headers["x-user-id"]).toBeUndefined();
  });

  it("does not fetch for empty input", async () => {
    await triggerInternalDrCompute([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on non-2xx (fail-loud)", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(502, "platform run failed"));
    await expect(triggerInternalDrCompute(["x.com"])).rejects.toThrow(/internal\/domains\/dr-compute failed \(502\)/);
  });
});
