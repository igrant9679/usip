import {
  bigint,
  boolean,
  date,
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
  archivedAt: timestamp("archivedAt"),
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
    deactivatedAt: timestamp("deactivatedAt"),
    lastActiveAt: timestamp("lastActiveAt"),
    /** Personal notification email (may differ from login email) */
    notifEmail: varchar("notifEmail", { length: 320 }),
    /** JSON: { sequence_reply: bool, social_response: bool, workflow_alert: bool, system: bool } */
    notifPrefs: json("notifPrefs"),
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
    customFields: json("customFields"), // admin-defined custom field values
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
    customFields: json("customFields"),
    // Email verification (Module 13 — VER-001..VER-005)
    emailVerificationStatus: varchar("emailVerificationStatus", { length: 20 }), // safe|invalid|risky|catch_all|unknown
    emailVerifiedAt: timestamp("emailVerifiedAt"),
    emailVerificationData: json("emailVerificationData"), // full Reoon response
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
    customFields: json("customFields"),
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
    customFields: json("customFields"),
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
    enrollmentTrigger: json("enrollmentTrigger"), // [{type: 'status_change'|'tag_applied'|'score_threshold', value: string}]
    dailyCap: int("dailyCap"), // max emails per day for this sequence (null = unlimited)
    ownerUserId: int("ownerUserId"),
    enrolledCount: int("enrolledCount").default(0).notNull(),
    exitConditions: json("exitConditions"), // [{type:'reply'|'bounce'|'unsubscribe'|'goal_met'|'manual', enabled:boolean}]
    settings: json("settings"), // {timezone, sendWindowStart, sendWindowEnd, maxSteps, replyDetection, skipWeekends}
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
    pipelineJobId: int("pipelineJobId"),
    status: mysqlEnum("status", ["pending_review", "approved", "rejected", "sent", "ai_pending_review"]).default("pending_review").notNull(),
    aiGenerated: boolean("aiGenerated").default(true).notNull(),
    aiPrompt: text("aiPrompt"),
    tone: varchar("tone", { length: 64 }), // 'formal' | 'casual' | 'value_prop' | etc.
    createdByUserId: int("createdByUserId"),
    reviewedByUserId: int("reviewedByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    sentAt: timestamp("sentAt"),
    trackingToken: varchar("trackingToken", { length: 64 }), // unique token for open/click tracking
    openCount: int("openCount").default(0).notNull(),
    clickCount: int("clickCount").default(0).notNull(),
    lastOpenedAt: timestamp("lastOpenedAt"),
    lastClickedAt: timestamp("lastClickedAt"),
    bouncedAt: timestamp("bouncedAt"),
    bounceType: mysqlEnum("bounceType", ["hard", "soft", "spam"]),
    bounceMessage: varchar("bounceMessage", { length: 512 }),
  },
  (t) => ({
    byWs: index("ix_ed_ws").on(t.workspaceId, t.status),
    byToken: index("ix_ed_token").on(t.trackingToken),
  }),
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
      "deal_stuck",
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
    /** Recurrence config: { type: 'daily'|'weekly'|'custom', interval?: number, daysOfWeek?: number[], endDate?: string } */
    recurrence: json("recurrence"),
    /** ID of the parent post this was spawned from (for recurrence chains) */
    parentPostId: int("parentPostId"),
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
    // Outreach campaign fields
    audienceType: mysqlEnum("audienceType", ["contacts", "segment"]).default("contacts"),
    audienceIds: json("audienceIds"), // int[] when audienceType=contacts
    audienceSegmentId: int("audienceSegmentId"), // fk to audienceSegments when audienceType=segment
    sequenceId: int("sequenceId"), // fk to sequences
    senderType: mysqlEnum("senderType", ["account", "pool"]).default("account"),
    sendingAccountId: int("sendingAccountId"), // fk to sending_accounts
    senderPoolId: int("senderPoolId"), // fk to sender_pools
    rotationStrategy: mysqlEnum("rotationStrategy", ["round_robin", "weighted", "random"]).default("round_robin"),
    throttlePerHour: int("throttlePerHour").default(50),
    throttlePerDay: int("throttlePerDay").default(500),
    abVariants: json("abVariants"), // [{label, subjectLine, weight}]
    totalSent: int("totalSent").default(0).notNull(),
    totalDelivered: int("totalDelivered").default(0).notNull(),
    totalOpened: int("totalOpened").default(0).notNull(),
    totalClicked: int("totalClicked").default(0).notNull(),
    totalReplied: int("totalReplied").default(0).notNull(),
    totalBounced: int("totalBounced").default(0).notNull(),
    totalUnsubscribed: int("totalUnsubscribed").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_camp_ws").on(t.workspaceId) }),
);

export const campaignStepStats = mysqlTable(
  "campaign_step_stats",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId").notNull(),
    stepIndex: int("stepIndex").notNull(), // 0-based index into sequence.steps
    stepLabel: varchar("stepLabel", { length: 200 }),
    sent: int("sent").default(0).notNull(),
    delivered: int("delivered").default(0).notNull(),
    opened: int("opened").default(0).notNull(),
    clicked: int("clicked").default(0).notNull(),
    replied: int("replied").default(0).notNull(),
    bounced: int("bounced").default(0).notNull(),
    unsubscribed: int("unsubscribed").default(0).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byCamp: index("ix_css_camp").on(t.campaignId),
    uniq: index("ix_css_uniq").on(t.workspaceId, t.campaignId, t.stepIndex),
  }),
);
export type CampaignStepStats = typeof campaignStepStats.$inferSelect;

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
    type: mysqlEnum("type", [
      "kpi", "bar", "stacked_bar", "line", "area", "pie", "donut",
      "funnel", "scatter", "heatmap", "gauge", "single_value",
      "table", "leaderboard", "activity_feed", "goal_progress",
      "comparison", "pipeline_stage", "rep_performance", "email_health",
    ]).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    config: json("config").notNull(), // {metric, dimension, chartType, ...}
    filters: json("filters"), // {dateFrom, dateTo, ownerUserId, stage, source}
    position: json("position"), // {x,y,w,h,i}
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
      "email_reply",
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


/* ──────────────────────────────────────────────────────────────────────────
   Workspace Settings (branding, security, notification policy)
   ────────────────────────────────────────────────────────────────────────── */

export const workspaceSettings = mysqlTable("workspace_settings", {
  workspaceId: int("workspaceId").primaryKey(),
  timezone: varchar("timezone", { length: 64 }).default("UTC").notNull(),
  brandPrimary: varchar("brandPrimary", { length: 16 }).default("#14B89A").notNull(),
  brandAccent: varchar("brandAccent", { length: 16 }).default("#0F766E").notNull(),
  emailFromName: varchar("emailFromName", { length: 120 }),
  emailSignature: text("emailSignature"),
  sessionTimeoutMin: int("sessionTimeoutMin").default(480).notNull(),
  ipAllowlist: json("ipAllowlist"),
  enforce2fa: boolean("enforce2fa").default(false).notNull(),
  notifyPolicy: json("notifyPolicy"),
  blockInvalidEmailsFromSequences: boolean("blockInvalidEmailsFromSequences").default(false).notNull(),
  reverifyIntervalDays: int("reverifyIntervalDays"), // null = disabled; 30 | 60 | 90
  reverifyStatuses: json("reverifyStatuses"), // string[] e.g. ["risky","accept_all"]
  nightlyPipelineEnabled: boolean("nightlyPipelineEnabled").default(false).notNull(),
  nightlyScoreThreshold: int("nightlyScoreThreshold").default(60).notNull(),
  /** Slack incoming webhook URL for workflow notify_slack actions */
  slackWebhookUrl: text("slackWebhookUrl"),
  /** Microsoft Teams incoming webhook URL for workflow notify_teams actions */
  teamsWebhookUrl: text("teamsWebhookUrl"),
  /** Sending account ID to use as the system sender for invitation/notification emails */
  systemSenderAccountId: int("systemSenderAccountId"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Monthly usage counters (for Billing tab)
   ────────────────────────────────────────────────────────────────────────── */

export const usageCounters = mysqlTable(
  "usage_counters",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    month: varchar("month", { length: 7 }).notNull(), // YYYY-MM
    llmTokens: int("llmTokens").default(0).notNull(),
    emailsSent: int("emailsSent").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("uq_uc_ws_month").on(t.workspaceId, t.month),
  }),
);
export type UsageCounter = typeof usageCounters.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Visual Canvas Sequence Builder (Sprint 2 — Tier 1)
   ────────────────────────────────────────────────────────────────────────── */

export const sequenceNodes = mysqlTable(
  "sequence_nodes",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // React Flow node id (uuid)
    sequenceId: int("sequenceId").notNull(),
    workspaceId: int("workspaceId").notNull(),
    type: mysqlEnum("type", ["start", "email", "wait", "condition", "action", "goal"]).notNull(),
    positionX: int("positionX").default(0).notNull(),
    positionY: int("positionY").default(0).notNull(),
    data: json("data").notNull(), // node-type-specific config payload
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    bySeq: index("ix_sn_seq").on(t.sequenceId),
    byWs: index("ix_sn_ws").on(t.workspaceId),
  }),
);
export type SequenceNode = typeof sequenceNodes.$inferSelect;

export const sequenceEdges = mysqlTable(
  "sequence_edges",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // React Flow edge id
    sequenceId: int("sequenceId").notNull(),
    workspaceId: int("workspaceId").notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    target: varchar("target", { length: 64 }).notNull(),
    sourceHandle: varchar("sourceHandle", { length: 32 }), // "true" | "false" | null
    label: varchar("label", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    bySeq: index("ix_se_seq").on(t.sequenceId),
  }),
);
export type SequenceEdge = typeof sequenceEdges.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Workspace Integrations (Settings → Integrations tab)
   ────────────────────────────────────────────────────────────────────────── */

export const workspaceIntegrations = mysqlTable(
  "workspace_integrations",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    provider: varchar("provider", { length: 64 }).notNull(), // "scim" | "stripe" | "webhook" | etc.
    status: mysqlEnum("status", ["connected", "disconnected", "error"]).default("disconnected").notNull(),
    config: json("config"), // provider-specific key/value (tokens stored masked)
    lastTestedAt: timestamp("lastTestedAt"),
    lastTestResult: text("lastTestResult"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("uq_wi_ws_prov").on(t.workspaceId, t.provider),
    byWs: index("ix_wi_ws").on(t.workspaceId),
  }),
);
export type WorkspaceIntegration = typeof workspaceIntegrations.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Dashboard Layouts (per-user widget configuration)
   ────────────────────────────────────────────────────────────────────────── */

export const dashboardLayouts = mysqlTable(
  "dashboard_layouts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    dashboardId: int("dashboardId").notNull(),
    layout: json("layout").notNull(), // [{widgetId, col, row, w, h, title?}]
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("uq_dl_ws_user_dash").on(t.workspaceId, t.userId, t.dashboardId),
    byWs: index("ix_dl_ws").on(t.workspaceId),
  }),
);
export type DashboardLayout = typeof dashboardLayouts.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sprint 3 — AI Research-to-Draft Pipeline
   ────────────────────────────────────────────────────────────────────────── */

/** One pipeline run per email draft — tracks all 5 stages */
export const researchPipelines = mysqlTable(
  "research_pipelines",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    emailDraftId: int("emailDraftId"), // null until draft is created
    createdByUserId: int("createdByUserId").notNull(),
    toContactId: int("toContactId"),
    toLeadId: int("toLeadId"),
    toAccountId: int("toAccountId"),
    // Stage outputs stored as JSON blobs
    stage1_prospect: json("stage1_prospect"),   // company + person research
    stage2_signals: json("stage2_signals"),     // recent news / triggers
    stage3_angles: json("stage3_angles"),       // value-prop angles
    stage4_draft: json("stage4_draft"),         // subject + body candidates
    stage5_final: json("stage5_final"),         // chosen subject + body + personalization tokens
    // Overall status
    status: mysqlEnum("status", ["running", "complete", "failed"]).default("running").notNull(),
    currentStage: int("currentStage").default(1).notNull(), // 1-5
    errorMessage: text("errorMessage"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_rp_ws").on(t.workspaceId),
    byDraft: index("ix_rp_draft").on(t.emailDraftId),
  }),
);
export type ResearchPipeline = typeof researchPipelines.$inferSelect;

/** Prompt version history for A/B and audit */
export const promptVersions = mysqlTable(
  "prompt_versions",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    entityType: varchar("entityType", { length: 64 }).notNull(), // "email_draft" | "sequence_node"
    entityId: int("entityId").notNull(),
    version: int("version").default(1).notNull(),
    subject: text("subject"),
    body: text("body"),
    promptUsed: text("promptUsed"),
    toneUsed: varchar("toneUsed", { length: 32 }),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byEntity: index("ix_pv_entity").on(t.entityType, t.entityId),
    byWs: index("ix_pv_ws").on(t.workspaceId),
  }),
);
export type PromptVersion = typeof promptVersions.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sprint 4 — Quota Management
   ────────────────────────────────────────────────────────────────────────── */

export const quotaTargets = mysqlTable(
  "quota_targets",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    period: varchar("period", { length: 7 }).notNull(), // YYYY-MM or YYYY-QN
    periodType: mysqlEnum("periodType", ["monthly", "quarterly", "annual"]).default("monthly").notNull(),
    revenueTarget: decimal("revenueTarget", { precision: 14, scale: 2 }).default("0").notNull(),
    dealsTarget: int("dealsTarget").default(0).notNull(),
    activitiesTarget: int("activitiesTarget").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("uq_qt_ws_user_period").on(t.workspaceId, t.userId, t.period),
    byWs: index("ix_qt_ws").on(t.workspaceId),
  }),
);
export type QuotaTarget = typeof quotaTargets.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sprint 4 — Subject-Line A/B variants + spam analysis
   ────────────────────────────────────────────────────────────────────────── */

export const subjectVariants = mysqlTable(
  "subject_variants",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    emailDraftId: int("emailDraftId").notNull(),
    subject: text("subject").notNull(),
    spamScore: decimal("spamScore", { precision: 5, scale: 2 }), // 0-100
    spamFlags: json("spamFlags"), // [{rule, severity, description}]
    aiRationale: text("aiRationale"),
    isSelected: boolean("isSelected").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byDraft: index("ix_sv_draft").on(t.emailDraftId),
    byWs: index("ix_sv_ws").on(t.workspaceId),
  }),
);
export type SubjectVariant = typeof subjectVariants.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sequence A/B Variants
   ────────────────────────────────────────────────────────────────────────── */

export const sequenceAbVariants = mysqlTable(
  "sequence_ab_variants",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    sequenceId: int("sequenceId").notNull(),
    stepIndex: int("stepIndex").notNull(), // 0-based index into sequences.steps JSON
    variantLabel: varchar("variantLabel", { length: 32 }).notNull(), // "A", "B", "C"…
    subject: varchar("subject", { length: 240 }).notNull(),
    body: text("body").notNull(),
    splitPct: int("splitPct").default(50).notNull(), // 0-100 percentage of enrollments to receive this variant
    sentCount: int("sentCount").default(0).notNull(),
    openCount: int("openCount").default(0).notNull(),
    replyCount: int("replyCount").default(0).notNull(),
    isWinner: boolean("isWinner").default(false).notNull(),
    promotedAt: timestamp("promotedAt"),
    minSendsForPromotion: int("minSendsForPromotion").default(10).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    bySeq: index("ix_sav_seq").on(t.sequenceId, t.stepIndex),
    byWs: index("ix_sav_ws").on(t.workspaceId),
  }),
);
export type SequenceAbVariant = typeof sequenceAbVariants.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sprint 5 — Custom Fields framework
   ────────────────────────────────────────────────────────────────────────── */

export const customFieldDefs = mysqlTable(
  "custom_field_defs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    entityType: varchar("entityType", { length: 32 }).notNull(), // "lead" | "contact" | "account" | "opportunity"
    fieldKey: varchar("fieldKey", { length: 64 }).notNull(), // snake_case key used in customFields JSON
    label: varchar("label", { length: 120 }).notNull(),
    fieldType: mysqlEnum("fieldType", ["text", "number", "date", "boolean", "select", "multiselect", "url"]).notNull(),
    options: json("options"), // [{value, label}] for select/multiselect
    required: boolean("required").default(false).notNull(),
    showInList: boolean("showInList").default(false).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uq: uniqueIndex("uq_cfd_ws_entity_key").on(t.workspaceId, t.entityType, t.fieldKey),
    byWs: index("ix_cfd_ws").on(t.workspaceId),
  }),
);
export type CustomFieldDef = typeof customFieldDefs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sprint 6 — Opportunity Intelligence
   ────────────────────────────────────────────────────────────────────────── */

/** Stage movement history for opportunities */
export const opportunityStageHistory = mysqlTable(
  "opportunity_stage_history",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    opportunityId: int("opportunityId").notNull(),
    fromStage: varchar("fromStage", { length: 64 }),
    toStage: varchar("toStage", { length: 64 }).notNull(),
    changedByUserId: int("changedByUserId"),
    daysInPrevStage: int("daysInPrevStage"),
    note: text("note"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byOpp: index("ix_osh_opp").on(t.opportunityId),
    byWs: index("ix_osh_ws").on(t.workspaceId),
  }),
);
export type OpportunityStageHistory = typeof opportunityStageHistory.$inferSelect;

/** AI-generated intelligence snapshots per opportunity */
export const opportunityIntelligence = mysqlTable(
  "opportunity_intelligence",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    opportunityId: int("opportunityId").notNull(),
    winProbability: decimal("winProbability", { precision: 5, scale: 2 }), // 0-100
    winProbabilityRationale: text("winProbabilityRationale"),
    nextBestActions: json("nextBestActions"), // [{action, priority, rationale}]
    conversationSignals: json("conversationSignals"), // [{signal, sentiment, extractedAt}]
    actionItems: json("actionItems"), // [{item, owner, dueDate}]
    emailEffectivenessScore: decimal("emailEffectivenessScore", { precision: 5, scale: 2 }),
    altSubjectLines: json("altSubjectLines"), // [{subject, rationale}]
    winStory: text("winStory"),
    outreachSequenceSuggestion: json("outreachSequenceSuggestion"),
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byOpp: index("ix_oi_opp").on(t.opportunityId),
    byWs: index("ix_oi_ws").on(t.workspaceId),
  }),
);
export type OpportunityIntelligence = typeof opportunityIntelligence.$inferSelect;

/** Stage-change approval requests */
export const stageApprovals = mysqlTable(
  "stage_approvals",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    opportunityId: int("opportunityId").notNull(),
    requestedByUserId: int("requestedByUserId").notNull(),
    approverUserId: int("approverUserId"),
    fromStage: varchar("fromStage", { length: 64 }).notNull(),
    toStage: varchar("toStage", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
    note: text("note"),
    reviewNote: text("reviewNote"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byOpp: index("ix_sa_opp").on(t.opportunityId),
    byWs: index("ix_sa_ws").on(t.workspaceId),
  }),
);
export type StageApproval = typeof stageApprovals.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Email Dynamic Path — Templates, Snippets, Brand Voice, Prompt Templates
   ────────────────────────────────────────────────────────────────────────── */

/** Reusable email templates with drag-and-drop block design data */
export const emailTemplates = mysqlTable(
  "email_templates",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    category: varchar("category", { length: 64 }).default("general").notNull(),
    subject: text("subject"),
    designData: json("designData").notNull(), // [{id, type, props, sortOrder}]
    htmlOutput: text("htmlOutput"),           // compiled inline-CSS HTML
    plainOutput: text("plainOutput"),         // plain-text fallback
    status: mysqlEnum("status", ["draft", "active", "archived"]).default("draft").notNull(),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_et_ws").on(t.workspaceId, t.status),
  }),
);
export type EmailTemplate = typeof emailTemplates.$inferSelect;

/** Reusable content snippets (intros, CTAs, objection handles, P.S. lines) */
export const emailSnippets = mysqlTable(
  "email_snippets",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    category: mysqlEnum("category", ["opener", "value_prop", "social_proof", "objection_handler", "cta", "closing", "ps"]).notNull(),
    bodyHtml: text("bodyHtml").notNull(),
    bodyPlain: text("bodyPlain").notNull(),
    mergeTagsUsed: json("mergeTagsUsed"), // ["{{firstName}}", "{{company}}"]
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_es_ws").on(t.workspaceId, t.category),
  }),
);
export type EmailSnippet = typeof emailSnippets.$inferSelect;

/** Brand voice profile — one per workspace */
export const brandVoiceProfiles = mysqlTable("brand_voice_profiles", {
  workspaceId: int("workspaceId").primaryKey(),
  tone: mysqlEnum("tone", ["professional", "conversational", "direct", "empathetic", "authoritative"]).default("professional").notNull(),
  vocabulary: json("vocabulary"),   // string[] — power words to use
  avoidWords: json("avoidWords"),   // string[] — words to avoid
  signatureHtml: text("signatureHtml"),
  fromName: varchar("fromName", { length: 120 }),
  fromEmail: varchar("fromEmail", { length: 200 }),
  primaryColor: varchar("primaryColor", { length: 16 }).default("#14B89A").notNull(),
  secondaryColor: varchar("secondaryColor", { length: 16 }).default("#0F766E").notNull(),
  applyToAI: boolean("applyToAI").default(true).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type BrandVoiceProfile = typeof brandVoiceProfiles.$inferSelect;

/** Prompt template versions for AI email generation (A/B testing + audit) */
export const emailPromptTemplates = mysqlTable(
  "email_prompt_templates",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    goal: mysqlEnum("goal", ["intro", "follow_up", "meeting_request", "value_prop", "breakup", "check_in"]).notNull(),
    promptText: text("promptText").notNull(),
    isActive: boolean("isActive").default(false).notNull(),
    abGroup: mysqlEnum("abGroup", ["A", "B"]).default("A").notNull(),
    draftsGenerated: int("draftsGenerated").default(0).notNull(),
    draftsApproved: int("draftsApproved").default(0).notNull(),
    avgSubjectScore: decimal("avgSubjectScore", { precision: 5, scale: 2 }),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_ept_ws").on(t.workspaceId, t.goal, t.isActive),
  }),
);
export type EmailPromptTemplate = typeof emailPromptTemplates.$inferSelect;

/** Reusable email sections saved from the Visual Email Builder canvas */
export const emailSavedSections = mysqlTable(
  "email_saved_sections",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: varchar("description", { length: 500 }),
    category: mysqlEnum("category", [
      "layout",
      "header",
      "footer",
      "cta",
      "testimonial",
      "pricing",
      "custom",
    ])
      .default("custom")
      .notNull(),
    /** JSON array of Block objects (same shape as email_templates.designData) */
    blocks: json("blocks").notNull(),
    /** Pre-rendered HTML preview (server-side render of blocks at save time) */
    previewHtml: text("previewHtml"),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_ess_ws").on(t.workspaceId, t.category),
    byCreator: index("ix_ess_creator").on(t.createdByUserId),
  }),
);
export type EmailSavedSection = typeof emailSavedSections.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Module 13 — CSV Import (IMP-001..IMP-006)
   ────────────────────────────────────────────────────────────────────────── */

export const contactImports = mysqlTable(
  "contact_imports",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    fileKey: text("fileKey"), // S3 key of original file
    status: mysqlEnum("status", [
      "pending",
      "validating",
      "ready",
      "importing",
      "completed",
      "failed",
    ])
      .default("pending")
      .notNull(),
    totalRows: int("totalRows").default(0).notNull(),
    importedRows: int("importedRows").default(0).notNull(),
    skippedRows: int("skippedRows").default(0).notNull(),
    errorRows: int("errorRows").default(0).notNull(),
    /** Column→field mapping JSON: { "CSV Column": "systemField" | null } */
    fieldMapping: json("fieldMapping"),
    /** Post-import actions JSON: { tag, ownerUserId, sequenceId, segmentId } */
    postImportActions: json("postImportActions"),
    ownerId: int("ownerId").notNull(), // user who triggered the import
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_ci_ws").on(t.workspaceId),
    byOwner: index("ix_ci_owner").on(t.ownerId),
  }),
);
export type ContactImport = typeof contactImports.$inferSelect;

export const contactImportRows = mysqlTable(
  "contact_import_rows",
  {
    id: int("id").autoincrement().primaryKey(),
    importId: int("importId").notNull(),
    rowIndex: int("rowIndex").notNull(), // 1-based row number in original CSV
    rowData: json("rowData").notNull(), // raw CSV row as { columnName: value }
    mappedData: json("mappedData"), // after field mapping applied
    status: mysqlEnum("status", [
      "pending",
      "valid",
      "duplicate",
      "error",
      "imported",
      "skipped",
    ])
      .default("pending")
      .notNull(),
    errorReason: text("errorReason"),
    contactId: int("contactId"), // set after successful import
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byImport: index("ix_cir_import").on(t.importId),
    byStatus: index("ix_cir_status").on(t.importId, t.status),
  }),
);
export type ContactImportRow = typeof contactImportRows.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Module 13 — Email Verification (VER-001..VER-005)
   ────────────────────────────────────────────────────────────────────────── */

/** Bulk verification jobs (maps to a Reoon bulk task) */
export const emailVerificationJobs = mysqlTable(
  "email_verification_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    reoonTaskId: varchar("reoonTaskId", { length: 64 }), // Reoon task_id
    status: mysqlEnum("status", [
      "pending",
      "running",
      "completed",
      "failed",
    ])
      .default("pending")
      .notNull(),
    totalEmails: int("totalEmails").default(0).notNull(),
    checkedEmails: int("checkedEmails").default(0).notNull(),
    progressPct: decimal("progressPct", { precision: 5, scale: 2 }).default("0"),
    triggeredByUserId: int("triggeredByUserId"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_evj_ws").on(t.workspaceId),
  }),
);
export type EmailVerificationJob = typeof emailVerificationJobs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Module 13 — LinkedIn OAuth Connection (LNK-004)
   ────────────────────────────────────────────────────────────────────────── */

export const linkedinConnections = mysqlTable(
  "linkedin_connections",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().unique(), // one connection per user
    workspaceId: int("workspaceId").notNull(),
    accessToken: text("accessToken").notNull(), // encrypted at rest (AES-256)
    tokenExpiry: timestamp("tokenExpiry"),
    linkedinId: varchar("linkedinId", { length: 64 }),
    displayName: varchar("displayName", { length: 200 }),
    profileUrl: text("profileUrl"),
    syncedAt: timestamp("syncedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_lc_ws").on(t.workspaceId),
  }),
);
export type LinkedinConnection = typeof linkedinConnections.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Email Verification Snapshots (daily health trend)
   ────────────────────────────────────────────────────────────────────────── */
export const emailVerificationSnapshots = mysqlTable(
  "email_verification_snapshots",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    snapshotDate: date("snapshotDate").notNull(), // YYYY-MM-DD
    valid: int("valid").default(0).notNull(),
    acceptAll: int("acceptAll").default(0).notNull(),
    risky: int("risky").default(0).notNull(),
    invalid: int("invalid").default(0).notNull(),
    unknown: int("unknown").default(0).notNull(),
    total: int("total").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWsDate: index("ix_evs_ws_date").on(t.workspaceId, t.snapshotDate),
  }),
);
export type EmailVerificationSnapshot = typeof emailVerificationSnapshots.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Audience Segments (rule-based contact filters)
   ────────────────────────────────────────────────────────────────────────── */
export const audienceSegments = mysqlTable(
  "audience_segments",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    matchType: varchar("matchType", { length: 10 }).default("all").notNull(),
    rules: json("rules").notNull(),
    contactCount: int("contactCount").default(0),
    lastEvaluatedAt: timestamp("lastEvaluatedAt"),
    createdByUserId: int("createdByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_as_ws").on(t.workspaceId),
  }),
);
export type AudienceSegment = typeof audienceSegments.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   AI Research-to-Email Pipeline Jobs (MKT-014..MKT-017)
   ────────────────────────────────────────────────────────────────────────── */
export const aiPipelineJobs = mysqlTable(
  "ai_pipeline_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    contactId: int("contactId"),
    leadId: int("leadId"),
    status: mysqlEnum("status", ["queued", "running", "done", "failed"]).default("queued").notNull(),
    orgResearch: text("orgResearch"),
    contactResearch: text("contactResearch"),
    fitAnalysis: json("fitAnalysis"), // {fit_score, pain_points, recommended_products, objection_risks}
    draftsGenerated: int("draftsGenerated").default(0).notNull(),
    errorMessage: text("errorMessage"),
    triggeredByUserId: int("triggeredByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => ({
    byWs: index("ix_apj_ws").on(t.workspaceId, t.status),
    byContact: index("ix_apj_contact").on(t.contactId),
  }),
);
export type AiPipelineJob = typeof aiPipelineJobs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Pipeline Health Alerts (CRMA-012)
   ────────────────────────────────────────────────────────────────────────── */
export const pipelineAlerts = mysqlTable(
  "pipeline_alerts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    opportunityId: int("opportunityId").notNull(),
    alertType: mysqlEnum("alertType", [
      "no_activity",
      "closing_soon_regression",
      "amount_change",
      "no_champion",
    ]).notNull(),
    details: json("details"), // {daysSinceActivity, closeDate, previousAmount, currentAmount, etc.}
    dismissedAt: timestamp("dismissedAt"),
    dismissedByUserId: int("dismissedByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_pa_ws").on(t.workspaceId),
    byOpp: index("ix_pa_opp").on(t.opportunityId),
  }),
);
export type PipelineAlert = typeof pipelineAlerts.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   AI Account Briefs (CRMA-010)
   ────────────────────────────────────────────────────────────────────────── */
export const accountBriefs = mysqlTable(
  "account_briefs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("accountId").notNull(),
    content: text("content").notNull(), // 300-word markdown narrative
    pdfUrl: text("pdfUrl"), // S3 URL after export
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
    generatedByUserId: int("generatedByUserId"),
  },
  (t) => ({
    byWs: index("ix_ab_ws").on(t.workspaceId),
    byAccount: index("ix_ab_account").on(t.accountId),
  }),
);
export type AccountBrief = typeof accountBriefs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sequence Execution — add enrollmentTrigger + dailyCap to sequences
   (new columns added via ALTER TABLE in migration)
   ────────────────────────────────────────────────────────────────────────── */
// Note: sequences table gets enrollmentTrigger and dailyCap via migration
// enrollmentTrigger: json — [{type: 'status_change'|'tag_applied'|'score_threshold', value: string}]
// dailyCap: int — max emails per day for this sequence (null = unlimited)

/* ──────────────────────────────────────────────────────────────────────────
   SMTP Delivery Config (Feature 44)
   ────────────────────────────────────────────────────────────────────────── */
export const smtpConfigs = mysqlTable(
  "smtp_configs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull().unique(),
    host: varchar("host", { length: 255 }).notNull(),
    port: int("port").default(587).notNull(),
    secure: boolean("secure").default(false).notNull(), // true = TLS/465, false = STARTTLS
    username: varchar("username", { length: 255 }).notNull(),
    encryptedPassword: text("encryptedPassword").notNull(), // AES-256 encrypted
    fromName: varchar("fromName", { length: 120 }),
    fromEmail: varchar("fromEmail", { length: 255 }).notNull(),
    replyTo: varchar("replyTo", { length: 255 }),
    enabled: boolean("enabled").default(true).notNull(),
    lastTestedAt: timestamp("lastTestedAt"),
    lastTestStatus: varchar("lastTestStatus", { length: 16 }), // 'ok' | 'error'
    lastTestError: text("lastTestError"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_smtp_ws").on(t.workspaceId),
  }),
);
export type SmtpConfig = typeof smtpConfigs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Segment → Sequence Auto-Enroll Rules (Feature 46)
   ────────────────────────────────────────────────────────────────────────── */
export const segmentSequenceRules = mysqlTable(
  "segment_sequence_rules",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    segmentId: int("segmentId").notNull(),
    sequenceId: int("sequenceId").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    lastRunAt: timestamp("lastRunAt"),
    enrolledCount: int("enrolledCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_ssr_ws").on(t.workspaceId),
    bySegment: index("ix_ssr_seg").on(t.segmentId),
    bySequence: index("ix_ssr_seq").on(t.sequenceId),
    uniq: index("ix_ssr_uniq").on(t.workspaceId, t.segmentId, t.sequenceId),
  }),
);
export type SegmentSequenceRule = typeof segmentSequenceRules.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Email Tracking Events (Feature 47)
   ────────────────────────────────────────────────────────────────────────── */
export const emailTrackingEvents = mysqlTable(
  "email_tracking_events",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    draftId: int("draftId").notNull(),
    type: mysqlEnum("type", ["open", "click"]).notNull(),
    url: varchar("url", { length: 2048 }), // for click events
    userAgent: varchar("userAgent", { length: 512 }),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byDraft: index("ix_ete_draft").on(t.draftId),
    byWs: index("ix_ete_ws").on(t.workspaceId),
  }),
);
export type EmailTrackingEvent = typeof emailTrackingEvents.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Email Suppressions — unsubscribes, bounces, spam complaints (Feature 51)
   ────────────────────────────────────────────────────────────────────────── */
export const emailSuppressions = mysqlTable(
  "email_suppressions",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    reason: mysqlEnum("reason", ["unsubscribe", "bounce", "spam_complaint", "manual"]).notNull(),
    draftId: int("draftId"), // the draft that triggered the suppression (if applicable)
    contactId: int("contactId"), // linked contact (if found)
    notes: text("notes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_sup_ws").on(t.workspaceId),
    byEmail: index("ix_sup_email").on(t.email),
    uniq: index("ix_sup_uniq").on(t.workspaceId, t.email, t.reason),
  }),
);
export type EmailSuppression = typeof emailSuppressions.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sending Accounts — multi-provider email sending infrastructure (Feature 64)
   Supports: gmail_oauth, outlook_oauth, amazon_ses, generic_smtp
   ────────────────────────────────────────────────────────────────────────── */
export const sendingAccounts = mysqlTable(
  "sending_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    provider: mysqlEnum("provider", [
      "gmail_oauth",
      "outlook_oauth",
      "amazon_ses",
      "generic_smtp",
    ]).notNull(),
    fromEmail: varchar("fromEmail", { length: 320 }).notNull(),
    fromName: varchar("fromName", { length: 120 }),
    replyTo: varchar("replyTo", { length: 320 }),
    /* OAuth fields */
    oauthAccessToken: text("oauthAccessToken"),
    oauthRefreshToken: text("oauthRefreshToken"),
    oauthTokenExpiry: timestamp("oauthTokenExpiry"),
    oauthScope: text("oauthScope"),
    /* SMTP fields */
    smtpHost: varchar("smtpHost", { length: 255 }),
    smtpPort: int("smtpPort").default(587),
    smtpSecure: boolean("smtpSecure").default(false),
    smtpUsername: varchar("smtpUsername", { length: 255 }),
    smtpPassword: text("smtpPassword"),
    sesRegion: varchar("sesRegion", { length: 32 }),
    /* IMAP fields (for reading inbox: Mailpool own SMTP/IMAP, generic IMAP) */
    imapHost: varchar("imapHost", { length: 255 }),
    imapPort: int("imapPort").default(993),
    imapSecure: boolean("imapSecure").default(true),
    imapUsername: varchar("imapUsername", { length: 255 }),
    imapPassword: text("imapPassword"), // AES-256-GCM encrypted
    /* Limits */
    dailySendLimit: int("dailySendLimit").default(500).notNull(),
    warmupStatus: mysqlEnum("warmupStatus", [
      "not_started",
      "in_progress",
      "complete",
    ]).default("not_started").notNull(),
    /* Health */
    bounceRate: varchar("bounceRate", { length: 10 }).default("0").notNull(),
    spamRate: varchar("spamRate", { length: 10 }).default("0").notNull(),
    reputationTier: mysqlEnum("reputationTier", [
      "excellent",
      "good",
      "fair",
      "poor",
    ]).default("excellent").notNull(),
    connectionStatus: mysqlEnum("connectionStatus", [
      "connected",
      "error",
      "untested",
    ]).default("untested").notNull(),
    lastTestedAt: timestamp("lastTestedAt"),
    lastTestError: text("lastTestError"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_sa_ws").on(t.workspaceId),
    byWsEmail: index("ix_sa_ws_email").on(t.workspaceId, t.fromEmail),
  }),
);
export type SendingAccount = typeof sendingAccounts.$inferSelect;

export const sendingAccountDailyStats = mysqlTable(
  "sending_account_daily_stats",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("accountId").notNull(),
    date: varchar("date", { length: 10 }).notNull(),
    sentCount: int("sentCount").default(0).notNull(),
    bounceCount: int("bounceCount").default(0).notNull(),
    spamCount: int("spamCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byAccount: index("ix_sads_acc").on(t.accountId),
    byDate: index("ix_sads_date").on(t.accountId, t.date),
  }),
);
export type SendingAccountDailyStat = typeof sendingAccountDailyStats.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Sender Pools — named groups of sending accounts with rotation strategy
   ────────────────────────────────────────────────────────────────────────── */
export const senderPools = mysqlTable(
  "sender_pools",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    rotationStrategy: mysqlEnum("rotationStrategy", [
      "round_robin",
      "weighted",
      "random",
    ]).default("round_robin").notNull(),
    lastUsedIndex: int("lastUsedIndex").default(0).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_sp_ws").on(t.workspaceId),
  }),
);
export type SenderPool = typeof senderPools.$inferSelect;

export const senderPoolMembers = mysqlTable(
  "sender_pool_members",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    poolId: int("poolId").notNull(),
    accountId: int("accountId").notNull(),
    weight: int("weight").default(10).notNull(),
    position: int("position").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byPool: index("ix_spm_pool").on(t.poolId),
    byAccount: index("ix_spm_acc").on(t.accountId),
    uniq: index("ix_spm_uniq").on(t.poolId, t.accountId),
  }),
);
export type SenderPoolMember = typeof senderPoolMembers.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Rep Mailbox & Calendar (Feature 73)
   ────────────────────────────────────────────────────────────────────────── */

export const emailReplies = mysqlTable(
  "email_replies",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    draftId: int("draftId"),
    sendingAccountId: int("sendingAccountId").notNull(),
    userId: int("userId"),
    fromEmail: varchar("fromEmail", { length: 320 }).notNull(),
    fromName: varchar("fromName", { length: 200 }),
    subject: varchar("subject", { length: 500 }),
    bodyText: text("bodyText"),
    bodyHtml: text("bodyHtml"),
    messageId: varchar("messageId", { length: 500 }),
    inReplyTo: varchar("inReplyTo", { length: 500 }),
    contactId: int("contactId"),
    leadId: int("leadId"),
    accountId: int("accountId"),
    imapUid: bigint("imapUid", { mode: "number" }),
    gmailMessageId: varchar("gmailMessageId", { length: 200 }),
    receivedAt: timestamp("receivedAt").notNull(),
    readAt: timestamp("readAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_er_ws").on(t.workspaceId),
    byAccount: index("ix_er_account").on(t.sendingAccountId),
    byDraft: index("ix_er_draft").on(t.draftId),
    byMsgId: index("ix_er_msgid").on(t.messageId),
  }),
);
export type EmailReply = typeof emailReplies.$inferSelect;

export const calendarAccounts = mysqlTable(
  "calendar_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    provider: mysqlEnum("provider", [
      "google",
      "outlook_oauth",
      "outlook_caldav",
      "apple_caldav",
      "generic_caldav",
    ]).notNull(),
    label: varchar("label", { length: 120 }),
    email: varchar("email", { length: 320 }),
    oauthAccessToken: text("oauthAccessToken"),
    oauthRefreshToken: text("oauthRefreshToken"),
    oauthTokenExpiry: timestamp("oauthTokenExpiry"),
    oauthScope: text("oauthScope"),
    caldavUrl: varchar("caldavUrl", { length: 500 }),
    caldavUsername: varchar("caldavUsername", { length: 320 }),
    caldavPassword: text("caldavPassword"),
    calendarId: varchar("calendarId", { length: 500 }),
    syncEnabled: boolean("syncEnabled").default(true).notNull(),
    lastSyncAt: timestamp("lastSyncAt"),
    lastSyncError: text("lastSyncError"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byUser: index("ix_ca_user").on(t.workspaceId, t.userId),
  }),
);
export type CalendarAccount = typeof calendarAccounts.$inferSelect;

export const calendarEvents = mysqlTable(
  "calendar_events",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    calendarAccountId: int("calendarAccountId").notNull(),
    externalId: varchar("externalId", { length: 500 }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    location: varchar("location", { length: 500 }),
    meetingUrl: varchar("meetingUrl", { length: 1000 }),
    startAt: timestamp("startAt").notNull(),
    endAt: timestamp("endAt").notNull(),
    allDay: boolean("allDay").default(false).notNull(),
    attendees: json("attendees"),
    relatedType: varchar("relatedType", { length: 30 }),
    relatedId: int("relatedId"),
    activityId: int("activityId"),
    aiSummary: text("aiSummary"),
    aiSummarizedAt: timestamp("aiSummarizedAt"),
    syncedAt: timestamp("syncedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byUser: index("ix_ce_user").on(t.workspaceId, t.userId),
    byAccount: index("ix_ce_account").on(t.calendarAccountId),
    byExtId: index("ix_ce_extid").on(t.calendarAccountId, t.externalId),
    byRange: index("ix_ce_range").on(t.workspaceId, t.userId, t.startAt, t.endAt),
  }),
);
export type CalendarEvent = typeof calendarEvents.$inferSelect;
