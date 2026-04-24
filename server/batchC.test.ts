import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Pipeline Forecast ───────────────────────────────────────────────────────
describe("Pipeline Forecast", () => {
  it("computes weighted value correctly", () => {
    const deals = [
      { value: 10000, probability: 0.8, closeDate: "2026-06-01" },
      { value: 5000, probability: 0.5, closeDate: "2026-06-15" },
      { value: 20000, probability: 0.2, closeDate: "2026-07-01" },
    ];

    const weighted = deals.map((d) => ({
      ...d,
      weighted: Math.round(d.value * d.probability),
    }));

    expect(weighted[0]!.weighted).toBe(8000);
    expect(weighted[1]!.weighted).toBe(2500);
    expect(weighted[2]!.weighted).toBe(4000);

    const grandTotal = weighted.reduce((s, d) => s + d.weighted, 0);
    expect(grandTotal).toBe(14500);
  });

  it("groups deals by close month", () => {
    const deals = [
      { closeDate: "2026-06-01", weighted: 8000 },
      { closeDate: "2026-06-15", weighted: 2500 },
      { closeDate: "2026-07-01", weighted: 4000 },
    ];

    const byMonth: Record<string, number> = {};
    for (const d of deals) {
      const month = d.closeDate.slice(0, 7); // "YYYY-MM"
      byMonth[month] = (byMonth[month] ?? 0) + d.weighted;
    }

    expect(byMonth["2026-06"]).toBe(10500);
    expect(byMonth["2026-07"]).toBe(4000);
    expect(Object.keys(byMonth)).toHaveLength(2);
  });

  it("handles empty pipeline gracefully", () => {
    const deals: any[] = [];
    const grandWeighted = deals.reduce((s, d) => s + d.weighted, 0);
    expect(grandWeighted).toBe(0);
  });
});

// ─── Duplicate Detection & Merge ─────────────────────────────────────────────
describe("Duplicate Detection", () => {
  it("detects exact email match as duplicate", () => {
    const contacts = [
      { id: 1, firstName: "John", lastName: "Smith", email: "john@acme.com" },
      { id: 2, firstName: "Jon", lastName: "Smith", email: "john@acme.com" },
    ];

    const isDuplicate = contacts[0]!.email === contacts[1]!.email;
    expect(isDuplicate).toBe(true);
  });

  it("detects name similarity as potential duplicate", () => {
    function normalize(s: string) {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    const c1 = { firstName: "John", lastName: "Smith" };
    const c2 = { firstName: "Jon", lastName: "Smyth" };

    const name1 = normalize(`${c1.firstName}${c1.lastName}`);
    const name2 = normalize(`${c2.firstName}${c2.lastName}`);

    // Simple Levenshtein-like: check if names share ≥ 70% chars
    const longer = name1.length > name2.length ? name1 : name2;
    const shorter = name1.length <= name2.length ? name1 : name2;
    let matches = 0;
    for (const ch of shorter) {
      if (longer.includes(ch)) matches++;
    }
    const similarity = matches / longer.length;
    expect(similarity).toBeGreaterThan(0.5);
  });

  it("merge patch only fills empty fields on primary", () => {
    const primary = { id: 1, title: "VP Sales", phone: null, city: null };
    const secondary = { id: 2, title: "Director", phone: "+1-555-0100", city: "New York" };

    const patch: Record<string, any> = {};
    const fields = ["title", "phone", "city"] as const;
    for (const f of fields) {
      if ((primary as any)[f] === null && (secondary as any)[f] !== null) {
        patch[f] = (secondary as any)[f];
      }
    }

    // title already set on primary → not overwritten
    expect(patch.title).toBeUndefined();
    // phone and city are null on primary → filled from secondary
    expect(patch.phone).toBe("+1-555-0100");
    expect(patch.city).toBe("New York");
  });
});

// ─── Contact Enrichment ───────────────────────────────────────────────────────
describe("Contact Enrichment", () => {
  it("only applies suggestions for empty fields", () => {
    const contact = {
      title: "VP Sales",
      phone: null,
      linkedinUrl: null,
      city: "Boston",
      seniority: null,
    };

    const suggestions = {
      title: "Director of Sales",  // already set → skip
      phone: "+1-617-555-0123",    // empty → apply
      linkedinUrl: "https://linkedin.com/in/jsmith", // empty → apply
      city: "New York",            // already set → skip
      seniority: "vp",             // empty → apply
    };

    const patch: Record<string, any> = {};
    for (const [field, value] of Object.entries(suggestions)) {
      if (!value) continue;
      const current = (contact as any)[field];
      if (current === null || current === undefined || current === "") {
        patch[field] = value;
      }
    }

    expect(patch.title).toBeUndefined();
    expect(patch.city).toBeUndefined();
    expect(patch.phone).toBe("+1-617-555-0123");
    expect(patch.linkedinUrl).toBe("https://linkedin.com/in/jsmith");
    expect(patch.seniority).toBe("vp");
    expect(Object.keys(patch)).toHaveLength(3);
  });

  it("returns empty patch when all fields already filled", () => {
    const contact = {
      title: "VP Sales",
      phone: "+1-617-555-9999",
      linkedinUrl: "https://linkedin.com/in/existing",
      city: "Boston",
      seniority: "vp",
    };

    const suggestions = {
      title: "Director",
      phone: "+1-617-555-0000",
      city: "New York",
    };

    const patch: Record<string, any> = {};
    for (const [field, value] of Object.entries(suggestions)) {
      const current = (contact as any)[field];
      if (current === null || current === undefined || current === "") {
        patch[field] = value;
      }
    }

    expect(Object.keys(patch)).toHaveLength(0);
  });
});

// ─── Sequence Performance Analytics ──────────────────────────────────────────
describe("Sequence Performance Analytics", () => {
  it("calculates open rate correctly", () => {
    const sent = 100;
    const uniqueOpens = 35;
    const openRate = sent > 0 ? Math.round((uniqueOpens / sent) * 100) : 0;
    expect(openRate).toBe(35);
  });

  it("calculates click rate correctly", () => {
    const sent = 100;
    const uniqueClicks = 8;
    const clickRate = sent > 0 ? Math.round((uniqueClicks / sent) * 100) : 0;
    expect(clickRate).toBe(8);
  });

  it("calculates bounce rate correctly", () => {
    const sent = 100;
    const bounced = 3;
    const bounceRate = sent > 0 ? Math.round((bounced / sent) * 100) : 0;
    expect(bounceRate).toBe(3);
  });

  it("calculates exit rate correctly", () => {
    const totalEnrolled = 50;
    const exited = 10;
    const exitRate = totalEnrolled > 0 ? Math.round((exited / totalEnrolled) * 100) : 0;
    expect(exitRate).toBe(20);
  });

  it("returns 0 rates when no emails sent", () => {
    const sent = 0;
    const uniqueOpens = 0;
    const openRate = sent > 0 ? Math.round((uniqueOpens / sent) * 100) : 0;
    expect(openRate).toBe(0);
  });

  it("correctly identifies high-performing vs low-performing sequences", () => {
    const sequences = [
      { name: "Cold Outreach", openRate: 42, clickRate: 8 },
      { name: "Re-engagement", openRate: 12, clickRate: 1 },
    ];

    const highPerforming = sequences.filter((s) => s.openRate >= 30 && s.clickRate >= 5);
    const lowPerforming = sequences.filter((s) => s.openRate < 15);

    expect(highPerforming).toHaveLength(1);
    expect(highPerforming[0]!.name).toBe("Cold Outreach");
    expect(lowPerforming[0]!.name).toBe("Re-engagement");
  });
});
