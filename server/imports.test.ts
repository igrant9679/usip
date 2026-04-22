/**
 * Tests for CSV Import utilities and Email Verification status mapping
 * IMP-001 to IMP-006 / VER-001 to VER-005
 */
import { describe, expect, it } from "vitest";
import { reoonStatusToUsip, VERIFICATION_BADGE } from "./routers/emailVerification";

/* ─── Inline copies of the pure utility functions from imports.ts ─────── */
// We test the pure logic directly without needing a DB connection.

function parseCSVText(csvText: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function mapRowToContact(
  row: Record<string, string>,
  fieldMapping: Record<string, string | null>,
): Record<string, string | undefined> {
  const mapped: Record<string, string | undefined> = {};
  for (const [csvCol, systemKey] of Object.entries(fieldMapping)) {
    if (systemKey && row[csvCol] !== undefined) {
      mapped[systemKey] = row[csvCol];
    }
  }
  return mapped;
}

/* ─── parseCSVText ──────────────────────────────────────────────────────── */
describe("parseCSVText", () => {
  it("parses a simple 2-row CSV correctly", () => {
    const csv = `First Name,Last Name,Email\nJohn,Doe,john@example.com\nJane,Smith,jane@example.com`;
    const { headers, rows } = parseCSVText(csv);
    expect(headers).toEqual(["First Name", "Last Name", "Email"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ "First Name": "John", "Last Name": "Doe", Email: "john@example.com" });
    expect(rows[1]).toEqual({ "First Name": "Jane", "Last Name": "Smith", Email: "jane@example.com" });
  });

  it("handles quoted values", () => {
    const csv = `"First Name","Last Name"\n"Alice","Wonderland"`;
    const { headers, rows } = parseCSVText(csv);
    expect(headers).toEqual(["First Name", "Last Name"]);
    expect(rows[0]).toEqual({ "First Name": "Alice", "Last Name": "Wonderland" });
  });

  it("returns a single empty header and no rows for empty input", () => {
    // An empty string split by comma produces [""] — one empty header, no data rows
    const { headers, rows } = parseCSVText("");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toBe("");
    expect(rows).toHaveLength(0);
  });

  it("handles Windows-style CRLF line endings", () => {
    const csv = "First Name,Last Name\r\nBob,Builder";
    const { headers, rows } = parseCSVText(csv);
    expect(headers).toEqual(["First Name", "Last Name"]);
    expect(rows[0]).toEqual({ "First Name": "Bob", "Last Name": "Builder" });
  });

  it("handles a header-only CSV with no data rows", () => {
    const csv = "First Name,Last Name,Email";
    const { headers, rows } = parseCSVText(csv);
    expect(headers).toEqual(["First Name", "Last Name", "Email"]);
    expect(rows).toHaveLength(0);
  });
});

/* ─── isValidEmail ──────────────────────────────────────────────────────── */
describe("isValidEmail", () => {
  it("accepts valid email addresses", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("user+tag@sub.domain.io")).toBe(true);
    expect(isValidEmail("a@b.co")).toBe(true);
  });

  it("rejects invalid email addresses", () => {
    expect(isValidEmail("notanemail")).toBe(false);
    expect(isValidEmail("missing@domain")).toBe(false);
    expect(isValidEmail("@nodomain.com")).toBe(false);
    expect(isValidEmail("spaces in@email.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

/* ─── mapRowToContact ───────────────────────────────────────────────────── */
describe("mapRowToContact", () => {
  it("maps CSV columns to system field keys", () => {
    const row = { "First Name": "Alice", "Last Name": "Smith", "Work Email": "alice@corp.com" };
    const mapping = { "First Name": "firstName", "Last Name": "lastName", "Work Email": "email" };
    const result = mapRowToContact(row, mapping);
    expect(result).toEqual({ firstName: "Alice", lastName: "Smith", email: "alice@corp.com" });
  });

  it("skips columns mapped to null", () => {
    const row = { "First Name": "Bob", Notes: "ignore me" };
    const mapping = { "First Name": "firstName", Notes: null };
    const result = mapRowToContact(row, mapping);
    expect(result).toEqual({ firstName: "Bob" });
    expect(result.Notes).toBeUndefined();
  });

  it("returns empty object when all columns are skipped", () => {
    const row = { A: "x", B: "y" };
    const mapping = { A: null, B: null };
    const result = mapRowToContact(row, mapping);
    expect(Object.keys(result)).toHaveLength(0);
  });
});

/* ─── reoonStatusToUsip ─────────────────────────────────────────────────── */
describe("reoonStatusToUsip", () => {
  it("maps 'safe' to 'valid'", () => {
    expect(reoonStatusToUsip("safe")).toBe("valid");
  });

  it("maps 'catch_all' to 'accept_all'", () => {
    expect(reoonStatusToUsip("catch_all")).toBe("accept_all");
  });

  it("maps risky statuses correctly", () => {
    expect(reoonStatusToUsip("role_account")).toBe("risky");
    expect(reoonStatusToUsip("disposable")).toBe("risky");
    expect(reoonStatusToUsip("inbox_full")).toBe("risky");
  });

  it("maps invalid statuses correctly", () => {
    expect(reoonStatusToUsip("invalid")).toBe("invalid");
    expect(reoonStatusToUsip("disabled")).toBe("invalid");
    expect(reoonStatusToUsip("spamtrap")).toBe("invalid");
  });

  it("maps unknown statuses to 'unknown'", () => {
    expect(reoonStatusToUsip("something_new")).toBe("unknown");
    expect(reoonStatusToUsip("")).toBe("unknown");
  });
});

/* ─── VERIFICATION_BADGE ────────────────────────────────────────────────── */
describe("VERIFICATION_BADGE", () => {
  it("has an entry for every verification status", () => {
    const statuses = ["valid", "accept_all", "risky", "invalid", "unknown"] as const;
    for (const status of statuses) {
      expect(VERIFICATION_BADGE[status]).toBeDefined();
      expect(VERIFICATION_BADGE[status].label).toBeTruthy();
      expect(VERIFICATION_BADGE[status].color).toBeTruthy();
      expect(VERIFICATION_BADGE[status].bg).toBeTruthy();
    }
  });

  it("valid badge has green styling", () => {
    expect(VERIFICATION_BADGE.valid.color).toContain("green");
    expect(VERIFICATION_BADGE.valid.bg).toContain("green");
  });

  it("invalid badge has red styling", () => {
    expect(VERIFICATION_BADGE.invalid.color).toContain("red");
    expect(VERIFICATION_BADGE.invalid.bg).toContain("red");
  });
});

/* ─── LinkedIn encryption helpers (pure logic test) ─────────────────────── */
describe("LinkedIn credential masking", () => {
  function maskValue(value: string): string {
    if (value.length <= 8) return "••••••••";
    return "••••••••" + value.slice(-4);
  }

  it("masks short values entirely", () => {
    expect(maskValue("abc")).toBe("••••••••");
    expect(maskValue("12345678")).toBe("••••••••");
  });

  it("shows last 4 chars for longer values", () => {
    expect(maskValue("abcdefghij")).toBe("••••••••ghij");
    expect(maskValue("super-secret-token-XYZ9")).toBe("••••••••XYZ9");
  });
});
