/**
 * Unipile credentials smoke test
 * Validates that UNIPILE_API_KEY and UNIPILE_DSN are set and that the
 * Unipile API responds with a 200 for the /accounts list endpoint.
 */
import { describe, it, expect } from "vitest";

describe("Unipile credentials", () => {
  it("UNIPILE_API_KEY and UNIPILE_DSN env vars are set", () => {
    expect(process.env.UNIPILE_API_KEY, "UNIPILE_API_KEY must be set").toBeTruthy();
    expect(process.env.UNIPILE_DSN, "UNIPILE_DSN must be set").toBeTruthy();
  });

  it("Unipile /accounts endpoint responds successfully", async () => {
    const dsn = process.env.UNIPILE_DSN!;
    const apiKey = process.env.UNIPILE_API_KEY!;

    // Normalise DSN — the DSN may be a full URL like https://api26.unipile.com:15619/api/v1/accounts
    // or just the base like https://api26.unipile.com:15619. Extract just the origin.
    const url = new URL(dsn);
    const base = `${url.protocol}//${url.host}`;

    const res = await fetch(`${base}/api/v1/accounts?limit=1`, {
      headers: {
        "X-API-KEY": apiKey,
        "Accept": "application/json",
      },
    });

    // 200 = valid credentials; 401/403 = bad key; anything else = wrong DSN
    expect(
      res.status,
      `Expected 200 from Unipile /accounts, got ${res.status}. Check UNIPILE_API_KEY and UNIPILE_DSN.`
    ).toBe(200);
  }, 15_000); // allow up to 15s for network
});
