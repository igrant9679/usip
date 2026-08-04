import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { mergeRequestContext } from "./requestContext";

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
  const fwd = ctx.req?.headers?.["x-forwarded-for"];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd) ?? ctx.req?.socket?.remoteAddress;
  // Same derivation as the express limiters: first hop past our own proxy.
  const clientIp = String(raw ?? "unknown").split(",")[0]!.trim() || "unknown";
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
