import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { mergeRequestContext } from "./requestContext";
import { clientIpOf } from "./clientIp";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * Establishes the per-request async context for EVERY procedure, public ones
 * included.
 *
 * 🔴 WHY THE BASE AND NOT `workspaceProcedure`. The per-user LLM ceiling in
 * `_core/llm.ts` keys on `getRequestUserId()`, which only `workspaceProcedure`
 * ever set — so an UNAUTHENTICATED call reaching `invokeLLM` had no key and the
 * ceiling returned without doing anything. The only thing bounding public model
 * spend was `METERED_PUBLIC_PROCEDURES` in `publicRateLimit.ts`: a hand-written
 * array of tRPC path substrings, with ONE entry in it. That is the same
 * maintenance hazard `llm.ts` explicitly refuses for the authenticated side —
 * "a path list has to be maintained, and the 48th call site would simply not be
 * on it" — and the public side was still a list.
 *
 * With the client IP in the store, the funnel can bound public calls by IP with
 * nothing to maintain, and the express limiter becomes a cheap early rejection
 * rather than the only control.
 */
const withRequestContext = t.middleware(async ({ ctx, next }) => {
  // Same derivation as the express limiters: `req.ip`, which Express computes
  // from X-Forwarded-For using the trusted hop count (_core/clientIp.ts).
  //
  // 2026-10-24 (audit "also urgent"): this used to take the FIRST entry of
  // X-Forwarded-For — a value the caller writes — so rotating the header put
  // every request in a fresh bucket. It is still a RATE-LIMIT KEY, not an
  // identity: Settings → Security's IP allowlist stays unenforced until it is
  // decided separately. llmRateLimit.test.ts pins this derivation.
  const clientIp = clientIpOf(ctx.req);
  return await mergeRequestContext({ clientIp }, () => next());
});

export const publicProcedure = t.procedure.use(withRequestContext);

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireUser);

export const adminProcedure = publicProcedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
