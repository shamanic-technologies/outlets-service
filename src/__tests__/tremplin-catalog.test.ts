import { describe, it, expect } from "vitest";
import {
  classifyRow,
  parseCsvRecords,
  parsePriceToCents,
} from "../lib/tremplin-catalog";

describe("parsePriceToCents", () => {
  it("parses space-separated euro prices to cents", () => {
    expect(parsePriceToCents("2 000 €")).toBe(200000);
    expect(parsePriceToCents("40 €")).toBe(4000);
    expect(parsePriceToCents("1 600 €")).toBe(160000);
    expect(parsePriceToCents("250 €")).toBe(25000);
  });

  it("returns null when there is no positive integer", () => {
    expect(parsePriceToCents("")).toBeNull();
    expect(parsePriceToCents("Price")).toBeNull();
    expect(parsePriceToCents("€")).toBeNull();
  });
});

describe("parseCsvRecords", () => {
  it("keeps a multi-line quoted header as one record, then the data row", () => {
    const csv =
      '"Agency\ncontact@x.org\n+33","Homepage URL","Price\n(w/o tax)",Lang\n' +
      "sofoot.com,https://www.sofoot.com/,2 000 €,FR\n";
    const records = parseCsvRecords(csv);
    expect(records).toHaveLength(2);
    // header first cell preserves embedded newlines
    expect(records[0].fields[0]).toContain("Agency");
    expect(records[0].fields[0]).toContain("+33");
    expect(records[0].fields).toHaveLength(4);
    expect(records[1].fields[0]).toBe("sofoot.com");
    expect(records[1].fields[2]).toBe("2 000 €");
  });

  it("handles quoted fields containing commas and drops blank lines", () => {
    const csv = 'a.com,https://a.com/,"1, rue X",FR\n\nb.org,https://b.org/,40 €,EN\n';
    const records = parseCsvRecords(csv);
    expect(records).toHaveLength(2);
    expect(records[0].fields[2]).toBe("1, rue X");
    expect(records[1].fields[0]).toBe("b.org");
  });
});

describe("classifyRow", () => {
  // a realistic 26-column data row (sofoot)
  const sofoot =
    "sofoot.com,https://www.sofoot.com/,2 000 €,5302000,YES,FR,71,54,4371,2871,52,51,Sports/Soccer,51,,,,,71,644637,6210634,64,11900,4400000,1045,sofoot.com";

  it("classifies a real data row, extracting domain + cents", () => {
    const [rec] = parseCsvRecords(sofoot + "\n");
    const result = classifyRow(rec);
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.domain).toBe("sofoot.com");
      expect(result.url).toBe("https://www.sofoot.com/");
      expect(result.amountCents).toBe(200000);
    }
  });

  it("skips the header record (no resolvable domain)", () => {
    const rec = {
      fields: ["Tremplin Numerique web agency\ncontact@x.org", "Homepage URL", "Price", "x", "y", "z"],
      raw: "header",
    };
    const result = classifyRow(rec);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.reason).toContain("no resolvable domain");
  });

  it("resolves an IDN row to its punycode domain via the URL column", () => {
    const rec = {
      fields: ["étudiant.es", "https://xn--tudiant-9xa.es/", "300 €", "21740", "", "FR"],
      raw: "row",
    };
    const result = classifyRow(rec);
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.domain).toBe("xn--tudiant-9xa.es");
      expect(result.amountCents).toBe(30000);
    }
  });

  it("skips a row whose price is unparseable", () => {
    const rec = {
      fields: ["good-domain.com", "https://good-domain.com/", "on request", "x", "y", "z"],
      raw: "row",
    };
    const result = classifyRow(rec);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.reason).toContain("unparseable price");
  });

  it("falls back to https://<domain>/ when the url column is empty", () => {
    const rec = {
      fields: ["zeycap.fr", "", "210 €", "x", "y", "FR"],
      raw: "row",
    };
    const result = classifyRow(rec);
    expect(result.kind).toBe("data");
    if (result.kind === "data") expect(result.url).toBe("https://zeycap.fr/");
  });
});
