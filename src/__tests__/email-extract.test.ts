import { describe, it, expect } from "vitest";
import {
  extractEmails,
  decodeCfemail,
  scoreEmail,
  roleOf,
  isLander,
  rootDomain,
} from "../lib/email-extract";

// Encode an email as a Cloudflare cfemail hex string (first byte = XOR key).
function encodeCf(email: string, key: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  let out = hex(key);
  for (const ch of email) out += hex(ch.charCodeAt(0) ^ key);
  return out;
}

describe("extractEmails", () => {
  it("extracts, lowercases, strips trailing dot and dedupes", () => {
    const html = `<a href="mailto:Editor@Foo.com">Editor@Foo.com.</a> also editor@foo.com`;
    expect(extractEmails(html)).toEqual(["editor@foo.com"]);
  });

  it("drops asset-like matches and junk domains", () => {
    const html = `logo@2x.png hi@example.com track@sentry.io real@outlet.com`;
    expect(extractEmails(html)).toEqual(["real@outlet.com"]);
  });

  it("drops hash-like local parts and over-long / double-dot addresses", () => {
    const html = `deadbeefdeadbeef00@cdn.net a..b@x.com good@news.com`;
    expect(extractEmails(html)).toEqual(["good@news.com"]);
  });

  it("decodes a Cloudflare data-cfemail attribute", () => {
    const hex = encodeCf("press@outlet.com", 0x2b);
    const html = `<a class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</a>`;
    expect(extractEmails(html)).toContain("press@outlet.com");
  });

  it("decodes a /cdn-cgi/l/email-protection link", () => {
    const hex = encodeCf("news@outlet.com", 0x55);
    const html = `<a href="/cdn-cgi/l/email-protection#${hex}">email</a>`;
    expect(extractEmails(html)).toContain("news@outlet.com");
  });
});

describe("decodeCfemail", () => {
  it("round-trips an encoded email", () => {
    const email = "editorial@citywealthmag.com";
    expect(decodeCfemail(encodeCf(email, 0x4f))).toBe(email);
  });

  it("returns null on malformed hex", () => {
    expect(decodeCfemail("a")).toBeNull();
    expect(decodeCfemail("")).toBeNull();
  });
});

describe("scoreEmail", () => {
  it("orders editorial buckets before named persons before generic inboxes", () => {
    const editorial = scoreEmail("editorial@x.com");
    const press = scoreEmail("press@x.com");
    const named = scoreEmail("jane.doe@x.com");
    const generic = scoreEmail("info@x.com");
    expect(editorial).toBeLessThan(press);
    expect(press).toBeLessThan(named);
    expect(named).toBeLessThan(generic);
  });
});

describe("roleOf", () => {
  it("buckets editorial, named and generic", () => {
    expect(roleOf("editor@x.com")).toBe("editor");
    expect(roleOf("jane@x.com")).toBe("named");
    expect(roleOf("contact@x.com")).toBe("generic");
  });
});

describe("isLander", () => {
  it("detects parked-domain redirect JS", () => {
    expect(isLander(`<script>location.href="/lander?oref=foo"</script>`)).toBe(true);
    expect(isLander(`<html><body>real content</body></html>`)).toBe(false);
  });
});

describe("rootDomain", () => {
  it("strips www and keeps the last two labels", () => {
    expect(rootDomain("www.citywealthmag.com")).toBe("citywealthmag.com");
    expect(rootDomain("news.bbc.co.uk")).toBe("co.uk");
  });
});
