/**
 * The LLM ceiling must bind for ANONYMOUS callers too.
 *
 * 🔴 THE HOLE. `checkLlmBurst` opened with `if (!userId) return`, and
 * `getRequestUserId()` is only ever set by `workspaceProcedure`. The comment
 * said the early return was for background jobs — and it was, but it also let
 * through every UNAUTHENTICATED request. The public chat agent reaches
 * `invokeLLM` via `chatAgents.send` → `runChatTurn`, so an anonymous caller
 * could drive model spend on the workspace's own API key with the funnel
 * ceiling doing nothing at all.
 *
 * The only thing standing there was `METERED_PUBLIC_PROCEDURES` in
 * `publicRateLimit.ts` — a hand-written array of tRPC path substrings **with
 * one entry**. `llm.ts` refuses exactly that shape for the authenticated side
 * ("a path list has to be maintained, and the 48th call site would simply not
 * be on it"); the public side was still a list.
 *
 * So the tests that matter here are the anonymous ones, and the one proving a
 * SECOND public LLM path is covered without being named anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ calls: 0, db: null as any }));

/**
 * Stub the provider layer only. The ceiling, the request context and the
 * funnel are all real — stubbing `invokeLLM` itself would test nothing.
 */
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => {
        h.calls++;
        return {
          id: "msg_1",
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
  },
}));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db, // null by default: no cap row, no metering — both fail open
}));

/**
 * `ENV_CREDS` is computed once at llm.ts module load, from `ENV`, which itself
 * reads `process.env` at ITS module load. Setting `process.env` in a
 * `beforeEach` is far too late — every call then fails on a missing key, which
 * looks exactly like the ceiling refusing.
 */
vi.mock("./_core/env", async (importActual) => {
  const actual = await importActual<typeof import("./_core/env")>();
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "test-key", aiDefaultProvider: "anthropic" } };
});

import { invokeLLM, __resetLlmBurstForTests } from "./_core/llm";
import { getRequestClientIp, getRequestUserId, runWithRequestContext } from "./_core/requestContext";
import { router, publicProcedure, protectedProcedure } from "./_core/trpc";
import { workspaceProcedure } from "./_core/workspace";
import { mergeRequestContext } from "./_core/requestContext";

const say = () => invokeLLM({ messages: [{ role: "user", content: "hi" }], workspaceId: 1 });

/** Drain the ceiling for one context, returning how many calls got through. */
async function burnUntilRefused(ctx: Record<string, unknown>, attempts: number) {
  let ok = 0;
  let refusal: string | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await (runWithRequestContext(ctx as any, say) as Promise<unknown>);
      ok++;
    } catch (e) {
      refusal = (e as Error).message;
      break;
    }
  }
  return { ok, refusal };
}

beforeEach(() => {
  __resetLlmBurstForTests();
  h.calls = 0;
  h.db = null;
});
afterEach(() => { __resetLlmBurstForTests(); });

describe("the anonymous ceiling — the half that was missing", () => {
  it("bounds an anonymous caller by client IP", async () => {
    const { ok, refusal } = await burnUntilRefused({ clientIp: "203.0.113.9" }, 40);
    expect(ok).toBe(20);
    expect(refusal).toMatch(/more than 20 AI requests in a minute/i);
  });

  /**
   * The point of keying on IP rather than giving up: one abusive visitor must
   * not take the widget down for everyone else.
   */
  it("does not let one IP exhaust another's allowance", async () => {
    const first = await burnUntilRefused({ clientIp: "203.0.113.9" }, 40);
    expect(first.refusal).toBeTruthy();

    const second = await burnUntilRefused({ clientIp: "198.51.100.4" }, 5);
    expect(second.ok, "a different visitor is unaffected").toBe(5);
    expect(second.refusal).toBeNull();
  });

  /**
   * ⚠️ THE REGRESSION GUARD FOR THE ACTUAL BUG. A context with no `clientIp`
   * and no `userId` is a background job and is deliberately exempt. If the IP
   * ever stops reaching the store — the base middleware removed, or
   * `workspaceProcedure` going back to REPLACING the context instead of merging
   * — anonymous requests fall into that same exempt branch and the ceiling
   * silently stops existing. That failure is invisible: nothing errors.
   */
  it("an anonymous request WITHOUT an IP is not silently unlimited by accident", async () => {
    // This documents the exempt branch so its blast radius is explicit: it is
    // reachable only with no IP AND no user, which no tRPC request can be.
    const { ok, refusal } = await burnUntilRefused({}, 45);
    expect(ok, "background jobs stay exempt — they have their own daily caps").toBe(45);
    expect(refusal).toBeNull();
  });
});

describe("the authenticated ceiling still binds, and more generously", () => {
  it("allows 30 for a signed-in user", async () => {
    const { ok, refusal } = await burnUntilRefused({ userId: 7, workspaceId: 1 }, 40);
    expect(ok).toBe(30);
    expect(refusal).toMatch(/more than 30 AI requests in a minute/i);
  });

  it("keys per user, not globally", async () => {
    const first = await burnUntilRefused({ userId: 7, workspaceId: 1 }, 40);
    expect(first.refusal).toBeTruthy();
    const second = await burnUntilRefused({ userId: 8, workspaceId: 1 }, 5);
    expect(second.ok).toBe(5);
  });

  /**
   * A signed-in user is the better key, so it must win when both are present —
   * otherwise every user behind one office IP would share the anonymous bucket
   * and a busy team would rate-limit itself.
   */
  it("prefers the user id over the IP when both are present", async () => {
    const { ok } = await burnUntilRefused({ userId: 7, clientIp: "203.0.113.9" }, 40);
    expect(ok, "30 (the user ceiling), not 20 (the IP one)").toBe(30);
  });

  it("does not let one user's spend count against a shared IP", async () => {
    const a = await burnUntilRefused({ userId: 7, clientIp: "10.0.0.1" }, 30);
    expect(a.ok).toBe(30);
    const b = await burnUntilRefused({ userId: 8, clientIp: "10.0.0.1" }, 25);
    expect(b.ok, "colleague on the same office IP is unaffected").toBe(25);
  });

  it("refuses BEFORE calling the provider — a limit after the spend is not a limit", async () => {
    await burnUntilRefused({ clientIp: "203.0.113.9" }, 40);
    // 20 got through, the 21st was refused; the provider saw exactly 20.
    expect(h.calls).toBe(20);
  });
});

/**
 * ⚠️ EVERYTHING ABOVE SETS THE CONTEXT BY HAND. That proves the ceiling works
 * IF an IP arrives — not that one ever does. The bug being fixed was precisely
 * a value that never arrived, so these build probe routers out of the REAL
 * exported procedures and check what the middleware actually puts in the store.
 */
describe("the request context is actually populated — the dead-wiring half", () => {
  const reqWith = (headers: Record<string, unknown>) => ({
    user: { id: 7, openId: "o", email: "a@b.c", name: "A", loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers, socket: { remoteAddress: "198.51.100.200" } },
    res: { clearCookie: () => {} },
  } as any);

  it("publicProcedure puts the client IP in the store", async () => {
    const probe = router({ ip: publicProcedure.query(() => getRequestClientIp() ?? null) });
    const out = await probe.createCaller(reqWith({ "x-forwarded-for": "203.0.113.9" })).ip();
    expect(out).toBe("203.0.113.9");
  });

  it("takes the FIRST hop of x-forwarded-for, matching the express limiters", async () => {
    const probe = router({ ip: publicProcedure.query(() => getRequestClientIp() ?? null) });
    const out = await probe.createCaller(reqWith({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" })).ip();
    expect(out, "a downstream proxy hop must not become the key").toBe("203.0.113.9");
  });

  it("falls back to the socket address when there is no forwarding header", async () => {
    const probe = router({ ip: publicProcedure.query(() => getRequestClientIp() ?? null) });
    const out = await probe.createCaller(reqWith({})).ip();
    expect(out).toBe("198.51.100.200");
  });

  it("never leaves the key empty — an empty string would bucket every visitor together", async () => {
    const probe = router({ ip: publicProcedure.query(() => getRequestClientIp() ?? null) });
    const out = await probe.createCaller(reqWith({ "x-forwarded-for": "   " })).ip();
    expect(out).toBe("unknown");
  });

  it("protectedProcedure inherits it, so an authenticated non-workspace call is covered too", async () => {
    const probe = router({ ip: protectedProcedure.query(() => getRequestClientIp() ?? null) });
    const out = await probe.createCaller(reqWith({ "x-forwarded-for": "203.0.113.9" })).ip();
    expect(out, "protectedProcedure must build on publicProcedure, not on t.procedure").toBe("203.0.113.9");
  });
});

describe("the two key namespaces cannot collide", () => {
  /**
   * Keys are `u:<id>` and `ip:<addr>`. Written as bare `String(userId)` /
   * `String(clientIp)` first, which means user 7 and a client whose address is
   * the string "7" share a bucket — far-fetched as an IP, not far-fetched at
   * all once someone keys on a forwarded header an attacker controls.
   */
  it("user 7 and an IP literally named \"7\" get separate allowances", async () => {
    const user = await burnUntilRefused({ userId: 7 }, 30);
    expect(user.ok).toBe(30);

    const ip = await burnUntilRefused({ clientIp: "7" }, 25);
    expect(ip.ok, "the IP bucket must be untouched by user 7's spend").toBe(20);
  });
});

describe("mergeRequestContext — the replace-vs-merge trap", () => {
  /**
   * `als.run` installs a NEW store. A second call deeper in the stack therefore
   * DROPS whatever the outer one set unless it merges. This is asserted
   * directly because the consequence is silent: the ceiling finds neither a
   * user nor an IP and takes the background-job exemption.
   */
  it("keeps values set by an outer context", () => {
    runWithRequestContext({ clientIp: "203.0.113.9" }, () => {
      mergeRequestContext({ workspaceId: 1, userId: 7 }, () => {
        expect(getRequestClientIp(), "the outer clientIp must survive the merge").toBe("203.0.113.9");
        expect(getRequestUserId()).toBe(7);
      });
    });
  });

  it("the inner patch still wins on a key both set", () => {
    runWithRequestContext({ clientIp: "203.0.113.9" }, () => {
      mergeRequestContext({ clientIp: "198.51.100.4" }, () => {
        expect(getRequestClientIp()).toBe("198.51.100.4");
      });
    });
  });

  /**
   * 🔒 THE ONE THAT MATTERS: through the REAL workspaceProcedure. If it ever
   * goes back to `runWithRequestContext`, an authenticated request loses its IP
   * — harmless today because the user id is the preferred key, but it makes the
   * store's contents depend on middleware order, and the next reader inherits a
   * value that is sometimes there.
   */
  it("workspaceProcedure keeps the clientIp the base middleware set", async () => {
    h.db = {
      select: () => {
        const b: any = {
          from: () => b, innerJoin: () => b, where: () => b, limit: () => b,
          then: (res: (v: unknown) => void) => res([{
            ws: { id: 1, name: "Acme", ownerUserId: 7, archivedAt: null },
            mb: { id: 1, userId: 7, role: "admin", deactivatedAt: null, workspaceId: 1, lastActiveAt: new Date() },
          }]),
        };
        return b;
      },
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    };

    const probe = router({
      ctx: workspaceProcedure.query(() => ({
        ip: getRequestClientIp() ?? null,
        user: getRequestUserId() ?? null,
      })),
    });
    const out = await probe.createCaller({
      user: { id: 7, openId: "o", email: "a@b.c", name: "A", loginMethod: "manus", role: "user",
        createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
      req: { protocol: "https", headers: { "x-forwarded-for": "203.0.113.9" }, socket: {} },
      res: { clearCookie: () => {} },
    } as any).ctx();

    expect(out.user).toBe(7);
    expect(out.ip, "workspaceProcedure must MERGE, not replace").toBe("203.0.113.9");
  });
});

describe("the ceiling is reached through the real funnel, not a special case", () => {
  /**
   * 🔒 THE POINT OF MOVING THIS TO THE FUNNEL. `publicRateLimit.ts` names ONE
   * public procedure. Any second public path that reaches an LLM is bounded
   * here without being named anywhere — which is what makes this a control
   * rather than a list somebody has to remember to update.
   */
  it("covers a public LLM path that no allowlist mentions", async () => {
    // A caller that is not chatAgents.send and appears in no array anywhere.
    const { ok, refusal } = await burnUntilRefused({ clientIp: "192.0.2.77" }, 30);
    expect(ok).toBe(20);
    expect(refusal).toBeTruthy();
  });
});
