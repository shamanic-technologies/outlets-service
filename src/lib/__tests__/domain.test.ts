import { describe, it, expect } from "vitest";
import {
  normalizeDomain,
  isValidBareHost,
  normalizeOutletDomain,
  extractHostFromUrl,
  resolveOutletDomain,
} from "../domain";

describe("normalizeDomain", () => {
  it("trims, lowercases, strips leading www.", () => {
    expect(normalizeDomain("  WWW.TechCrunch.COM ")).toBe("techcrunch.com");
    expect(normalizeDomain("Example.org")).toBe("example.org");
  });
});

describe("isValidBareHost", () => {
  it("accepts real bare hosts", () => {
    expect(isValidBareHost("techcrunch.com")).toBe(true);
    expect(isValidBareHost("abc.net.au")).toBe(true);
    expect(isValidBareHost("a-b.co.uk")).toBe(true);
  });

  it("rejects non-host values", () => {
    expect(isValidBareHost("-")).toBe(false);
    expect(isValidBareHost("")).toBe(false);
    expect(isValidBareHost("localhost")).toBe(false); // single label
    expect(isValidBareHost("a.com/section")).toBe(false); // path-bearing
    expect(isValidBareHost("a b.com")).toBe(false); // whitespace
    expect(isValidBareHost("a..com")).toBe(false); // empty label
    expect(isValidBareHost("a.com.")).toBe(false); // trailing dot
    expect(isValidBareHost("a.123")).toBe(false); // numeric TLD
  });
});

describe("normalizeOutletDomain", () => {
  it("returns the normalized host for valid input", () => {
    expect(normalizeOutletDomain("WWW.TechCrunch.com")).toBe("techcrunch.com");
  });

  it("returns null for junk / placeholder / path-bearing / empty / nullish", () => {
    expect(normalizeOutletDomain("-")).toBeNull();
    expect(normalizeOutletDomain("")).toBeNull();
    expect(normalizeOutletDomain("   ")).toBeNull();
    expect(normalizeOutletDomain("a.com/section")).toBeNull();
    expect(normalizeOutletDomain("not a domain")).toBeNull();
    expect(normalizeOutletDomain(null)).toBeNull();
    expect(normalizeOutletDomain(undefined)).toBeNull();
  });
});

describe("extractHostFromUrl", () => {
  it("returns the normalized host", () => {
    expect(extractHostFromUrl("https://www.techcrunch.com/some/path")).toBe("techcrunch.com");
  });
  it("returns null for unparseable input", () => {
    expect(extractHostFromUrl("not a url")).toBeNull();
    expect(extractHostFromUrl(null)).toBeNull();
  });
});

describe("resolveOutletDomain", () => {
  it("prefers a valid explicit domain", () => {
    expect(resolveOutletDomain("techcrunch.com", "https://example.com")).toBe("techcrunch.com");
  });
  it("recovers the real host from the URL when the explicit domain is junk", () => {
    expect(resolveOutletDomain("-", "https://techcrunch.com")).toBe("techcrunch.com");
    expect(resolveOutletDomain("a.com/section", "https://a.com/section")).toBe("a.com");
  });
  it("returns null (no fake fallback) when both are junk", () => {
    expect(resolveOutletDomain("-", "https://-")).toBeNull();
    expect(resolveOutletDomain("-", null)).toBeNull();
  });
});
