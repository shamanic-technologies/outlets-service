import { describe, it, expect, vi, beforeEach } from "vitest";

const mockChat = vi.fn();
vi.mock("../services/chat", () => ({
  chatComplete: (...args: unknown[]) => mockChat(...args),
}));

import { categorizeEditorialEmails, pickContactUrls } from "../services/editorial-categorize";
import type { OrgContext } from "../middleware/org-context";

const ctx: OrgContext = { orgId: "org-1", brandIds: [] };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("categorizeEditorialEmails", () => {
  it("keeps LLM-approved editorial addresses, in the returned order", async () => {
    mockChat.mockResolvedValue({
      json: {
        kept: [
          { email: "redacao@g1.globo.com", category: "editorial" },
          { email: "contato@g1.globo.com", category: "generic" },
        ],
      },
    });

    const out = await categorizeEditorialEmails(
      "GloboNews",
      "g1.globo.com",
      ["cobertura-ao-vivo-frontend@apps.globoid", "redacao@g1.globo.com", "contato@g1.globo.com"],
      ctx
    );

    expect(out).toEqual([
      { email: "redacao@g1.globo.com", category: "editorial" },
      { email: "contato@g1.globo.com", category: "generic" },
    ]);
    // the junk token was passed in but never returned
    expect(out.map((e) => e.email)).not.toContain("cobertura-ao-vivo-frontend@apps.globoid");
  });

  it("drops a hallucinated address the LLM invented (not in the candidate set)", async () => {
    mockChat.mockResolvedValue({
      json: {
        kept: [
          { email: "editor@outlet.com", category: "named" }, // in candidates
          { email: "made-up@outlet.com", category: "editorial" }, // NOT in candidates
        ],
      },
    });

    const out = await categorizeEditorialEmails("Outlet", "outlet.com", ["editor@outlet.com"], ctx);

    expect(out).toEqual([{ email: "editor@outlet.com", category: "named" }]);
  });

  it("returns [] without calling the LLM for empty candidates", async () => {
    const out = await categorizeEditorialEmails("Outlet", "outlet.com", [], ctx);
    expect(out).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it("dedupes and lowercases", async () => {
    mockChat.mockResolvedValue({
      json: { kept: [{ email: "Press@Outlet.com", category: "press" }, { email: "press@outlet.com", category: "press" }] },
    });
    const out = await categorizeEditorialEmails("Outlet", "outlet.com", ["press@outlet.com"], ctx);
    expect(out).toEqual([{ email: "press@outlet.com", category: "press" }]);
  });

  it("propagates a chat-service failure (fail-loud)", async () => {
    mockChat.mockRejectedValue(new Error("chat-service /complete failed (502)"));
    await expect(
      categorizeEditorialEmails("Outlet", "outlet.com", ["a@outlet.com"], ctx)
    ).rejects.toThrow(/chat-service/);
  });
});

describe("pickContactUrls", () => {
  it("returns only URLs from the input list, capped at 3", async () => {
    mockChat.mockResolvedValue({
      json: {
        urls: [
          "https://outlet.com/imprensa",
          "https://outlet.com/contato",
          "https://outlet.com/about",
          "https://outlet.com/team",
        ],
      },
    });
    const urls = [
      "https://outlet.com/article-1",
      "https://outlet.com/imprensa",
      "https://outlet.com/contato",
      "https://outlet.com/about",
      "https://outlet.com/team",
    ];
    const out = await pickContactUrls("Outlet", "outlet.com", urls, ctx, 3);
    expect(out).toEqual([
      "https://outlet.com/imprensa",
      "https://outlet.com/contato",
      "https://outlet.com/about",
    ]);
  });

  it("drops a URL the LLM invented (not in the sitemap input)", async () => {
    mockChat.mockResolvedValue({
      json: { urls: ["https://outlet.com/ghost", "https://outlet.com/contato"] },
    });
    const out = await pickContactUrls("Outlet", "outlet.com", ["https://outlet.com/contato"], ctx);
    expect(out).toEqual(["https://outlet.com/contato"]);
  });

  it("returns [] without calling the LLM for empty input", async () => {
    const out = await pickContactUrls("Outlet", "outlet.com", [], ctx);
    expect(out).toEqual([]);
    expect(mockChat).not.toHaveBeenCalled();
  });
});
