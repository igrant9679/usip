/**
 * Attachments (audit 2026-10-20, R100): a size cap on the server, the type
 * decided on the server from the file itself, and the stored file erased with
 * its row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  put: [] as Array<{ key: string; type: string; size: number }>,
  erased: [] as string[],
  eraseFails: false,
  rowsAtErase: -1,
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./storage", async (a) => ({
  ...(await a<typeof import("./storage")>()),
  storagePut: async (key: string, buf: Buffer, type: string) => { h.put.push({ key, type, size: buf.length }); return { key: `${key}_abc`, url: `/manus-storage/${key}_abc` }; },
  storageErase: async (key: string) => {
    h.rowsAtErase = h.db.rowsOf("attachments").length;
    if (h.eraseFails) throw new Error("presign failed");
    h.erased.push(key);
  },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { ATTACHMENT_MAX_BYTES, attachmentType } from "./services/attachmentType";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
function caller() {
  return appRouter.createCaller({
    user: { id: 21, openId: "u", email: "rep@lsi.example", name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const upload = (fileName: string, body: Buffer | string, mimeType?: string) =>
  caller().attachments.upload({ relatedType: "account", relatedId: 7, fileName, mimeType, base64: b64(body) });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  // 2026-11-07 (audit X1.1): a file is refused on a record that is not this
  // workspace's, so the account the uploads go on is seeded; what these
  // tests check is unchanged.
  h.db.rowsOf("accounts").push({ id: 7, workspaceId: WS, name: "Acme" });
  h.put = [];
  h.erased = [];
  h.eraseFails = false;
  h.rowsAtErase = -1;
});

describe("R100: the server caps the size", () => {
  it("refuses a file over 8 MB before storing anything", async () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 3, 0x41);
    const r = await refusal(upload("big.txt", big));
    expect(r.code).toBe("BAD_REQUEST");
    expect(h.put).toHaveLength(0);
    expect(rows("attachments")).toHaveLength(0);
  });

  it("takes a file of exactly 8 MB, and refuses an empty one", async () => {
    await upload("edge.txt", Buffer.alloc(ATTACHMENT_MAX_BYTES, 0x41));
    expect(h.put).toEqual([expect.objectContaining({ size: ATTACHMENT_MAX_BYTES })]);
    // "=" decodes to no bytes at all.
    expect((await refusal(caller().attachments.upload({ relatedType: "account", relatedId: 7, fileName: "e.txt", base64: "=" }))).code).toBe("BAD_REQUEST");
  });
});

describe("R100: the server decides the type, not the browser", () => {
  it("a real PDF is stored as one, whatever the browser called it", async () => {
    await upload("terms.pdf", PDF, "text/html");
    expect(h.put[0].type).toBe("application/pdf");
    expect(rows("attachments")[0].mimeType).toBe("application/pdf");
  });

  it("a page of script named .pdf is refused", async () => {
    const r = await refusal(upload("invoice.pdf", "<html><script>alert(1)</script></html>", "application/pdf"));
    expect(r).toMatchObject({ code: "BAD_REQUEST" });
    expect(r.message).toMatch(/contents don't match/);
    expect(h.put).toHaveLength(0);
  });

  it("an HTML or SVG file is kept as a download, never served as a page", async () => {
    await upload("page.html", "<html><script>alert(1)</script></html>", "text/html");
    await upload("logo.svg", "<svg onload='alert(1)'/>", "image/svg+xml");
    expect(h.put.map((p) => p.type)).toEqual(["application/octet-stream", "application/octet-stream"]);
  });

  it("checks image and text signatures", () => {
    expect(attachmentType("a.png", PNG)).toEqual({ ok: true, mimeType: "image/png" });
    expect(attachmentType("a.png", PDF).ok).toBe(false);
    expect(attachmentType("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, mimeType: "image/jpeg" });
    expect(attachmentType("notes.txt", Buffer.from("plain words"))).toEqual({ ok: true, mimeType: "text/plain" });
    expect(attachmentType("notes.txt", Buffer.from([0x41, 0x00, 0x42])).ok).toBe(false);
    expect(attachmentType("deck.pptx", Buffer.from("PK\u0003\u0004rest", "latin1"))).toMatchObject({ ok: true });
    expect(attachmentType("noextension", PDF)).toEqual({ ok: true, mimeType: "application/octet-stream" });
  });
});

describe("R100: the stored file goes with its row", () => {
  beforeEach(() => {
    rows("attachments").push(
      { id: 1, workspaceId: WS, relatedType: "account", relatedId: 7, fileKey: "ws-2/account-7/1-a.pdf_abc", url: "/manus-storage/ws-2/account-7/1-a.pdf_abc", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: 21 },
      { id: 2, workspaceId: 4, relatedType: "account", relatedId: 9, fileKey: "ws-4/account-9/2-b.pdf_abc", url: "/manus-storage/ws-4/x", fileName: "b.pdf", mimeType: "application/pdf", sizeBytes: 10, uploadedByUserId: 99 },
    );
  });

  it("erases the object first, then deletes the row", async () => {
    await caller().attachments.delete({ id: 1 });
    expect(h.erased).toEqual(["ws-2/account-7/1-a.pdf_abc"]);
    expect(h.rowsAtErase).toBe(2);
    expect(rows("attachments").map((a) => a.id)).toEqual([2]);
  });

  it("a failed erase deletes nothing", async () => {
    h.eraseFails = true;
    const r = await refusal(caller().attachments.delete({ id: 1 }));
    expect(r.message).toMatch(/nothing was deleted/);
    expect(rows("attachments").map((a) => a.id)).toEqual([1, 2]);
  });

  it("another workspace's file is neither erased nor deleted", async () => {
    await caller().attachments.delete({ id: 2 });
    expect(h.erased).toEqual([]);
    expect(rows("attachments")).toHaveLength(2);
  });
});
