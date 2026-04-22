import {
  bigint,
  boolean,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/* ──────────────────────────────────────────────────────────────────────────
   Auth & Multi-tenancy
   ────────────────────────────────────────────────────────────────────────── */

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  avatarUrl: text("avatarUrl"),
  loginMethod: varchar("loginMethod", { length: 64 }),
  // Global super-admin flag (template default; we keep but use workspaceMembers.role for app roles)
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const workspaces = mysqlTable("workspaces", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  ownerUserId: int("ownerUserId").notNull(),
  logoUrl: text("logoUrl"),
  plan: mysqlEnum("plan", ["trial", "starter", "growth", "scale"]).default("trial").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type Workspace = typeof workspaces.$inferSelect;

export const workspaceMembers = mysqlTable(
  "workspace_members",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    role: mysqlEnum("role", ["super_admin", "admin", "manager", "rep"]).default("rep").notNull(),
    title: varchar("title", { length: 120 }),
    territoryId: int("territoryId"),
    quota: decimal("quota", { precision: 14, scale: 2 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("uq_ws_user").on(t.workspaceId, t.userId),
    byWs: index("ix_wsm_ws").on(t.workspaceId),
  }),
);
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Territories (Module 10)
   ────────────────────────────────────────────────────────────────────────── */

export const territories = mysqlTable(
  "territories",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    rules: json("rules"), // {geo:[], industries:[], sizes:[]}
    ownerUserId: int("ownerUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_terr_ws").on(t.workspaceId) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   CRM Spine
   ────────────────────────────────────────────────────────────────────────── */

export const accounts = mysqlTable(
  "accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    domain: varchar("domain", { length: 200 }),
    industry: varchar("industry", { length: 80 }),
    employeeBand: varchar("employeeBand", { length: 40 }),
    revenueBand: varchar("revenueBand", { length: 40 }),
    region: varchar("region", { length: 80 }),
    parentAccountId: int("parentAccountId"), // hierarchy
    territoryId: int("territoryId"),
    ownerUserId: int("ownerUserId"),
    arr: decimal("arr", { precision: 14, scale: 2 }).default("0"),
    color: varchar("color", { length: 16 }),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_acc_ws").on(t.workspaceId),
    byParent: index("ix_acc_parent").on(t.parentAccountId),
  }),
);
export type Account = typeof accounts.$inferSelect;

export const contacts = mysqlTable(
  "contacts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("accountId"),
    firstName: varchar("firstName", { length: 80 }).notNull(),
    lastName: varchar("lastName", { length: 80 }).notNull(),
    title: varchar("title", { length: 120 }),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    linkedinUrl: text("linkedinUrl"),
    city: varchar("city", { length: 80 }),
    seniority: varchar("seniority", { length: 32 }),
    isPrimary: boolean("isPrimary").default(false).notNull(),
    ownerUserId: int("ownerUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_con_ws").on(t.workspaceId),
    byAcc: index("ix_con_acc").on(t.accountId),
  }),
);
export type Contact = typeof contacts.$inferSelect;

export const leads = mysqlTable(
  "leads",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    firstName: varchar("firstName", { length: 80 }).notNull(),
    lastName: varchar("lastName", { length: 80 }).notNull(),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    company: varchar("company", { length: 200 }),
    title: varchar("title", { length: 120 }),
    source: varchar("source", { length: 60 }),
    status: mysqlEnum("status", [
      "new",
      "working",
      "qualified",
      "unqualified",
      "converted",
    ]).default("new").notNull(),
    score: int("score").default(0).notNull(), // 0-100
    grade: varchar("grade", { length: 4 }), // A/B/C/D
    scoreReasons: json("scoreReasons"),
    tags: json("tags"),
    convertedContactId: int("convertedContactId"),
    convertedAccountId: int("convertedAccountId"),
    convertedOpportunityId: int("convertedOpportunityId"),
    ownerUserId: int("ownerUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_lead_ws").on(t.workspaceId),
    byScore: index("ix_lead_score").on(t.workspaceId, t.score),
  }),
);
export type Lead = typeof leads.$inferSelect;

export const opportunities = mysqlTable(
  "opportunities",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("accountId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    stage: mysqlEnum("stage", [
      "discovery",
      "qualified",
      "proposal",
      "negotiation",
      "won",
      "lost",
    ]).default("discovery").notNull(),
    value: decimal("value", { precision: 14, scale: 2 }).default("0").notNull(),
    winProb: int("winProb").default(20).notNull(),
    closeDate: timestamp("closeDate"),
    daysInStage: int("daysInStage").default(0).notNull(),
    aiNote: text("aiNote"),
    nextStep: text("nextStep"),
    lostReason: varchar("lostReason", { length: 120 }),
    campaignId: int("campaignId"),
    ownerUserId: int("ownerUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_opp_ws").on(t.workspaceId),
    byStage: index("ix_opp_stage").on(t.workspaceId, t.stage),
  }),
);
export type Opportunity = typeof opportunities.$inferSelect;

export const opportunityContactRoles = mysqlTable(
  "opportunity_contact_roles",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    opportunityId: int("opportunityId").notNull(),
    contactId: int("contactId").notNull(),
    role: mysqlEnum("role", [
      "champion",
      "decision_maker",
      "influencer",
      "evaluator",
      "blocker",
      "user",
      "other",
    ]).default("influencer").notNull(),
    isPrimary: boolean("isPrimary").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byOpp: index("ix_ocr_opp").on(t.opportunityId),
    uq: uniqueIndex("uq_ocr").on(t.opportunityId, t.contactId, t.role),
  }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Tasks & Activities
   ────────────────────────────────────────────────────────────────────────── */

export const tasks = mysqlTable(
  "tasks",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    type: mysqlEnum("type", [
      "call",
      "email",
      "meeting",
      "linkedin",
      "todo",
      "follow_up",
    ]).default("todo").notNull(),
    priority: mysqlEnum("priority", ["low", "normal", "high", "urgent"]).default("normal").notNull(),
    status: mysqlEnum("status", ["open", "done", "cancelled"]).default("open").notNull(),
    dueAt: timestamp("dueAt"),
    completedAt: timestamp("completedAt"),
    ownerUserId: int("ownerUserId"),
    relatedType: varchar("relatedType", { length: 30 }),
    relatedId: int("relatedId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byOwner: index("ix_task_owner").on(t.workspaceId, t.ownerUserId, t.status),
    byRel: index("ix_task_rel").on(t.relatedType, t.relatedId),
  }),
);

export const activities = mysqlTable(
  "activities",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    type: mysqlEnum("type", [
      "call",
      "meeting",
      "email",
      "note",
      "linkedin",
      "stage_change",
      "system",
    ]).notNull(),
    relatedType: varchar("relatedType", { length: 30 }).notNull(), // account|contact|lead|opportunity|customer
    relatedId: int("relatedId").notNull(),
    subject: varchar("subject", { length: 240 }),
    body: text("body"), // markdown notes
    // Call fields
    callDisposition: mysqlEnum("callDisposition", [
      "connected",
      "voicemail",
      "no_answer",
      "bad_number",
      "gatekeeper",
      "callback_requested",
      "not_interested",
    ]),
    callDurationSec: int("callDurationSec"),
    callOutcome: text("callOutcome"),
    // Meeting fields
    meetingStartedAt: timestamp("meetingStartedAt"),
    meetingEndedAt: timestamp("meetingEndedAt"),
    meetingAttendees: json("meetingAttendees"),
    mentions: json("mentions"), // [userId,...]
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
    actorUserId: int("actorUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byRel: index("ix_act_rel").on(t.relatedType, t.relatedId),
    byWs: index("ix_act_ws").on(t.workspaceId, t.occurredAt),
  }),
);

export const attachments = mysqlTable(
  "attachments",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    relatedType: varchar("relatedType", { length: 30 }).notNull(),
    relatedId: int("relatedId").notNull(),
    fileKey: varchar("fileKey", { length: 512 }).notNull(),
    url: text("url").notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    mimeType: varchar("mimeType", { length: 120 }),
    sizeBytes: int("sizeBytes"),
    uploadedByUserId: int("uploadedByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byRel: index("ix_att_rel").on(t.relatedType, t.relatedId) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Sequences & Enrollments & Email Drafts
   ────────────────────────────────────────────────────────────────────────── */

export const sequences = mysqlTable(
  "sequences",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    status: mysqlEnum("status", ["draft", "active", "paused", "archived"]).default("draft").notNull(),
    steps: json("steps").notNull(), // [{type:'email'|'wait'|'task', ...}]
    ownerUserId: int("ownerUserId"),
    enrolledCount: int("enrolledCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_seq_ws").on(t.workspaceId) }),
);

export const enrollments = mysqlTable(
  "enrollments",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    sequenceId: int("sequenceId").notNull(),
    contactId: int("contactId"),
    leadId: int("leadId"),
    status: mysqlEnum("status", ["active", "paused", "finished", "exited"]).default("active").notNull(),
    currentStep: int("currentStep").default(0).notNull(),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    nextActionAt: timestamp("nextActionAt"),
  },
  (t) => ({ bySeq: index("ix_enr_seq").on(t.sequenceId) }),
);

export const emailDrafts = mysqlTable(
  "email_drafts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    subject: varchar("subject", { length: 240 }).notNull(),
    body: text("body").notNull(),
    toContactId: int("toContactId"),
    toLeadId: int("toLeadId"),
    toEmail: varchar("toEmail", { length: 320 }),
    sequenceId: int("sequenceId"),
    enrollmentId: int("enrollmentId"),
    status: mysqlEnum("status", ["pending_review", "approved", "rejected", "sent"]).default("pending_review").notNull(),
    aiGenerated: boolean("aiGenerated").default(true).notNull(),
    aiPrompt: text("aiPrompt"),
    createdByUserId: int("createdByUserId"),
    reviewedByUserId: int("reviewedByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    sentAt: timestamp("sentAt"),
  },
  (t) => ({ byWs: index("ix_ed_ws").on(t.workspaceId, t.status) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Customer Success
   ────────────────────────────────────────────────────────────────────────── */

export const customers = mysqlTable(
  "customers",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("accountId").notNull(),
    arr: decimal("arr", { precision: 14, scale: 2 }).default("0").notNull(),
    contractStart: timestamp("contractStart"),
    contractEnd: timestamp("contractEnd"),
    tier: mysqlEnum("tier", ["enterprise", "midmarket", "smb"]).default("midmarket").notNull(),
    cmUserId: int("cmUserId"), // customer success manager
    // Health
    healthScore: int("healthScore").default(50).notNull(), // 0-100
    healthTier: mysqlEnum("healthTier", ["healthy", "watch", "at_risk", "critical"]).default("watch").notNull(),
    usageScore: int("usageScore").default(50).notNull(),
    engagementScore: int("engagementScore").default(50).notNull(),
    supportScore: int("supportScore").default(50).notNull(),
    npsScore: int("npsScore").default(0).notNull(), // -100..100
    npsHistory: json("npsHistory"),
    expansionPotential: decimal("expansionPotential", { precision: 14, scale: 2 }).default("0"),
    aiPlay: text("aiPlay"),
    renewalStage: mysqlEnum("renewalStage", [
      "early",
      "ninety",
      "sixty",
      "thirty",
      "at_risk",
      "renewed",
      "churned",
    ]).default("early").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_cust_ws").on(t.workspaceId) }),
);

export const qbrs = mysqlTable(
  "qbrs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    customerId: int("customerId").notNull(),
    scheduledAt: timestamp("scheduledAt"),
    completedAt: timestamp("completedAt"),
    status: mysqlEnum("status", ["scheduled", "completed", "cancelled"]).default("scheduled").notNull(),
    aiPrep: json("aiPrep"), // {wins, risks, asks, agenda}
    notes: text("notes"),
    nextActions: json("nextActions"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byCust: index("ix_qbr_cust").on(t.customerId) }),
);

export const contractAmendments = mysqlTable(
  "contract_amendments",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    customerId: int("customerId").notNull(),
    type: mysqlEnum("type", ["upgrade", "downgrade", "addon", "renewal", "termination", "price_change"]).notNull(),
    arrDelta: decimal("arrDelta", { precision: 14, scale: 2 }).default("0").notNull(),
    effectiveAt: timestamp("effectiveAt").notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    createdByUserId: int("createdByUserId"),
  },
  (t) => ({ byCust: index("ix_amend_cust").on(t.customerId) }),
);

export const supportTickets = mysqlTable(
  "support_tickets",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    customerId: int("customerId").notNull(),
    subject: varchar("subject", { length: 240 }).notNull(),
    severity: mysqlEnum("severity", ["low", "medium", "high", "urgent"]).default("medium").notNull(),
    status: mysqlEnum("status", ["open", "pending", "resolved", "closed"]).default("open").notNull(),
    openedAt: timestamp("openedAt").defaultNow().notNull(),
    resolvedAt: timestamp("resolvedAt"),
  },
  (t) => ({ byCust: index("ix_tic_cust").on(t.customerId) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Workflow Automation
   ────────────────────────────────────────────────────────────────────────── */

export const workflowRules = mysqlTable(
  "workflow_rules",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    enabled: boolean("enabled").default(true).notNull(),
    triggerType: mysqlEnum("triggerType", [
      "record_created",
      "record_updated",
      "stage_changed",
      "task_overdue",
      "nps_submitted",
      "signal_received",
      "field_equals",
      "schedule",
    ]).notNull(),
    triggerConfig: json("triggerConfig").notNull(),
    conditions: json("conditions").notNull(), // [{field, op, value}]
    actions: json("actions").notNull(), // [{type, params}]
    fireCount: int("fireCount").default(0).notNull(),
    lastFiredAt: timestamp("lastFiredAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_wf_ws").on(t.workspaceId) }),
);

export const workflowRuns = mysqlTable(
  "workflow_runs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    ruleId: int("ruleId").notNull(),
    triggeredBy: varchar("triggeredBy", { length: 60 }),
    relatedType: varchar("relatedType", { length: 30 }),
    relatedId: int("relatedId"),
    status: mysqlEnum("status", ["success", "failed", "skipped"]).notNull(),
    actionsRun: json("actionsRun"),
    errorMessage: text("errorMessage"),
    runAt: timestamp("runAt").defaultNow().notNull(),
  },
  (t) => ({ byRule: index("ix_wfr_rule").on(t.ruleId, t.runAt) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Social Publishing
   ────────────────────────────────────────────────────────────────────────── */

export const socialAccounts = mysqlTable(
  "social_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    platform: mysqlEnum("platform", ["linkedin", "twitter", "facebook", "instagram"]).notNull(),
    handle: varchar("handle", { length: 120 }).notNull(),
    displayName: varchar("displayName", { length: 200 }),
    avatarUrl: text("avatarUrl"),
    connected: boolean("connected").default(false).notNull(),
    accessTokenStub: varchar("accessTokenStub", { length: 64 }), // mock — never store real tokens here
    connectedAt: timestamp("connectedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_sa_ws").on(t.workspaceId) }),
);

export const socialPosts = mysqlTable(
  "social_posts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    socialAccountId: int("socialAccountId").notNull(),
    platform: mysqlEnum("platform", ["linkedin", "twitter", "facebook", "instagram"]).notNull(),
    body: text("body").notNull(),
    mediaUrls: json("mediaUrls"),
    firstComment: text("firstComment"),
    status: mysqlEnum("status", [
      "draft",
      "in_review",
      "approved",
      "scheduled",
      "published",
      "failed",
      "rejected",
    ]).default("draft").notNull(),
    scheduledFor: timestamp("scheduledFor"),
    publishedAt: timestamp("publishedAt"),
    impressions: int("impressions").default(0).notNull(),
    engagements: int("engagements").default(0).notNull(),
    clicks: int("clicks").default(0).notNull(),
    campaignId: int("campaignId"),
    aiVariants: json("aiVariants"),
    authorUserId: int("authorUserId"),
    approverUserId: int("approverUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_sp_ws").on(t.workspaceId, t.scheduledFor),
    byStatus: index("ix_sp_status").on(t.workspaceId, t.status),
  }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Campaigns
   ────────────────────────────────────────────────────────────────────────── */

export const campaigns = mysqlTable(
  "campaigns",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    objective: varchar("objective", { length: 80 }),
    status: mysqlEnum("status", ["planning", "scheduled", "live", "completed", "paused"]).default("planning").notNull(),
    startsAt: timestamp("startsAt"),
    endsAt: timestamp("endsAt"),
    budget: decimal("budget", { precision: 14, scale: 2 }).default("0"),
    targetSegment: text("targetSegment"),
    description: text("description"),
    checklist: json("checklist"),
    ownerUserId: int("ownerUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_camp_ws").on(t.workspaceId) }),
);

export const campaignComponents = mysqlTable(
  "campaign_components",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId").notNull(),
    componentType: mysqlEnum("componentType", ["sequence", "social_post", "ad", "content", "event"]).notNull(),
    componentId: int("componentId"), // id in target table when applicable
    label: varchar("label", { length: 200 }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byCamp: index("ix_cc_camp").on(t.campaignId) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Custom Dashboards
   ────────────────────────────────────────────────────────────────────────── */

export const dashboards = mysqlTable(
  "dashboards",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    layout: json("layout"), // react-grid-layout positions [{i,x,y,w,h}]
    isShared: boolean("isShared").default(true).notNull(),
    ownerUserId: int("ownerUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_dash_ws").on(t.workspaceId) }),
);

export const dashboardWidgets = mysqlTable(
  "dashboard_widgets",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    dashboardId: int("dashboardId").notNull(),
    type: mysqlEnum("type", ["kpi", "bar", "line", "pie", "funnel", "table"]).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    config: json("config").notNull(), // {metric, dimension, filters, ...}
    position: json("position"), // {x,y,w,h}
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byDash: index("ix_dw_dash").on(t.dashboardId) }),
);

export const reportSchedules = mysqlTable(
  "report_schedules",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    dashboardId: int("dashboardId").notNull(),
    frequency: mysqlEnum("frequency", ["daily", "weekly", "monthly"]).notNull(),
    recipients: json("recipients"), // [emails]
    enabled: boolean("enabled").default(true).notNull(),
    lastSentAt: timestamp("lastSentAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_rs_ws").on(t.workspaceId) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Product Catalog & Quotes (CPQ)
   ────────────────────────────────────────────────────────────────────────── */

export const products = mysqlTable(
  "products",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    sku: varchar("sku", { length: 60 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 80 }),
    listPrice: decimal("listPrice", { precision: 14, scale: 2 }).notNull(),
    cost: decimal("cost", { precision: 14, scale: 2 }).default("0"),
    billingCycle: mysqlEnum("billingCycle", ["one_time", "monthly", "annual"]).default("annual").notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_prod_ws").on(t.workspaceId),
    uqSku: uniqueIndex("uq_prod_sku").on(t.workspaceId, t.sku),
  }),
);

export const dealLineItems = mysqlTable(
  "deal_line_items",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    opportunityId: int("opportunityId").notNull(),
    productId: int("productId").notNull(),
    quantity: int("quantity").default(1).notNull(),
    unitPrice: decimal("unitPrice", { precision: 14, scale: 2 }).notNull(),
    discountPct: decimal("discountPct", { precision: 5, scale: 2 }).default("0").notNull(),
    lineTotal: decimal("lineTotal", { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byOpp: index("ix_dli_opp").on(t.opportunityId) }),
);

export const quotes = mysqlTable(
  "quotes",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    opportunityId: int("opportunityId").notNull(),
    quoteNumber: varchar("quoteNumber", { length: 40 }).notNull(),
    status: mysqlEnum("status", ["draft", "sent", "accepted", "rejected", "expired"]).default("draft").notNull(),
    expiresAt: timestamp("expiresAt"),
    subtotal: decimal("subtotal", { precision: 14, scale: 2 }).default("0").notNull(),
    discountTotal: decimal("discountTotal", { precision: 14, scale: 2 }).default("0").notNull(),
    taxTotal: decimal("taxTotal", { precision: 14, scale: 2 }).default("0").notNull(),
    total: decimal("total", { precision: 14, scale: 2 }).default("0").notNull(),
    notes: text("notes"),
    terms: text("terms"),
    pdfFileKey: varchar("pdfFileKey", { length: 512 }),
    pdfUrl: text("pdfUrl"),
    sentAt: timestamp("sentAt"),
    createdByUserId: int("createdByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byOpp: index("ix_quote_opp").on(t.opportunityId),
    uqNum: uniqueIndex("uq_quote_num").on(t.workspaceId, t.quoteNumber),
  }),
);

export const quoteLineItems = mysqlTable(
  "quote_line_items",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    quoteId: int("quoteId").notNull(),
    productId: int("productId"),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    quantity: int("quantity").default(1).notNull(),
    unitPrice: decimal("unitPrice", { precision: 14, scale: 2 }).notNull(),
    discountPct: decimal("discountPct", { precision: 5, scale: 2 }).default("0").notNull(),
    lineTotal: decimal("lineTotal", { precision: 14, scale: 2 }).notNull(),
  },
  (t) => ({ byQuote: index("ix_qli_quote").on(t.quoteId) }),
);

/* ──────────────────────────────────────────────────────────────────────────
   Audit Log, Notifications, SCIM hooks
   ────────────────────────────────────────────────────────────────────────── */

export const auditLog = mysqlTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    actorUserId: int("actorUserId"),
    action: mysqlEnum("action", ["create", "update", "delete", "login", "logout", "scim"]).notNull(),
    entityType: varchar("entityType", { length: 40 }).notNull(),
    entityId: int("entityId"),
    before: json("before"),
    after: json("after"),
    ip: varchar("ip", { length: 64 }),
    userAgent: text("userAgent"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_audit_ws").on(t.workspaceId, t.createdAt),
    byEnt: index("ix_audit_ent").on(t.entityType, t.entityId),
  }),
);

export const notifications = mysqlTable(
  "notifications",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    kind: mysqlEnum("kind", [
      "mention",
      "task_assigned",
      "task_due",
      "deal_won",
      "deal_lost",
      "renewal_due",
      "churn_risk",
      "approval_request",
      "workflow_fired",
      "system",
    ]).notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    body: text("body"),
    relatedType: varchar("relatedType", { length: 30 }),
    relatedId: int("relatedId"),
    readAt: timestamp("readAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byUser: index("ix_notif_user").on(t.workspaceId, t.userId, t.readAt) }),
);

export const scimProviders = mysqlTable(
  "scim_providers",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    bearerToken: varchar("bearerToken", { length: 128 }).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    lastEventAt: timestamp("lastEventAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_scim_ws").on(t.workspaceId) }),
);

export const scimEvents = mysqlTable(
  "scim_events",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    providerId: int("providerId").notNull(),
    resource: mysqlEnum("resource", ["Users", "Groups"]).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    payload: json("payload"),
    responseStatus: int("responseStatus"),
    receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  },
  (t) => ({ byProv: index("ix_scim_prov").on(t.providerId, t.receivedAt) }),
);


/* ──────────────────────────────────────────────────────────────────────────
   Tier-1: Lead Scoring Engine + Lead Routing (Module 9 + CRM-010)
   ────────────────────────────────────────────────────────────────────────── */

export const leadScoreConfig = mysqlTable(
  "lead_score_config",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull().unique(),
    // Firmographic weights (sum target = 40)
    firmoOrgTypeWeight: int("firmoOrgTypeWeight").default(15).notNull(),
    firmoTitleWeight: int("firmoTitleWeight").default(15).notNull(),
    firmoCompletenessWeight: int("firmoCompletenessWeight").default(10).notNull(),
    // Behavioral (sum target = 30)
    behavOpenPoints: int("behavOpenPoints").default(5).notNull(),
    behavOpenMax: int("behavOpenMax").default(15).notNull(),
    behavClickPoints: int("behavClickPoints").default(10).notNull(),
    behavClickMax: int("behavClickMax").default(20).notNull(),
    behavReplyPoints: int("behavReplyPoints").default(25).notNull(),
    behavStepPoints: int("behavStepPoints").default(3).notNull(),
    behavBouncePenalty: int("behavBouncePenalty").default(-10).notNull(),
    behavUnsubPenalty: int("behavUnsubPenalty").default(-15).notNull(),
    behavDecayPctPer30d: int("behavDecayPctPer30d").default(10).notNull(),
    // AI-fit (max 30)
    aiFitMax: int("aiFitMax").default(30).notNull(),
    // Tiers
    tierWarmMin: int("tierWarmMin").default(31).notNull(),
    tierHotMin: int("tierHotMin").default(61).notNull(),
    tierSalesReadyMin: int("tierSalesReadyMin").default(81).notNull(),
    notifyOnSalesReady: boolean("notifyOnSalesReady").default(true).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
);
export type LeadScoreConfig = typeof leadScoreConfig.$inferSelect;

export const leadScoreHistory = mysqlTable(
  "lead_score_history",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    leadId: int("leadId").notNull(),
    firmographic: int("firmographic").notNull(),
    behavioral: int("behavioral").notNull(),
    aiFit: int("aiFit").notNull(),
    total: int("total").notNull(),
    tier: varchar("tier", { length: 16 }).notNull(),
    aiFitPayload: json("aiFitPayload"),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
  },
  (t) => ({
    byLead: index("ix_lsh_lead").on(t.leadId, t.computedAt),
    byWs: index("ix_lsh_ws").on(t.workspaceId, t.computedAt),
  }),
);
export type LeadScoreHistoryRow = typeof leadScoreHistory.$inferSelect;

export const leadRoutingRules = mysqlTable(
  "lead_routing_rules",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    priority: int("priority").default(100).notNull(), // lower = higher priority
    enabled: boolean("enabled").default(true).notNull(),
    // Match conditions [{field, op, value}] evaluated by evalConditions
    conditions: json("conditions").notNull(),
    // Strategy: round_robin | geography | industry | direct
    strategy: mysqlEnum("strategy", ["round_robin", "geography", "industry", "direct"]).notNull(),
    // For round_robin: list of userIds; for direct: [userId]; for geography/industry: not used
    targetUserIds: json("targetUserIds"),
    // Round-robin pointer
    rrCursor: int("rrCursor").default(0).notNull(),
    matchCount: int("matchCount").default(0).notNull(),
    lastMatchedAt: timestamp("lastMatchedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_lrr_ws").on(t.workspaceId, t.priority),
  }),
);
export type LeadRoutingRule = typeof leadRoutingRules.$inferSelect;
