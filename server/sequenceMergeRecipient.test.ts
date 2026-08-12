/**
 * "Test whether the email sequence variables are functional and map to real
 * contact data" (owner, 2026-08-12). They were functional and NOT mapping,
 * two ways, both on the sequence send path (deliverEmailDraft):
 *
 *   1. Drafts created by the sequence engine name their recipient via
 *      toProspectId (migration 0085) — and the recipient resolver read only
 *      toContactId/toLeadId. With toEmail pre-stamped by the engine, no
 *      branch fired at all: every merge variable rendered from nulls, and
 *      the whole campaign opened with "Hi ,".
 *   2. {{bookingLink}} is advertised to the copy generator, was absent from
 *      the send map, and scrubForSend deletes unresolved tokens at the send
 *      boundary — the meeting CTA silently vanished.
 *
 * These tests drive the REAL resolver and the REAL renderer.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { contacts, leads, prospects } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { resolveDraftRecipient } from "./routers/sequences";
import { renderMergeFields } from "./mergeVars";

/** Fake db dispatching on the real table object. */
function makeDb(rowsByTable: Map<unknown, Record<string, unknown>>) {
  const builder = () => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      leftJoin() { return b; },
      where() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void) {
        const row = rowsByTable.get(st.table);
        res(row ? [row] : []);
      },
    };
    return b;
  };
  return { select: () => builder() };
}

describe("resolveDraftRecipient", () => {
  it("a prospect-target draft resolves the PROSPECT's real fields — even with toEmail pre-stamped", async () => {
    const db = makeDb(new Map([[prospects, {
      email: "dana@montgomerycountymd.gov", firstName: "Dana", lastName: "Whitfield",
      title: "Grants Management Officer", company: "Montgomery County",
    }]]));
    const r = await resolveDraftRecipient(db as never, 1, { toEmail: "dana@montgomerycountymd.gov", toProspectId: 42 });
    expect(r).toEqual({
      toEmail: "dana@montgomerycountymd.gov",
      firstName: "Dana", lastName: "Whitfield",
      title: "Grants Management Officer", company: "Montgomery County",
    });
  });

  it("…and fills a missing toEmail from the prospect row", async () => {
    const db = makeDb(new Map([[prospects, {
      email: "dana@montgomerycountymd.gov", firstName: "Dana", lastName: "Whitfield", title: null, company: null,
    }]]));
    const r = await resolveDraftRecipient(db as never, 1, { toProspectId: 42 });
    expect(r.toEmail).toBe("dana@montgomerycountymd.gov");
  });

  it("a contact-target draft resolves contact fields with the joined account name", async () => {
    const db = makeDb(new Map([[contacts, {
      email: "j@acme.com", firstName: "Jo", lastName: "Ellis", title: "CFO", accountName: "Acme Corp",
    }]]));
    const r = await resolveDraftRecipient(db as never, 1, { toContactId: 7 });
    expect(r).toMatchObject({ firstName: "Jo", company: "Acme Corp", toEmail: "j@acme.com" });
  });

  it("a lead-target draft resolves lead fields", async () => {
    const db = makeDb(new Map([[leads, {
      email: "l@x.io", firstName: "Lee", lastName: "Nguyen", title: "VP Ops", company: "Xio",
    }]]));
    const r = await resolveDraftRecipient(db as never, 1, { toLeadId: 3 });
    expect(r).toMatchObject({ firstName: "Lee", company: "Xio" });
  });

  it("end-to-end: the resolved fields actually render into the template", () => {
    const rendered = renderMergeFields(
      "Hi {{firstName}}, saw {{company}} is hiring — {{firstName|Friend}}. Book: {{bookingLink}}",
      { firstName: "Dana", company: "Montgomery County", bookingLink: "https://getvelocityai.app/b/idris-1" },
    );
    expect(rendered).toBe("Hi Dana, saw Montgomery County is hiring — Dana. Book: https://getvelocityai.app/b/idris-1");
  });
});

describe("advertised tokens ⊆ send map — the drift that hid both bugs", () => {
  const src = readFileSync("server/routers/sequences.ts", "utf8");

  it("every token the AI prompt advertises exists in deliverEmailDraft's merge map", () => {
    // The prompt names these as safe placeholders; a token advertised but
    // not mapped is deleted by scrubForSend at the send boundary — the
    // recipient never sees it and neither does anyone else.
    const mapStart = src.indexOf("const mergeVars: Record<string, string> = {", src.indexOf("async function deliverEmailDraft"));
    expect(mapStart, "deliverEmailDraft merge map not found — re-anchor").toBeGreaterThan(-1);
    const mapBlock = src.slice(mapStart, src.indexOf("};", mapStart));
    for (const token of ["firstName", "lastName", "fullName", "title", "company", "bookingLink"]) {
      expect(mapBlock.includes(token), `advertised token {{${token}}} missing from the send map`).toBe(true);
    }
  });

  it("the resolver consults all THREE recipient columns", () => {
    const fn = src.slice(src.indexOf("export async function resolveDraftRecipient"), src.indexOf("export async function deliverEmailDraft"));
    for (const col of ["toContactId", "toLeadId", "toProspectId"]) {
      expect(fn.includes(`draft.${col}`), `resolver ignores ${col}`).toBe(true);
    }
  });
});
