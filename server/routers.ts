import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { workspaceRouter } from "./routers/workspace";
import { accountsRouter, contactsRouter, leadsRouter, opportunitiesRouter, productsRouter, territoriesRouter } from "./routers/crm";
import { activitiesRouter, attachmentsRouter, tasksRouter } from "./routers/activities";
import { emailDraftsRouter, sequencesRouter } from "./routers/sequences";
import { csRouter } from "./routers/cs";
import { auditRouter, campaignsRouter, dashboardsRouter, notificationsRouter, quotesRouter, scimRouter, socialRouter, workflowsRouter } from "./routers/operations";
import { leadRoutingRouter, leadScoringRouter } from "./routers/leadScoring";
import { settingsRouter, teamRouter, usageRouter } from "./routers/admin";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  workspace: workspaceRouter,
  accounts: accountsRouter,
  contacts: contactsRouter,
  leads: leadsRouter,
  opportunities: opportunitiesRouter,
  territories: territoriesRouter,
  products: productsRouter,
  tasks: tasksRouter,
  activities: activitiesRouter,
  attachments: attachmentsRouter,
  sequences: sequencesRouter,
  emailDrafts: emailDraftsRouter,
  cs: csRouter,
  workflows: workflowsRouter,
  social: socialRouter,
  campaigns: campaignsRouter,
  dashboards: dashboardsRouter,
  quotes: quotesRouter,
  audit: auditRouter,
  notifications: notificationsRouter,
  scim: scimRouter,
  leadScoring: leadScoringRouter,
  leadRouting: leadRoutingRouter,
  settings: settingsRouter,
  team: teamRouter,
  usage: usageRouter,
});

export type AppRouter = typeof appRouter;
