/**
 * Every `/api/scheduled/*` endpoint must be gated, and gated FIRST.
 *
 * Three of them are registered by one function in emailTracking.ts. Exactly one
 * — icp-regen — had a secret check, added with the note that it "was completely
 * unauthenticated — anyone could run up the bill". Its two siblings, twenty
 * lines away, had nothing. An anonymous POST to proposal-followup runs across
 * EVERY workspace: creates tasks, mails clients an expiry reminder, and flips
 * proposals to `not_accepted`. rejection-digest re-notifies every campaign
 * owner and has no dedupe marker of its own, so repeat calls repeat the digest.
 *
 * 🔴 The guard that was supposed to cover this asserted
 *      expect(src).toContain("SCHEDULED_TASK_SECRET")
 * against the WHOLE FILE. One gated endpoint satisfies it forever, no matter
 * how many ungated siblings join it — which is exactly what happened. A
 * file-level toContain is not a per-endpoint check, and this file exists
 * because that distinction cost two open endpoints.
 *
 * These tests are per-endpoint, discover the endpoints rather than listing
 * them, and assert a floor so a scan that finds nothing fails loudly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");

/** Source with comments removed — a gate mentioned in prose is not a gate. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

interface Endpoint {
  file: string;
  path: string;
  /** Handler body, from the route registration to its closing `});`. */
  body: string;
}

/**
 * Find every `app.post("/api/scheduled/…", handler)` in server/, and slice each
 * handler's body by matching braces from the registration onwards. Brace
 * counting rather than a regex, because a handler containing `});` (every one
 * of these does) truncates any lazier slice — and a truncated body reads as
 * "no gate here" or "gate present", arbitrarily.
 */
function findScheduledEndpoints(): Endpoint[] {
  const found: Endpoint[] = [];
  for (const file of sourceFiles(join(ROOT, "server"))) {
    const src = stripComments(readFileSync(file, "utf8"));
    const re = /app\.post\(\s*["'`](\/api\/scheduled\/[^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let depth = 0;
      let i = m.index + m[0].length;
      const start = i;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === "(" || c === "{") depth++;
        else if (c === ")" || c === "}") {
          depth--;
          if (depth < 0) break; // closed the app.post( call
        }
      }
      found.push({
        file: file.slice(ROOT.length + 1).split(sep).join("/"),
        path: m[1],
        body: src.slice(start, i),
      });
    }
  }
  return found;
}

const endpoints = findScheduledEndpoints();

describe("the scanner itself", () => {
  it("finds the scheduled endpoints (a scan that finds nothing must fail)", () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(3);
  });

  it("slices whole handler bodies, not a truncated prefix", () => {
    // Every one of these handlers ends by returning a JSON result. If the brace
    // matching stopped early the body would not contain it, and the gate
    // assertions below would be reading a fragment.
    for (const e of endpoints) {
      expect(e.body, `${e.file} ${e.path}`).toMatch(/res\.(json|status)\(/);
      expect(e.body.length, `${e.file} ${e.path}`).toBeGreaterThan(200);
    }
  });

  it("covers the three known endpoints by name", () => {
    const paths = endpoints.map((e) => e.path).sort();
    expect(paths).toEqual([
      "/api/scheduled/icp-regen",
      "/api/scheduled/proposal-followup",
      "/api/scheduled/rejection-digest",
    ]);
  });
});

describe("every scheduled endpoint is gated", () => {
  it.each(endpoints.map((e) => [e.path, e] as const))("%s calls requireScheduledSecret", (_path, e) => {
    expect(
      e.body,
      `\n\n${e.file} — ${e.path} has no secret check.\n\n` +
        `Add \`if (!requireScheduledSecret(req, res, "<name>")) return;\` as the FIRST\n` +
        `statement in the handler. These endpoints walk every workspace and two of\n` +
        `them send real mail; none of that should be reachable by URL alone.\n`,
    ).toContain("requireScheduledSecret");
  });

  /**
   * PRESENCE AND ORDERING ARE NOT ENOUGH — and this guard had only those two.
   *
   * Dropping the `if (!...) return;` around the call:
   *
   *     requireScheduledSecret(req, res, "rejection-digest");
   *
   * leaves the call present, ahead of getDb(), and named in every assertion
   * above — while the handler runs the entire cron for an unauthenticated
   * caller. The 401 is even written first, so the response is already sent and
   * the work happens behind it. That mutation passed this file.
   *
   * The helper's own contract says so in its header: "On refusal it has ALREADY
   * written the 401, so every caller must `return` immediately." A contract
   * nothing enforces is a comment. Same shape as the webhook gate whose
   * membership row was bound to a literal (8893dc8): the value has to be ACTED
   * ON, not merely computed.
   */
  it.each(endpoints.map((e) => [e.path, e] as const))(
    "%s RETURNS on refusal rather than calling and continuing",
    (_path, e) => {
      expect(
        e.body,
        `\n\n${e.file} — ${e.path} calls requireScheduledSecret without acting on it.\n\n` +
          `The helper writes the 401 itself and returns false; a caller that does not\n` +
          `\`return\` runs the whole cron for an anonymous request anyway. Required shape:\n` +
          `  if (!requireScheduledSecret(req, res, "<name>")) return;\n`,
      ).toMatch(/if\s*\(\s*!requireScheduledSecret\(\s*req,\s*res,\s*["'`][^"'`]+["'`]\s*\)\s*\)\s*return;/);
    },
  );

  /**
   * The route name is what lands in the rejection log. A copy-pasted handler
   * that gates correctly but reports its sibling's name sends whoever is
   * reading that log to the wrong endpoint — and copy-paste is how all three
   * of these came to differ in the first place.
   */
  it.each(endpoints.map((e) => [e.path, e] as const))("%s names ITSELF in the gate call", (path, e) => {
    const named = /requireScheduledSecret\(\s*req,\s*res,\s*["'`]([^"'`]+)["'`]/.exec(e.body);
    expect(named, `${path}: could not read the route name passed to the gate`).not.toBeNull();
    expect(path.endsWith(`/${named![1]}`), `${path} gates under the name "${named![1]}"`).toBe(true);
  });

  /**
   * Ordering matters as much as presence — the lesson from the delete sweep,
   * where a procedure verified a parent and then deleted an unrelated child.
   * A gate after the work has already started is not a gate.
   */
  it.each(endpoints.map((e) => [e.path, e] as const))("%s gates BEFORE touching the database", (_path, e) => {
    const gate = e.body.indexOf("requireScheduledSecret");
    const db = e.body.indexOf("getDb(");
    expect(gate, `${e.path}: no gate at all`).toBeGreaterThanOrEqual(0);
    if (db === -1) return; // no DB work in this handler
    expect(
      gate,
      `\n\n${e.file} — ${e.path} opens the database before checking the secret.\n` +
        `Move the requireScheduledSecret call above getDb().\n`,
    ).toBeLessThan(db);
  });
});

describe("the gate itself", () => {
  const gateSrc = stripComments(readFileSync(join(ROOT, "server/scheduledTaskAuth.ts"), "utf8"));

  it("compares in constant time, and not with ===", () => {
    expect(gateSrc).toContain("timingSafeEqual");
  });

  it("refuses by writing a 401 rather than returning a truthy value", () => {
    expect(gateSrc).toMatch(/res\.status\(401\)/);
  });

  it("no endpoint keeps its own inline copy of the check", () => {
    // The inline version in icp-regen is what its siblings failed to copy.
    for (const e of endpoints) {
      expect(e.body, `${e.file} ${e.path}`).not.toContain("process.env.SCHEDULED_TASK_SECRET");
    }
  });
});

/**
 * Everything above asserts SHAPE. This asserts the gate actually refuses
 * someone — a structural check would pass just as happily on a function whose
 * body was `return true`.
 */
describe("requireScheduledSecret behaviour", () => {
  const fakeRes = () => {
    const r = {
      code: 0,
      payload: undefined as unknown,
      status(c: number) { r.code = c; return r; },
      json(p: unknown) { r.payload = p; return r; },
    };
    return r;
  };
  const req = (headers: Record<string, string | string[]>) => ({ headers }) as never;

  const withSecret = async (value: string | undefined, fn: () => void | Promise<void>) => {
    const prev = process.env.SCHEDULED_TASK_SECRET;
    if (value === undefined) delete process.env.SCHEDULED_TASK_SECRET;
    else process.env.SCHEDULED_TASK_SECRET = value;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.SCHEDULED_TASK_SECRET;
      else process.env.SCHEDULED_TASK_SECRET = prev;
    }
  };

  it("lets the caller through when no secret is configured (documented fail-open)", async () => {
    const { requireScheduledSecret } = await import("./scheduledTaskAuth");
    await withSecret(undefined, () => {
      const res = fakeRes();
      expect(requireScheduledSecret(req({}), res as never, "t")).toBe(true);
      expect(res.code).toBe(0);
    });
  });

  it("refuses a missing header with a 401 once a secret is configured", async () => {
    const { requireScheduledSecret } = await import("./scheduledTaskAuth");
    await withSecret("s3cret", () => {
      const res = fakeRes();
      expect(requireScheduledSecret(req({}), res as never, "t")).toBe(false);
      expect(res.code).toBe(401);
    });
  });

  it("refuses a wrong secret, including one that is merely a prefix", async () => {
    const { requireScheduledSecret } = await import("./scheduledTaskAuth");
    await withSecret("s3cret", () => {
      for (const bad of ["nope", "s3cre", "s3cret!", ""]) {
        const res = fakeRes();
        expect(requireScheduledSecret(req({ "x-scheduled-secret": bad }), res as never, "t"), bad).toBe(false);
        expect(res.code, bad).toBe(401);
      }
    });
  });

  it("accepts the correct secret", async () => {
    const { requireScheduledSecret } = await import("./scheduledTaskAuth");
    await withSecret("s3cret", () => {
      const res = fakeRes();
      expect(requireScheduledSecret(req({ "x-scheduled-secret": "s3cret" }), res as never, "t")).toBe(true);
      expect(res.code).toBe(0);
    });
  });

  it("takes the first value when the header is sent twice", async () => {
    // The inline version this replaced did String(headers[...]) on the array,
    // yielding "s3cret,evil" — which matches nothing, so a duplicated header
    // was an accidental denial rather than a decision.
    const { requireScheduledSecret } = await import("./scheduledTaskAuth");
    await withSecret("s3cret", () => {
      const res = fakeRes();
      expect(requireScheduledSecret(req({ "x-scheduled-secret": ["s3cret", "evil"] }), res as never, "t")).toBe(true);
    });
  });
});

describe("an unset secret is reported at boot", () => {
  it("secretHealth warns when SCHEDULED_TASK_SECRET is missing", async () => {
    const { findSecretWarnings } = await import("./_core/secretHealth");
    const warnings = findSecretWarnings({ JWT_SECRET: "x", ENCRYPTION_KEY: "y" } as NodeJS.ProcessEnv);
    expect(warnings.map((w) => w.env)).toContain("SCHEDULED_TASK_SECRET");
  });

  it("and stays quiet when it is set", async () => {
    const { findSecretWarnings } = await import("./_core/secretHealth");
    const warnings = findSecretWarnings({
      JWT_SECRET: "x",
      ENCRYPTION_KEY: "y",
      SCHEDULED_TASK_SECRET: "z",
    } as NodeJS.ProcessEnv);
    expect(warnings.map((w) => w.env)).not.toContain("SCHEDULED_TASK_SECRET");
  });
});

describe("the rate-limit ceiling is actually mounted in front of the routes", () => {
  const indexSrc = stripComments(readFileSync(join(ROOT, "server/_core/index.ts"), "utf8"));

  it("covers /api/scheduled", () => {
    expect(stripComments(readFileSync(join(ROOT, "server/publicRateLimit.ts"), "utf8")))
      .toContain('app.use("/api/scheduled"');
  });

  /**
   * Express runs middleware in registration order. registerPublicRateLimits
   * used to be called AFTER registerEmailTrackingRoutes, which was harmless
   * while it only covered /api/trpc (mounted later still) and silently fatal
   * the moment it covered a route registered above it.
   */
  it("is registered before the routes it limits", () => {
    const limits = indexSrc.indexOf("registerPublicRateLimits(app)");
    const routes = indexSrc.indexOf("registerEmailTrackingRoutes(app)");
    const trpc = indexSrc.indexOf('app.use(\n    "/api/trpc"');
    expect(limits, "registerPublicRateLimits is not called").toBeGreaterThanOrEqual(0);
    expect(routes, "registerEmailTrackingRoutes is not called").toBeGreaterThanOrEqual(0);
    expect(
      limits,
      "\n\nThe rate limiter is mounted after the /api/scheduled routes, so Express\n" +
        "will never run it. Move registerPublicRateLimits(app) above them.\n",
    ).toBeLessThan(routes);
    if (trpc >= 0) expect(limits).toBeLessThan(trpc);
  });
});
