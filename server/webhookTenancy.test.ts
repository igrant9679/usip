/**
 * A webhook may not be told which tenant it is writing into.
 *
 * The question this sweep asked is the one `24c720e` left behind: **which id
 * columns can a PUBLIC endpoint write?** It found the answer for the tracker
 * beacon; the webhook surface had never been asked.
 *
 * 🔴 `/api/unipile/account-webhook` took `userId` and `workspaceId` STRAIGHT
 * FROM THE QUERY STRING, unauthenticated and unsigned, and wrote them into
 * `unipile_accounts` — and into the `sending_accounts` and `calendar_accounts`
 * bridges. So a POST naming someone else's workspace planted A MAILBOX AND A
 * CALENDAR in it, and a sending account is something the victim's outbound
 * engine can send through.
 *
 * The other SIX handlers in that same file resolve the workspace by looking up
 * `unipile_accounts` by the provider's `account_id` — tenancy derived from a
 * row we already own. Six right, one wrong, one file. The wrong one felt safe
 * because the `notify_url` is minted by us, which is precisely the reason its
 * query string reads as trustworthy and is not.
 *
 * The barrier that stopped it being trivial was real but thin: the handler
 * calls getUnipileAccount() first, so `account_id` must exist in OUR Unipile
 * tenant. Every user who has connected an account knows one of those.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const webhookSrc = strip(readFileSync(join(ROOT, "server/unipileWebhook.ts"), "utf8"));

/** One `app.post(...)` handler, bounded at the next one. */
function handler(src: string, routePath: string): string {
  const at = src.indexOf(routePath);
  expect(at, `${routePath} not found`).toBeGreaterThan(0);
  const next = src.indexOf("app.post(", at + 1);
  return next > at ? src.slice(at, next) : src.slice(at);
}

describe("the scanner has something to scan", () => {
  it("finds all seven unipile webhooks", () => {
    const routes = [...webhookSrc.matchAll(/"(\/api\/unipile\/[a-z-]+)"/g)].map((m) => m[1]);
    expect(new Set(routes).size).toBe(7);
  });
});

describe("account-webhook verifies the tenant it is handed", () => {
  const accountHook = handler(webhookSrc, '"/api/unipile/account-webhook"');

  it("isolated the handler and did not run past it", () => {
    expect(accountHook.length).toBeGreaterThan(500);
    expect(accountHook).not.toContain("/api/unipile/status-webhook");
  });

  it("checks the (userId, workspaceId) pair against workspaceMembers", () => {
    expect(
      accountHook,
      "\n\nThis handler takes its workspace from the QUERY STRING. Without a\n" +
        "membership check, a POST naming any workspace plants a sending account\n" +
        "and a calendar account in it.\n",
    ).toContain("workspaceMembers");
    expect(accountHook).toMatch(/eq\(\s*workspaceMembers\.userId\s*,\s*userId\s*\)/);
    expect(accountHook).toMatch(/eq\(\s*workspaceMembers\.workspaceId\s*,\s*workspaceId\s*\)/);
  });

  it("the value it gates on COMES FROM that query", () => {
    /**
     * Binding tied to its source. The earlier assertions only proved the query
     * EXISTS and that `if (!membership)` precedes the write — a mutation that
     * left the query in place but bound `membership` to a literal passed both,
     * because the check was still there and still first. It was just answering
     * a question nobody asked.
     */
    expect(
      accountHook,
      "\n\n`membership` must be the RESULT of the workspaceMembers lookup, not a\n" +
        "value that merely sits next to it.\n",
    ).toMatch(/const \[membership\] = await [\s\S]{0,240}?from\(workspaceMembers\)/);
  });

  it("REFUSES before writing anything, not after", () => {
    // Ordering is the whole point — the delete sweep's lesson was that a check
    // which runs after the work is not a check.
    const gate = accountHook.indexOf("if (!membership)");
    const firstWrite = accountHook.indexOf("db.insert(");
    expect(gate, "no membership refusal found").toBeGreaterThan(0);
    expect(firstWrite, "no insert found — has this handler changed?").toBeGreaterThan(0);
    expect(
      gate,
      "\n\nThe membership check must precede every write in this handler.\n",
    ).toBeLessThan(firstWrite);
  });

  it("also refuses when the DB is unavailable rather than writing unverified", () => {
    expect(accountHook).toMatch(/if \(!dbCheck\)/);
  });
});

describe("no OTHER unipile webhook takes its tenant from the caller", () => {
  const OTHERS = [
    "/api/unipile/status-webhook",
    "/api/unipile/messaging-webhook",
    "/api/unipile/users-webhook",
    "/api/unipile/mail-webhook",
    "/api/unipile/calendar-webhook",
    "/api/unipile/email-tracking-webhook",
  ];

  it.each(OTHERS)("%s resolves the workspace from a stored row", (route) => {
    const body = handler(webhookSrc, `"${route}"`);
    expect(
      body,
      `\n\n${route} reads req.query. A webhook must not be TOLD which tenant it\n` +
        `is writing into — resolve it from unipile_accounts by account_id, the\n` +
        `way the other handlers do.\n`,
    ).not.toContain("req.query");
  });

  it("account-webhook is the only req.query use in the file", () => {
    // If a second one appears, it needs the same verification.
    const uses = (webhookSrc.match(/req\.query/g) ?? []).length;
    expect(uses).toBe(2); // userId + workspaceId, both in account-webhook
  });
});

/**
 * The wider question, kept alive: any NEW express route that writes a
 * caller-supplied workspaceId is the same bug. This is a lead generator, not a
 * proof — it only sees the literal pattern.
 */
describe("no route writes a workspaceId parsed from the query string", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const files = sourceFiles(join(ROOT, "server"));

  it("finds source to scan (guards the scanner itself)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every query-string workspaceId is verified in the same file", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = strip(readFileSync(f, "utf8"));
      if (!/req\.query\.workspaceId/.test(src)) continue;
      // Having one is fine — believing it without checking is not.
      if (!src.includes("workspaceMembers")) {
        offenders.push(f.slice(ROOT.length + 1).split(sep).join("/"));
      }
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nThese read workspaceId from the query string and never check it\n` +
            `against workspaceMembers:\n  ${offenders.join("\n  ")}\n`
        : undefined,
    ).toEqual([]);
  });
});
