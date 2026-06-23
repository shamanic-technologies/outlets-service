import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyEmails } from "../services/apify";
import type { OrgContext } from "../middleware/org-context";

const ctx: OrgContext = {
  orgId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  brandIds: [],
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

describe("verifyEmails", () => {
  it("maps apify results to an email -> status map", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        results: [
          { email: "editor@a.com", status: "valid" },
          { email: "info@b.com", status: "catch_all" },
          { email: "bad@c.com", status: "invalid" },
        ],
      })
    );

    const map = await verifyEmails(["editor@a.com", "info@b.com", "bad@c.com"], ctx);

    expect(map.get("editor@a.com")).toBe("valid");
    expect(map.get("info@b.com")).toBe("catch_all");
    expect(map.get("bad@c.com")).toBe("invalid");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/verify");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ emails: ["editor@a.com", "info@b.com", "bad@c.com"] });
    expect(init.headers["x-org-id"]).toBe(ctx.orgId);
  });

  it("returns an empty map without calling fetch for no emails", async () => {
    const map = await verifyEmails([], ctx);
    expect(map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx response (fail-loud)", async () => {
    fetchMock.mockResolvedValueOnce(errResponse(502, "upstream down"));
    await expect(verifyEmails(["x@y.com"], ctx)).rejects.toThrow(/apify-service \/verify failed \(502\)/);
  });

  it("throws on a request timeout (fail-loud)", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(verifyEmails(["x@y.com"], ctx)).rejects.toThrow(/timed out after 60s/);
  });

  it("throws on a malformed body (no results array)", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ nope: true }));
    await expect(verifyEmails(["x@y.com"], ctx)).rejects.toThrow(/malformed body/);
  });

  it("throws on an unrecognized status literal", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ results: [{ email: "x@y.com", status: "maybe" }] }));
    await expect(verifyEmails(["x@y.com"], ctx)).rejects.toThrow(/unrecognized result row/);
  });

  it("chunks batches larger than 100 across multiple calls", async () => {
    const emails = Array.from({ length: 150 }, (_, i) => `u${i}@x.com`);
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body).emails as string[];
      return okJson({ results: sent.map((email) => ({ email, status: "valid" })) });
    });

    const map = await verifyEmails(emails, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).emails).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).emails).toHaveLength(50);
    expect(map.size).toBe(150);
  });
});
