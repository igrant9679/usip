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
import { integrationsRouter } from "./routers/integrations";
import { quotaRouter } from "./routers/quota";
import { subjectABRouter } from "./routers/subjectAB";
import { customFieldsRouter } from "./routers/customFields";
import { dashboardLayoutsRouter } from "./routers/dashboardLayouts";
import { researchPipelineRouter } from "./routers/researchPipeline";
import { opportunityIntelligenceRouter } from "./routers/opportunityIntelligence";
import { emailTemplatesRouter, snippetsRouter, brandVoiceRouter, emailPromptTemplatesRouter } from "./routers/emailBuilder";
import { savedSectionsRouter } from "./routers/savedSections";
import { importsRouter } from "./routers/imports";
import { emailVerificationRouter } from "./routers/emailVerification";
import { linkedinRouter } from "./routers/linkedin";
import { dataHealthRouter } from "./routers/dataHealth";
import { segmentsRouter } from "./routers/segments";
import { aiPipelineRouter } from "./routers/aiPipeline";
import { pipelineAlertsRouter } from "./routers/pipelineAlerts";
import { accountBriefsRouter } from "./routers/accountBriefs";

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
  integrations: integrationsRouter,
  quota: quotaRouter,
  subjectAB: subjectABRouter,
  customFields: customFieldsRouter,
  dashboardLayouts: dashboardLayoutsRouter,
  researchPipeline: researchPipelineRouter,
  oppIntelligence: opportunityIntelligenceRouter,
  emailTemplates: emailTemplatesRouter,
  snippets: snippetsRouter,
  brandVoice: brandVoiceRouter,
  promptTemplates: emailPromptTemplatesRouter,
  savedSections: savedSectionsRouter,
  imports: importsRouter,
  emailVerification: emailVerificationRouter,
  linkedin: linkedinRouter,
  dataHealth: dataHealthRouter,
  segments: segmentsRouter,
  aiPipeline: aiPipelineRouter,
  pipelineAlerts: pipelineAlertsRouter,
  accountBriefs: accountBriefsRouter,
});

export type AppRouter = typeof appRouter;
