/**
 * Profile-photo mirroring — the guarantees that keep avatars alive past the
 * CDN signature window:
 *
 *  - expiry is read off the licdn `e=` param, and ONLY for licdn hosts (a
 *    coincidental e= on some other provider must not condemn the URL);
 *  - the inline budget is enforced in bytes so the stored data URI stays
 *    under the 60k-char convention uploadProfileImage established;
 *  - download outcomes map to actionable reasons: an expired signature says
 *    "expired" (mark failed_to_load, stop retrying), a live-signature flake
 *    says network/http (retry next sweep).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MAX_INLINE_IMAGE_BYTES,
  bytesToDataUri,
  isExpiredLicdnUrl,
  licdnExpiryEpoch,
  mirrorImageToDataUri,
} from "./enrichment/profileImageMirror";

const SIGNED = (epoch: number) =>
  `https://media.licdn.com/dms/image/v2/D4E03AQHx/profile-displayphoto-shrink_100_100/0/123?e=${epoch}&v=beta&t=sig`;

afterEach(() => vi.unstubAllGlobals());

describe("licdnExpiryEpoch / isExpiredLicdnUrl", () => {
  it("reads the e= epoch off a signed licdn URL", () => {
    expect(licdnExpiryEpoch(SIGNED(1761523200))).toBe(1761523200);
  });

  it("ignores e= on non-licdn hosts — that's someone else's query param", () => {
    expect(licdnExpiryEpoch("https://cdn.example.com/pic.jpg?e=1000000000")).toBeNull();
    expect(isExpiredLicdnUrl("https://cdn.example.com/pic.jpg?e=1000000000")).toBe(false);
  });

  it("null on missing/garbage params and non-URLs", () => {
    expect(licdnExpiryEpoch("https://media.licdn.com/pic.jpg")).toBeNull();
    expect(licdnExpiryEpoch("https://media.licdn.com/pic.jpg?e=soon")).toBeNull();
    expect(licdnExpiryEpoch("not a url")).toBeNull();
    expect(licdnExpiryEpoch(null)).toBeNull();
  });

  it("compares expiry in SECONDS, not milliseconds", () => {
    const nowMs = 1_700_000_000_000;
    expect(isExpiredLicdnUrl(SIGNED(1_699_999_999), nowMs)).toBe(true);
    expect(isExpiredLicdnUrl(SIGNED(1_700_000_001), nowMs)).toBe(false);
  });
});

describe("bytesToDataUri", () => {
  it("inlines small images with their content type", () => {
    const uri = bytesToDataUri(new Uint8Array([1, 2, 3]), "image/png");
    expect(uri).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
  });

  it("refuses payloads over the inline budget instead of bloating the row", () => {
    expect(bytesToDataUri(new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1), "image/jpeg")).toBeNull();
    expect(bytesToDataUri(new Uint8Array(0), "image/jpeg")).toBeNull();
  });

  it("falls back to image/jpeg for a malformed content type — never injects it", () => {
    const uri = bytesToDataUri(new Uint8Array([1]), 'image/x";weird');
    expect(uri!.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});

describe("mirrorImageToDataUri", () => {
  const imageResponse = (bytes: Uint8Array, type = "image/jpeg", status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": type }),
      arrayBuffer: async () => bytes.buffer,
    }) as unknown as Response;

  it("downloads and inlines a live image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(new Uint8Array([9, 9]))));
    const r = await mirrorImageToDataUri(SIGNED(Math.floor(Date.now() / 1000) + 86400));
    expect(r).toEqual({ ok: true, dataUri: `data:image/jpeg;base64,${Buffer.from([9, 9]).toString("base64")}` });
  });

  it("reports 'expired' WITHOUT fetching when the signature already lapsed", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await mirrorImageToDataUri(SIGNED(1_000_000_000));
    expect(r).toEqual({ ok: false, reason: "expired" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps an HTTP failure on a live signature to its status, not 'expired'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(new Uint8Array(0), "image/jpeg", 403)));
    const r = await mirrorImageToDataUri(SIGNED(Math.floor(Date.now() / 1000) + 86400));
    expect(r).toEqual({ ok: false, reason: "http_403" });
  });

  it("refuses non-image content — an error page must never become an avatar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(new Uint8Array([1]), "text/html")));
    const r = await mirrorImageToDataUri("https://media.licdn.com/pic.jpg");
    expect(r).toEqual({ ok: false, reason: "not_image" });
  });

  it("reports oversize instead of storing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1))));
    const r = await mirrorImageToDataUri("https://media.licdn.com/pic.jpg");
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });

  it("never throws — network failure is a reason, not an exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const r = await mirrorImageToDataUri("https://media.licdn.com/pic.jpg");
    expect(r).toEqual({ ok: false, reason: "network" });
  });
});
