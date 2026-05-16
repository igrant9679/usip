import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

export const trpc = createTRPCReact<AppRouter>();

/**
 * Server-derived input/output types. Use these instead of hand-redefining
 * shapes on the client — they stay in lockstep with the routers so a
 * server-side shape change is a compile error here, not a silent runtime
 * mismatch. Example:
 *   type PlacesHit = RouterOutputs["placesSearch"]["textSearch"]["results"][number];
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
