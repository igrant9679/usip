/**
 * SSRF guard for server-side scrapers.
 *
 * The URL scraper (urlScraper.ts) fetches arbitrary user-supplied URLs and
 * the company-site scraper (companySite.ts) fetches user-influenced domains.
 * Without a guard, a user could point either at internal services or cloud
 * metadata (169.254.169.254) and exfiltrate credentials via the scraped
 * page body.
 *
 * This module provides:
 *   - assertPublicUrl(url): scheme + hostname + resolved-IP validation
 *   - safeFetch(url, opts): fetch with redirect:"manual" that re-validates
 *     every hop (so an allowed host can't 302 to an internal address)
 *
 * Residual risk acknowledged: a sophisticated DNS-rebinding attacker could
 * return a public IP to our resolution check and a private IP to the
 * subsequent fetch. Fully closing that requires pinning the resolved IP and
 * dispatching by IP with a Host header (custom undici dispatcher) — out of
 * scope here. Blocking literal internal IPs + one-shot DNS resolution of
 * hostnames covers the realistic threat for this app.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 5;

/** True if an IPv4/IPv6 string is loopback / private / link-local / reserved. */
export function isPrivateIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateIpv4(ip);
  if (fam === 6) return isPrivateIpv6(ip);
  return true; // not a valid IP → treat as unsafe
}

function isPrivateIpv4(ip: string): boolean {
  const o = ip.split(".").map((n) => parseInt(n, 10));
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 (incl. 192.0.0.x)
  if (a >= 224) return true; // multicast + reserved (224.0.0.0+)
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const head = lower.split(":")[0] ?? "";
  if (head.startsWith("fc") || head.startsWith("fd")) return true; // fc00::/7 ULA
  if (head.startsWith("fe8") || head.startsWith("fe9") || head.startsWith("fea") || head.startsWith("feb"))
    return true; // fe80::/10 link-local
  if (head.startsWith("ff")) return true; // multicast
  return false;
}

/** Hostnames that are never legitimate scrape targets regardless of DNS. */
function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal")) return true; // GCP metadata.google.internal, *.internal
  if (h.endsWith(".local")) return true; // mDNS
  if (h === "metadata" || h.endsWith(".metadata")) return true;
  return false;
}

/**
 * Validate a single URL: must be http/https, host must not be a blocked
 * name, and every resolved IP must be public. Throws Error on rejection.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked scheme: ${url.protocol} (only http/https allowed)`);
  }
  const host = url.hostname;
  if (isBlockedHostname(host)) {
    throw new Error(`Blocked host: ${host}`);
  }
  // Literal IP in the URL — check directly, no DNS.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked private/internal IP: ${host}`);
    return url;
  }
  // Hostname — resolve ALL addresses and reject if ANY is private.
  let addrs: { address: string }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${host}`);
  }
  if (addrs.length === 0) throw new Error(`No DNS records for ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error(`${host} resolves to a private/internal address (${a.address})`);
    }
  }
  return url;
}

/**
 * SSRF-safe fetch. Validates the initial URL, then follows redirects
 * manually, re-validating each hop's destination. Caps redirects at 5.
 * Signature mirrors the subset of fetch() the scrapers use.
 */
export async function safeFetch(
  rawUrl: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<Response> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await assertPublicUrl(currentUrl);
    const res = await fetch(validated.toString(), {
      headers: init.headers,
      signal: init.signal,
      redirect: "manual",
    });
    // 3xx with a Location → validate the next hop and continue.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res; // redirect with no target — let caller handle
      currentUrl = new URL(loc, validated).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}
