/**
 * The views of the one home page (audit 2026-10-20, U33 and X6.3; batch
 * CONB, 2026-11-08). Velocity had two homes, the Dashboard at /dashboard and
 * Home at /v2/home; they are one page now, /v2/home, with two views:
 *
 *   today    — what needs you: the attention panel, today's chips and the
 *              widgets you laid out (the old Home).
 *   pipeline — the pipeline numbers: KPIs with goals, revenue, win/loss,
 *              funnel, top reps, recent deals (the old Dashboard).
 *
 * "Set as home" picks which one opens first, stored on the person
 * (users.home_view, migration 0430) so it follows them across browsers.
 * Shared so the server's input check and the client's picker agree.
 */
export const HOME_VIEWS = ["today", "pipeline"] as const;
export type HomeView = (typeof HOME_VIEWS)[number];

/** Never chose: the dashboard, as "/" always opened for them. */
export const DEFAULT_HOME_VIEW: HomeView = "pipeline";

export function isHomeView(v: unknown): v is HomeView {
  return typeof v === "string" && (HOME_VIEWS as readonly string[]).includes(v);
}
