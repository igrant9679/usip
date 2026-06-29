/**
 * Unit tests for resolveProspectProfileImage — the compliance gate that
 * decides whether a prospect's profile image may be displayed.
 */
import { describe, it, expect } from "vitest";
import { resolveProspectProfileImage } from "./profileImage";

const base = {
  profileImageUrl: "https://authorized-source.com/avatar.jpg",
  profileImageSource: "enrichment_provider" as const,
  profileImageSourceUrl: "https://authorized-source.com/person/123",
  profileImageLastVerifiedAt: "2026-06-29T12:00:00.000Z",
  profileImageStatus: "available" as const,
};

describe("resolveProspectProfileImage", () => {
  it("returns the URL for a permitted, available HTTPS image", () => {
    const r = resolveProspectProfileImage(base);
    expect(r.url).toBe("https://authorized-source.com/avatar.jpg");
    expect(r.source_type).toBe("enrichment_provider");
    expect(r.status).toBe("available");
    expect(r.last_verified_at).toBe("2026-06-29T12:00:00.000Z");
  });

  it("returns null url (initials fallback) when there is no image", () => {
    const r = resolveProspectProfileImage({ profileImageStatus: "unknown" });
    expect(r.url).toBeNull();
    expect(r.status).toBe("unknown");
  });

  it("returns null for unavailable / failed_to_load status", () => {
    expect(resolveProspectProfileImage({ ...base, profileImageStatus: "unavailable" }).url).toBeNull();
    expect(resolveProspectProfileImage({ ...base, profileImageStatus: "failed_to_load" }).url).toBeNull();
  });

  it("blocks a non-HTTPS url even if marked available", () => {
    const r = resolveProspectProfileImage({ ...base, profileImageUrl: "http://insecure.com/a.jpg" });
    expect(r.url).toBeNull();
  });

  it("blocks suppressed / deleted (rejected) / privacy-restricted profiles and reports blocked_by_policy", () => {
    expect(resolveProspectProfileImage({ ...base, suppressed: true }).url).toBeNull();
    expect(resolveProspectProfileImage({ ...base, privacyRestricted: true }).status).toBe("blocked_by_policy");
    const rejected = resolveProspectProfileImage({ ...base, verificationStatus: "rejected" });
    expect(rejected.url).toBeNull();
    expect(rejected.status).toBe("blocked_by_policy");
  });

  it("never returns a URL for removed / blocked_by_policy and preserves that status", () => {
    expect(resolveProspectProfileImage({ ...base, profileImageStatus: "removed" }).status).toBe("removed");
    expect(resolveProspectProfileImage({ ...base, profileImageStatus: "removed" }).url).toBeNull();
    expect(resolveProspectProfileImage({ ...base, profileImageStatus: "blocked_by_policy" }).url).toBeNull();
  });

  it("normalizes unknown/invalid status and source to safe defaults", () => {
    const r = resolveProspectProfileImage({ profileImageStatus: "garbage", profileImageSource: "scrape" });
    expect(r.status).toBe("unknown");
    expect(r.source_type).toBeNull();
    expect(r.url).toBeNull();
  });
});
