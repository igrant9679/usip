/**
 * savedSections.test.ts
 * Pure-logic unit tests for the Saved Sections feature.
 * Tests the block schema validation, category enum, name constraints,
 * and the multi-block insert logic (sort-order re-indexing).
 */
import { describe, it, expect } from "vitest";

/* ─── Types mirrored from savedSections router ───────────────────────────── */
type BlockType =
  | "header" | "text" | "image" | "button"
  | "divider" | "spacer" | "two_column" | "footer";

interface Block {
  id: string;
  type: BlockType;
  props: Record<string, unknown>;
  sortOrder: number;
}

const SECTION_CATEGORIES = [
  "layout", "header", "footer", "cta",
  "testimonial", "pricing", "custom",
] as const;
type SectionCategory = typeof SECTION_CATEGORIES[number];

/* ─── Helpers mirrored from the router / UI ─────────────────────────────── */

/** Validate a saved section before persisting */
function validateSection(input: {
  name: string;
  category: string;
  blocks: Block[];
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input.name || input.name.trim().length === 0) errors.push("Name is required");
  if (input.name.trim().length > 200) errors.push("Name must be ≤ 200 characters");
  if (!SECTION_CATEGORIES.includes(input.category as SectionCategory)) {
    errors.push(`Invalid category: ${input.category}`);
  }
  if (!input.blocks || input.blocks.length === 0) errors.push("At least one block is required");
  return { valid: errors.length === 0, errors };
}

/** Re-index sort orders when inserting section blocks into an existing canvas */
function insertSectionIntoCanvas(
  existingBlocks: Block[],
  sectionBlocks: Block[],
  insertAfterIndex?: number, // undefined = append at end
): Block[] {
  const uid = (i: number) => `inserted-${i}`;
  const newBlocks = sectionBlocks.map((b, i) => ({
    ...b,
    id: uid(i),
    sortOrder: 0, // will be recomputed
  }));

  let result: Block[];
  if (insertAfterIndex === undefined || insertAfterIndex >= existingBlocks.length) {
    result = [...existingBlocks, ...newBlocks];
  } else {
    result = [
      ...existingBlocks.slice(0, insertAfterIndex + 1),
      ...newBlocks,
      ...existingBlocks.slice(insertAfterIndex + 1),
    ];
  }
  // Re-index all sort orders
  return result.map((b, i) => ({ ...b, sortOrder: i }));
}

/** Produce a minimal preview label for a section */
function sectionPreviewLabel(blocks: Block[]): string {
  const types = [...new Set(blocks.map((b) => b.type))];
  return `${blocks.length} block${blocks.length !== 1 ? "s" : ""}: ${types.join(", ")}`;
}

/* ─── Tests ─────────────────────────────────────────────────────────────── */

describe("validateSection", () => {
  const validBlocks: Block[] = [
    { id: "a", type: "header", props: { headline: "Hi" }, sortOrder: 0 },
    { id: "b", type: "button", props: { label: "CTA" }, sortOrder: 1 },
  ];

  it("passes for a valid section", () => {
    const result = validateSection({ name: "My Section", category: "cta", blocks: validBlocks });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty name", () => {
    const result = validateSection({ name: "  ", category: "custom", blocks: validBlocks });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Name is required");
  });

  it("rejects name longer than 200 chars", () => {
    const result = validateSection({ name: "x".repeat(201), category: "custom", blocks: validBlocks });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("200"))).toBe(true);
  });

  it("rejects invalid category", () => {
    const result = validateSection({ name: "Test", category: "unknown_cat", blocks: validBlocks });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid category"))).toBe(true);
  });

  it("accepts all valid categories", () => {
    for (const cat of SECTION_CATEGORIES) {
      const result = validateSection({ name: "Test", category: cat, blocks: validBlocks });
      expect(result.valid).toBe(true);
    }
  });

  it("rejects empty blocks array", () => {
    const result = validateSection({ name: "Test", category: "custom", blocks: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("At least one block is required");
  });

  it("can have multiple errors simultaneously", () => {
    const result = validateSection({ name: "", category: "bad", blocks: [] });
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("insertSectionIntoCanvas — append mode", () => {
  const existing: Block[] = [
    { id: "e1", type: "header", props: {}, sortOrder: 0 },
    { id: "e2", type: "text", props: {}, sortOrder: 1 },
  ];
  const section: Block[] = [
    { id: "s1", type: "button", props: {}, sortOrder: 0 },
    { id: "s2", type: "divider", props: {}, sortOrder: 1 },
  ];

  it("appends section blocks after existing blocks", () => {
    const result = insertSectionIntoCanvas(existing, section);
    expect(result).toHaveLength(4);
    expect(result[2]!.type).toBe("button");
    expect(result[3]!.type).toBe("divider");
  });

  it("re-indexes sort orders sequentially from 0", () => {
    const result = insertSectionIntoCanvas(existing, section);
    result.forEach((b, i) => expect(b.sortOrder).toBe(i));
  });

  it("assigns new IDs to inserted blocks (no collision with existing)", () => {
    const result = insertSectionIntoCanvas(existing, section);
    const ids = result.map((b) => b.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("works when existing canvas is empty", () => {
    const result = insertSectionIntoCanvas([], section);
    expect(result).toHaveLength(2);
    expect(result[0]!.sortOrder).toBe(0);
    expect(result[1]!.sortOrder).toBe(1);
  });

  it("works when section has a single block", () => {
    const result = insertSectionIntoCanvas(existing, [section[0]!]);
    expect(result).toHaveLength(3);
    expect(result[2]!.type).toBe("button");
  });
});

describe("insertSectionIntoCanvas — insert-after mode", () => {
  const existing: Block[] = [
    { id: "e1", type: "header", props: {}, sortOrder: 0 },
    { id: "e2", type: "text", props: {}, sortOrder: 1 },
    { id: "e3", type: "footer", props: {}, sortOrder: 2 },
  ];
  const section: Block[] = [
    { id: "s1", type: "button", props: {}, sortOrder: 0 },
  ];

  it("inserts after the specified index", () => {
    const result = insertSectionIntoCanvas(existing, section, 1); // after index 1 (text)
    expect(result).toHaveLength(4);
    expect(result[0]!.type).toBe("header");
    expect(result[1]!.type).toBe("text");
    expect(result[2]!.type).toBe("button"); // inserted here
    expect(result[3]!.type).toBe("footer");
  });

  it("re-indexes sort orders after mid-insert", () => {
    const result = insertSectionIntoCanvas(existing, section, 0); // after first block
    result.forEach((b, i) => expect(b.sortOrder).toBe(i));
  });

  it("falls back to append when insertAfterIndex >= length", () => {
    const result = insertSectionIntoCanvas(existing, section, 99);
    expect(result[result.length - 1]!.type).toBe("button");
  });
});

describe("sectionPreviewLabel", () => {
  it("returns correct count and unique types", () => {
    const blocks: Block[] = [
      { id: "a", type: "header", props: {}, sortOrder: 0 },
      { id: "b", type: "text", props: {}, sortOrder: 1 },
      { id: "c", type: "text", props: {}, sortOrder: 2 }, // duplicate type
    ];
    const label = sectionPreviewLabel(blocks);
    expect(label).toContain("3 blocks");
    expect(label).toContain("header");
    expect(label).toContain("text");
    // "text" should appear only once in the types list
    const typesPart = label.split(": ")[1]!;
    expect(typesPart.split(", ").filter((t) => t === "text")).toHaveLength(1);
  });

  it("uses singular 'block' for a single block", () => {
    const blocks: Block[] = [{ id: "a", type: "divider", props: {}, sortOrder: 0 }];
    expect(sectionPreviewLabel(blocks)).toContain("1 block:");
  });
});
