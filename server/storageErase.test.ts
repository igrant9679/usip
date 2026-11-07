/**
 * What deleting a stored file actually does (audit 2026-10-20, R100; re-checked
 * 2026-11-07). The Forge storage proxy has no delete, so `storageErase`
 * overwrites the object with zero bytes at its exact key. These pin the
 * behaviour the attachment delete relies on: the exact key (no hash suffix),
 * an empty body, a throw when either step fails, and no guessed DELETE call
 * that would fail silently against an endpoint that does not exist.
 *
 * fetch is stubbed; nothing leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.BUILT_IN_FORGE_API_URL = "https://forge.invalid/";
  process.env.BUILT_IN_FORGE_API_KEY = "test-forge-key";
  return { calls: [] as Array<{ url: string; method: string; size: number | null }>, presignOk: true, putOk: true };
});

import { storageErase } from "./storage";

beforeEach(() => {
  h.calls = [];
  h.presignOk = true;
  h.putOk = true;
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body as Blob | undefined;
    h.calls.push({ url, method, size: body && typeof body.size === "number" ? body.size : null });
    if (url.includes("v1/storage/presign/put")) {
      return h.presignOk
        ? new Response(JSON.stringify({ url: "https://bucket.invalid/signed-put" }), { status: 200 })
        : new Response("nope", { status: 500 });
    }
    if (url.startsWith("https://bucket.invalid/")) return new Response("", { status: h.putOk ? 200 : 403 });
    return new Response("unexpected", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("storageErase overwrites, because the provider has no delete (R100)", () => {
  it("presigns a PUT at the exact stored key and uploads an empty object", async () => {
    await storageErase("/ws-2/account-7/1-a.pdf_abc12345");
    expect(h.calls).toHaveLength(2);
    const presign = new URL(h.calls[0]!.url);
    expect(presign.pathname).toBe("/v1/storage/presign/put");
    // The key the record holds, leading slash dropped, and no second hash suffix.
    expect(presign.searchParams.get("path")).toBe("ws-2/account-7/1-a.pdf_abc12345");
    expect(h.calls[1]).toEqual({ url: "https://bucket.invalid/signed-put", method: "PUT", size: 0 });
  });

  it("never calls a DELETE that the provider does not document", async () => {
    await storageErase("ws-2/x.pdf_abc");
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(h.calls.some((c) => /delete/i.test(c.url))).toBe(false);
  });

  it("throws when the presign fails, so the caller keeps its record", async () => {
    h.presignOk = false;
    await expect(storageErase("ws-2/x.pdf_abc")).rejects.toThrow(/presign failed/);
  });

  it("throws when the overwrite is refused", async () => {
    h.putOk = false;
    await expect(storageErase("ws-2/x.pdf_abc")).rejects.toThrow(/erase failed/);
  });
});
