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
  primaryKey,
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
  passwordHash: text("passwordHash"),
  /** Per-user override for outbound email signature. Overrides workspaceSettings.emailSignature when set. */
  emailSignature: text("emailSignature"),
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

/** Email-less, role-scoped activation links (migration 0091). A recipient who
 *  opens /join?token=… registers their OWN email + password and is added to
 *  this workspace at `role`. Single-use: `usedAt` is set on the first
 *  successful registration and the link stops working. Expiry mirrors the
 *  workspace invite-expiry setting (null = never). */
export const workspaceInviteLinks = mysqlTable("workspace_invite_links", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  role: mysqlEnum("role", ["super_admin", "admin", "manager", "rep"]).default("rep").notNull(),
  title: varchar("title", { length: 120 }),
  quota: decimal("quota", { precision: 14, scale: 2 }),
  createdByUserId: int("createdByUserId").notNull(),
  expiresAt: timestamp("expiresAt"),
  usedAt: timestamp("usedAt"),
  usedByUserId: int("usedByUserId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
    /** Secure random token for invite-link acceptance */
    inviteToken: varchar("inviteToken", { length: 64 }),
    /** When the invite token expires (null = no expiry) */
    inviteExpiresAt: timestamp("inviteExpiresAt"),
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
    // ── Company/account system (migration 0098) — `accounts` is the
    //    workspace-account layer; global_organizations is the shared layer. ──
    globalOrganizationId: int("global_organization_id"),
    normalizedName: varchar("normalized_name", { length: 200 }),
    normalizedDomain: varchar("normalized_domain", { length: 200 }),
    websiteUrl: text("website_url"),
    linkedinCompanyUrl: text("linkedin_company_url"),
    subIndustry: varchar("sub_industry", { length: 80 }),
    employeeCount: int("employee_count"),
    revenue: decimal("revenue", { precision: 16, scale: 2 }),
    description: text("description"),
    hqCity: varchar("hq_city", { length: 80 }),
    hqState: varchar("hq_state", { length: 80 }),
    hqCountry: varchar("hq_country", { length: 80 }),
    companyPhone: varchar("company_phone", { length: 40 }),
    foundedYear: int("founded_year"),
    logoUrl: text("logo_url"),
    logoSourceType: varchar("logo_source_type", { length: 32 }),
    logoSourceUrl: text("logo_source_url"),
    logoStatus: varchar("logo_status", { length: 24 }).default("unknown").notNull(),
    logoLastVerifiedAt: timestamp("logo_last_verified_at"),
    accountStage: varchar("account_stage", { length: 64 }),
    accountScore: decimal("account_score", { precision: 6, scale: 2 }),
    accountRating: varchar("account_rating", { length: 16 }),
    crmSyncStatus: varchar("crm_sync_status", { length: 24 }).default("not_synced").notNull(),
    crmExternalId: varchar("crm_external_id", { length: 128 }),
    sourceType: varchar("source_type", { length: 32 }),
    dataStatus: varchar("data_status", { length: 16 }).default("partial").notNull(),
    lastEnrichedAt: timestamp("last_enriched_at"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_acc_ws").on(t.workspaceId),
    byParent: index("ix_acc_parent").on(t.parentAccountId),
    byNormDomain: index("ix_acc_norm_domain").on(t.workspaceId, t.normalizedDomain),
    byNormName: index("ix_acc_norm_name").on(t.workspaceId, t.normalizedName),
    byGlobalOrg: index("ix_acc_global_org").on(t.globalOrganizationId),
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
    // Relationship strength (Migration 0050)
    relStrengthScore: int("relStrengthScore"),
    relStrengthLabel: varchar("relStrengthLabel", { length: 16 }),
    relStrengthAt: timestamp("relStrengthAt"),
    // Company system (migration 0098): global-org link (accountId already above).
    globalOrganizationId: int("global_organization_id"),
    companyName: varchar("company_name", { length: 200 }),
    companyDomain: varchar("company_domain", { length: 200 }),
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
    // AI next-action suggestion (Migration 0050)
    aiNextAction: varchar("aiNextAction", { length: 40 }),
    aiNextActionNote: text("aiNextActionNote"),
    aiNextActionAt: timestamp("aiNextActionAt"),
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
    // Widened from ENUM to VARCHAR in migration 0082 so per-workspace
    // pipelines can define custom stage keys. Legacy values still apply
    // for the default pipeline.
    stage: varchar("stage", { length: 60 }).default("discovery").notNull(),
    value: decimal("value", { precision: 14, scale: 2 }).default("0").notNull(),
    winProb: int("winProb").default(20).notNull(),
    closeDate: timestamp("closeDate"),
    daysInStage: int("daysInStage").default(0).notNull(),
    aiNote: text("aiNote"),
    nextStep: text("nextStep"),
    lostReason: varchar("lostReason", { length: 120 }),
    winReason: varchar("winReason", { length: 120 }),
    lastActivityAt: timestamp("lastActivityAt"),
    pipelineId: int("pipelineId"),
    campaignId: int("campaignId"),
    ownerUserId: int("ownerUserId"),
    customFields: json("customFields"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_opp_ws").on(t.workspaceId),
    byStage: index("ix_opp_stage").on(t.workspaceId, t.stage),
    byPipeline: index("ix_opp_pipeline").on(t.workspaceId, t.pipelineId),
    byLastActivity: index("ix_opp_last_activity").on(t.workspaceId, t.lastActivityAt),
  }),
);
export type Opportunity = typeof opportunities.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   CRM polish (migration 0081): notes + multi-pipeline support
   ────────────────────────────────────────────────────────────────────────── */

export const crmNotes = mysqlTable(
  "crm_notes",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    entityType: varchar("entityType", { length: 30 }).notNull(), // account|contact|lead|opportunity
    entityId: int("entityId").notNull(),
    body: text("body").notNull(),
    pinned: boolean("pinned").default(false).notNull(),
    createdByUserId: int("createdByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byEntity: index("ix_crm_notes_entity").on(t.workspaceId, t.entityType, t.entityId),
  }),
);
export type CrmNote = typeof crmNotes.$inferSelect;

export const crmPipelines = mysqlTable(
  "crm_pipelines",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    isDefault: boolean("isDefault").default(false).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_crm_pipelines_ws").on(t.workspaceId),
  }),
);
export type CrmPipeline = typeof crmPipelines.$inferSelect;

export const crmPipelineStages = mysqlTable(
  "crm_pipeline_stages",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    pipelineId: int("pipelineId").notNull(),
    key: varchar("key", { length: 60 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    defaultWinProb: int("defaultWinProb").default(20).notNull(),
    isWon: boolean("isWon").default(false).notNull(),
    isLost: boolean("isLost").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byPipeline: index("ix_crm_stages_pipeline").on(t.workspaceId, t.pipelineId, t.sortOrder),
  }),
);
export type CrmPipelineStage = typeof crmPipelineStages.$inferSelect;

export const crmTerritoryRules = mysqlTable(
  "crm_territory_rules",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    priority: int("priority").default(100).notNull(),
    industry: varchar("industry", { length: 80 }),
    country: varchar("country", { length: 80 }),
    state: varchar("state", { length: 80 }),
    companyContains: varchar("companyContains", { length: 120 }),
    territoryId: int("territoryId"),
    ownerUserId: int("ownerUserId"),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_crm_terr_rules_ws").on(t.workspaceId, t.priority, t.active),
  }),
);
export type CrmTerritoryRule = typeof crmTerritoryRules.$inferSelect;

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
      // ── Migration 0099: expanded task taxonomy (tasks-calls-deals spec §1) ──
      "social_touch",
      "manual_email",
      "meeting_prep",
      "crm_update",
      "generic_action",
    ]).default("todo").notNull(),
    priority: mysqlEnum("priority", ["low", "normal", "high", "urgent"]).default("normal").notNull(),
    status: mysqlEnum("status", [
      "open",
      "done",
      "cancelled",
      // ── Migration 0099: richer lifecycle + AI-draft state ──
      "in_progress",
      "snoozed",
      "draft", // AI-proposed task awaiting approval (autopilot "approval" mode)
    ]).default("open").notNull(),
    dueAt: timestamp("dueAt"),
    completedAt: timestamp("completedAt"),
    ownerUserId: int("ownerUserId"),
    relatedType: varchar("relatedType", { length: 30 }),
    relatedId: int("relatedId"),
    // ── Migration 0099: sequence link, outcome, snooze + AI provenance ──
    sequenceId: int("sequenceId"),
    disposition: varchar("disposition", { length: 48 }), // outcome on completion (completed|no_answer|left_voicemail|rescheduled…)
    snoozedUntil: timestamp("snoozedUntil"),
    // How this task came to exist. Drives the Tasks page filters + autopilot dedupe.
    source: mysqlEnum("source", ["manual", "sequence", "ai", "import", "workflow"]).default("manual").notNull(),
    aiReasoning: text("aiReasoning"), // why the AI proposed this action (autopilot)
    aiConfidence: int("aiConfidence"), // 0-100 model confidence for AI-sourced tasks
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byOwner: index("ix_task_owner").on(t.workspaceId, t.ownerUserId, t.status),
    byRel: index("ix_task_rel").on(t.relatedType, t.relatedId),
    bySource: index("ix_task_source").on(t.workspaceId, t.status, t.source),
  }),
);

/**
 * meetings — first-class CRM meeting object (Migration 0100), distinct from raw
 * calendarEvents. Powers /v2/meetings + the autonomous AI meeting scheduler.
 * A meeting starts life as `proposed` (AI-drafted times + invite), then on
 * approve/auto-send becomes `scheduled` and (when the owner has a connected
 * calendar) links a real calendarEvents row via `calendarEventId`.
 */
export const meetings = mysqlTable(
  "meetings",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    ownerUserId: int("ownerUserId"),
    // polymorphic link to the person/company (matches tasks/activities convention)
    relatedType: varchar("relatedType", { length: 30 }),
    relatedId: int("relatedId"),
    // denormalized attendee info so the list renders without joins
    contactName: varchar("contactName", { length: 200 }),
    contactEmail: varchar("contactEmail", { length: 320 }),
    company: varchar("company", { length: 200 }),
    title: varchar("title", { length: 240 }).notNull(),
    status: mysqlEnum("status", [
      "proposed",   // AI/manual draft with candidate times, not sent
      "invited",    // invite sent, awaiting confirmation
      "scheduled",  // confirmed / on the calendar
      "completed",
      "no_show",
      "cancelled",
      "rescheduled",
    ]).default("proposed").notNull(),
    proposedTimes: json("proposedTimes"), // string[] of ISO datetimes the AI/rep suggested
    scheduledAt: timestamp("scheduledAt"),
    durationMin: int("durationMin").default(30).notNull(),
    meetingUrl: text("meetingUrl"),
    location: varchar("location", { length: 240 }),
    inviteMessage: text("inviteMessage"), // AI-drafted invite/email body
    source: mysqlEnum("source", ["manual", "ai", "are", "inbound"]).default("manual").notNull(),
    aiReasoning: text("aiReasoning"),
    aiConfidence: int("aiConfidence"),
    inviteSent: boolean("inviteSent").default(false).notNull(),
    calendarEventId: int("calendarEventId"), // FK → calendarEvents when pushed to a provider
    calendarAccountId: int("calendarAccountId"),
    disposition: varchar("disposition", { length: 48 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byStatus: index("ix_meeting_status").on(t.workspaceId, t.status),
    byOwner: index("ix_meeting_owner").on(t.workspaceId, t.ownerUserId),
    byRel: index("ix_meeting_rel").on(t.relatedType, t.relatedId),
  }),
);
export type Meeting = typeof meetings.$inferSelect;

/**
 * forms + form_submissions (Migration 0103) — lead-capture forms with
 * autonomous handling: a submission can auto-create a lead, auto-route it to a
 * rep, and auto-enroll it in a sequence, feeding the top of the pipeline.
 */
export const forms = mysqlTable(
  "forms",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    publicId: varchar("publicId", { length: 32 }).notNull().unique(), // nanoid — public form URL
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    // fields: array of { key, label, required } chosen from a standard palette
    fields: json("fields"),
    status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
    // ── Autonomous handling of submissions ──
    autoCreateLead: boolean("autoCreateLead").default(true).notNull(),
    autoRoute: boolean("autoRoute").default(true).notNull(),         // assign owner via leadRouting rules
    autoEnrollSequenceId: int("autoEnrollSequenceId"),               // enroll the new lead into this sequence
    redirectUrl: text("redirectUrl"),
    submitCount: int("submitCount").default(0).notNull(),
    createdByUserId: int("createdByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_form_ws").on(t.workspaceId),
    byPublic: index("ix_form_public").on(t.publicId),
  }),
);
export type Form = typeof forms.$inferSelect;

export const formSubmissions = mysqlTable(
  "form_submissions",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    formId: int("formId").notNull(),
    data: json("data"),
    name: varchar("name", { length: 200 }),
    email: varchar("email", { length: 320 }),
    company: varchar("company", { length: 200 }),
    leadId: int("leadId"),                 // lead auto-created from this submission
    routedToUserId: int("routedToUserId"), // rep it was auto-routed to
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byForm: index("ix_fsub_form").on(t.workspaceId, t.formId),
  }),
);
export type FormSubmission = typeof formSubmissions.$inferSelect;

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
    // ── Multi-user template library + sharing (Migration 0104) ──
    isTemplate: boolean("isTemplate").default(false).notNull(),   // admin-published master template reps fork from
    visibility: mysqlEnum("visibility", ["private", "team"]).default("team").notNull(),
    sourceTemplateId: int("sourceTemplateId"),                    // provenance: forked from this template
    assignedToUserId: int("assignedToUserId"),                    // the rep this sequence/template is assigned to
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
    // Migration 0085: prospects are first-class enrollment targets so
    // the send engine doesn't have to convert them into contacts first.
    prospectId: int("prospectId"),
    status: mysqlEnum("status", ["active", "paused", "finished", "exited"]).default("active").notNull(),
    currentStep: int("currentStep").default(0).notNull(),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    nextActionAt: timestamp("nextActionAt"),
  },
  (t) => ({
    bySeq: index("ix_enr_seq").on(t.sequenceId),
    byProspect: index("ix_enr_prospect").on(t.prospectId),
  }),
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
    // Migration 0085: prospect-target drafts (no contact promotion).
    toProspectId: int("toProspectId"),
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
    /** Which sending_accounts row the message was dispatched from. */
    sendingAccountId: int("sendingAccountId"),
    /** Zero-based step index this draft was generated for. NULL for ad-hoc / non-sequence drafts. */
    stepIndex: int("stepIndex"),
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
    // AI churn-risk (Migration 0050)
    churnRiskScore: int("churnRiskScore"),
    churnRiskLabel: varchar("churnRiskLabel", { length: 16 }),
    churnRiskRationale: text("churnRiskRationale"),
    churnRiskScoredAt: timestamp("churnRiskScoredAt"),
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
    // AI pricing recommendation (Migration 0050)
    aiPriceMin: decimal("aiPriceMin", { precision: 14, scale: 2 }),
    aiPriceMax: decimal("aiPriceMax", { precision: 14, scale: 2 }),
    aiDiscountCeil: decimal("aiDiscountCeil", { precision: 5, scale: 2 }),
    aiPriceRationale: text("aiPriceRationale"),
    aiPriceScoredAt: timestamp("aiPriceScoredAt"),
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
      "are_event",
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
  /** How many days before a pending invitation expires (null = never) */
  inviteExpiryDays: int("inviteExpiryDays").default(7),
  /** Auto-extend proposal expiresAt when client opens the email (within 7 days of expiry) */
  autoExtendOnOpen: boolean("autoExtendOnOpen").default(false).notNull(),
  /** Number of days to extend expiresAt when autoExtendOnOpen fires */
  autoExtendDays: int("autoExtendDays").default(7).notNull(),
  /** ARE global defaults */
  areDefaultAutonomyMode: mysqlEnum("areDefaultAutonomyMode", ["full", "batch_approval", "review_release"]).default("batch_approval").notNull(),
  areDefaultDailySendCap: int("areDefaultDailySendCap").default(50).notNull(),
  areDefaultAutoApproveThreshold: int("areDefaultAutoApproveThreshold"),
  areDefaultSignalToOpportunity: boolean("areDefaultSignalToOpportunity").default(false).notNull(),
  areDefaultChannels: json("areDefaultChannels"),
  areDefaultSequenceTemplate: varchar("areDefaultSequenceTemplate", { length: 64 }).default("standard_7step").notNull(),
  areMaxConcurrentCampaigns: int("areMaxConcurrentCampaigns").default(5).notNull(),
  areNotifyOnMeetingBooked: boolean("areNotifyOnMeetingBooked").default(true).notNull(),
  areNotifyOnAutoApprove: boolean("areNotifyOnAutoApprove").default(false).notNull(),
  areNotifyOnIcpUpdate: boolean("areNotifyOnIcpUpdate").default(true).notNull(),
  // ARE Settings UI fields that previously had no persistence (Migration 0087)
  areBrandVoice: varchar("areBrandVoice", { length: 40 }),
  areScraperSources: json("areScraperSources"),
  areIcpRegenSchedule: varchar("areIcpRegenSchedule", { length: 20 }),
  areSequenceQualityThreshold: int("areSequenceQualityThreshold"),
  // AI auto-send toggle (Migration 0050)
  aiAutoSendEnabled: boolean("aiAutoSendEnabled").default(false).notNull(),
  aiAutoSendScoreMin: int("aiAutoSendScoreMin").default(70).notNull(),
  aiAutoSendConfidenceMin: int("aiAutoSendConfidenceMin").default(75).notNull(),
  // When true, auto-send dispatches sequence drafts to recipients with a
  // NULL relationship-strength / lead score (cold mass-outreach). Default
  // false preserves the warm-only protection for workspaces that don't
  // explicitly opt in. See autoSendForAllWorkspaces in routers/sequences.
  aiAutoSendAllowUnscored: boolean("aiAutoSendAllowUnscored").default(false).notNull(),
  // BYOK AI provider credentials (Migration 0056). API keys are stored as
  // AES-256-GCM ciphertext in `iv:ciphertext:authTag` hex form — see server/_core/crypto.ts.
  anthropicApiKeyEnc: text("anthropicApiKeyEnc"),
  openaiApiKeyEnc: text("openaiApiKeyEnc"),
  geminiApiKeyEnc: text("geminiApiKeyEnc"),
  anthropicModel: varchar("anthropicModel", { length: 128 }),
  openaiModel: varchar("openaiModel", { length: 128 }),
  geminiModel: varchar("geminiModel", { length: 128 }),
  aiDefaultProvider: varchar("aiDefaultProvider", { length: 32 }), // 'anthropic' | 'openai' | 'gemini'
  // ── Task Autopilot (Migration 0099) — the /v2/tasks autonomy engine ──
  // off      = AI never generates tasks (fully manual)
  // approval = AI drafts next-best-action tasks; a human approves before they go live
  // auto     = AI creates live open tasks with no human step (100% autonomous)
  taskAutopilotMode: mysqlEnum("taskAutopilotMode", ["off", "approval", "auto"]).default("off").notNull(),
  taskAutopilotDailyCap: int("taskAutopilotDailyCap").default(25).notNull(),
  taskAutopilotLastRunAt: timestamp("taskAutopilotLastRunAt"),
  // ── Meeting Autopilot (Migration 0100) — the /v2/meetings autonomy engine ──
  // off = never; approval = AI proposes meetings for review; auto = AI proposes
  // AND sends the calendar invite automatically (when a calendar is connected).
  meetingAutopilotMode: mysqlEnum("meetingAutopilotMode", ["off", "approval", "auto"]).default("off").notNull(),
  meetingAutopilotDailyCap: int("meetingAutopilotDailyCap").default(10).notNull(),
  meetingAutopilotLastRunAt: timestamp("meetingAutopilotLastRunAt"),
  // ── Conversation Autopilot (Migration 0101) — autonomous reply handling ──
  // off = never; approval = AI classifies replies + suggests actions for review;
  // auto = AI classifies AND executes actions (propose meeting / task / suppress).
  conversationAutopilotMode: mysqlEnum("conversationAutopilotMode", ["off", "approval", "auto"]).default("off").notNull(),
  conversationAutopilotDailyCap: int("conversationAutopilotDailyCap").default(100).notNull(),
  conversationAutopilotLastRunAt: timestamp("conversationAutopilotLastRunAt"),
  // ── Deal Autopilot (Migration 0102) — autonomous pipeline manager ──
  // off = never; approval = AI writes a next-step/win-prob per open deal for review;
  // auto = AI also creates the follow-up task so deals keep moving toward close.
  dealAutopilotMode: mysqlEnum("dealAutopilotMode", ["off", "approval", "auto"]).default("off").notNull(),
  dealAutopilotDailyCap: int("dealAutopilotDailyCap").default(50).notNull(),
  dealAutopilotLastRunAt: timestamp("dealAutopilotLastRunAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Login History
   ────────────────────────────────────────────────────────────────────────── */
export const loginHistory = mysqlTable(
  "login_history",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    workspaceId: int("workspaceId"),
    ipAddress: varchar("ipAddress", { length: 64 }),
    userAgent: text("userAgent"),
    /** success | failed | expired_invite */
    outcome: mysqlEnum("outcome", ["success", "failed", "expired_invite"]).default("success").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("ix_lh_user").on(t.userId),
    byWs: index("ix_lh_ws").on(t.workspaceId),
  }),
);
export type LoginHistory = typeof loginHistory.$inferSelect;

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
    // React Flow node id, unique per sequence (not globally). The PK is
    // composite (sequenceId, id) so the same React-Flow id (e.g.
    // "start-1") can exist in different sequences.
    id: varchar("id", { length: 64 }).notNull(),
    sequenceId: int("sequenceId").notNull(),
    workspaceId: int("workspaceId").notNull(),
    type: mysqlEnum("type", ["start", "email", "wait", "condition", "action", "goal", "linkedin_dm", "linkedin_invite"]).notNull(),
    positionX: int("positionX").default(0).notNull(),
    positionY: int("positionY").default(0).notNull(),
    data: json("data").notNull(), // node-type-specific config payload
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sequenceId, t.id] }),
    byWs: index("ix_sn_ws").on(t.workspaceId),
  }),
);
export type SequenceNode = typeof sequenceNodes.$inferSelect;

export const sequenceEdges = mysqlTable(
  "sequence_edges",
  {
    // React Flow edge id, unique per sequence (not globally) — same
    // reasoning as sequence_nodes.
    id: varchar("id", { length: 64 }).notNull(),
    sequenceId: int("sequenceId").notNull(),
    workspaceId: int("workspaceId").notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    target: varchar("target", { length: 64 }).notNull(),
    sourceHandle: varchar("sourceHandle", { length: 32 }), // "true" | "false" | null
    label: varchar("label", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sequenceId, t.id] }),
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
    /** AI-suggested next stage (e.g. "proposal") — null means no change suggested */
    suggestedStage: varchar("suggestedStage", { length: 64 }),
    suggestedStageRationale: text("suggestedStageRationale"),
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
    // Sharing (Migration 0105): team = visible/usable by everyone; private = owner + managers only.
    visibility: mysqlEnum("visibility", ["private", "team"]).default("team").notNull(),
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
    // Sharing (Migration 0105): team = usable by everyone; private = owner + managers only.
    visibility: mysqlEnum("visibility", ["private", "team"]).default("team").notNull(),
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

// ── Record lists (Apollo-style static saved-record lists) ───────────────────
// Unlike audienceSegments (dynamic, rule-based), these hold an explicit set of
// members you add/remove by hand. entityType groups them People vs Companies on
// the /v2/lists index; members live in record_list_members. Migration 0093.
export const recordLists = mysqlTable(
  "record_lists",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    entityType: varchar("entity_type", { length: 16 }).default("people").notNull(), // people | companies
    description: text("description"),
    createdByUserId: int("created_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_rl_ws").on(t.workspaceId) }),
);
export type RecordList = typeof recordLists.$inferSelect;

export const recordListMembers = mysqlTable(
  "record_list_members",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    listId: int("list_id").notNull(),
    recordType: varchar("record_type", { length: 16 }).notNull(), // prospect | contact | account
    recordId: int("record_id").notNull(),
    addedByUserId: int("added_by_user_id"),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => ({ byList: index("ix_rlm_list").on(t.listId), byWs: index("ix_rlm_ws").on(t.workspaceId) }),
);
export type RecordListMember = typeof recordListMembers.$inferSelect;

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
   Supports: outlook_oauth, amazon_ses, generic_smtp
   ────────────────────────────────────────────────────────────────────────── */
export const sendingAccounts = mysqlTable(
  "sending_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    provider: mysqlEnum("provider", [
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
    /** When set, this row bridges to a Unipile-managed account (Migration 0057). */
    unipileAccountId: varchar("unipileAccountId", { length: 64 }),
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
    // ── AI reply classification + autonomous handling (Migration 0101) ──
    // replyClass = the 8-class taxonomy from the email-activity spec.
    replyClass: varchar("replyClass", { length: 48 }), // willing_to_meet|follow_up_question|person_referral|out_of_office|already_left_company_or_not_right_person|not_interested|unsubscribe|none_of_the_above
    sentiment: varchar("sentiment", { length: 16 }),   // positive|neutral|negative|objection
    classConfidence: int("classConfidence"),
    classReasoning: text("classReasoning"),
    suggestedReply: text("suggestedReply"),            // AI-drafted reply body (approval mode)
    classifiedAt: timestamp("classifiedAt"),
    autoActionTaken: varchar("autoActionTaken", { length: 48 }), // meeting_proposed|task_created|suppressed|ooo_noted|marked|none
    meetingId: int("meetingId"),                       // link to the meetings row a positive reply created
    handledAt: timestamp("handledAt"),
    handledBy: varchar("handledBy", { length: 16 }),   // ai|user
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
    /** When set, this row bridges to a Unipile-managed account (Migration 0057). */
    unipileAccountId: varchar("unipileAccountId", { length: 64 }),
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

// ─── Unipile Multichannel Tables ─────────────────────────────────────────────

export const unipileAccounts = mysqlTable(
  "unipile_accounts",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    unipileAccountId: varchar("unipileAccountId", { length: 200 }).notNull(),
    provider: varchar("provider", { length: 30 }).notNull(),
    displayName: varchar("displayName", { length: 200 }),
    profilePicture: varchar("profilePicture", { length: 1000 }),
    status: varchar("status", { length: 30 }).default("CONNECTING").notNull(),
    connectedAt: timestamp("connectedAt"),
    lastSyncAt: timestamp("lastSyncAt"),
    metadata: json("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byUser: index("ix_ua_user").on(t.workspaceId, t.userId),
    byUnipileId: index("ix_ua_unipile_id").on(t.unipileAccountId),
  }),
);
export type UnipileAccount = typeof unipileAccounts.$inferSelect;

export const unipileMessages = mysqlTable(
  "unipile_messages",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    unipileAccountId: varchar("unipileAccountId", { length: 200 }).notNull(),
    provider: varchar("provider", { length: 30 }).notNull(),
    chatId: varchar("chatId", { length: 500 }).notNull(),
    messageId: varchar("messageId", { length: 500 }).notNull(),
    direction: varchar("direction", { length: 10 }).notNull(),
    senderName: varchar("senderName", { length: 200 }),
    senderProviderId: varchar("senderProviderId", { length: 500 }),
    recipientName: varchar("recipientName", { length: 200 }),
    recipientProviderId: varchar("recipientProviderId", { length: 500 }),
    text: text("text"),
    attachmentUrl: varchar("attachmentUrl", { length: 1000 }),
    linkedContactId: int("linkedContactId"),
    linkedLeadId: int("linkedLeadId"),
    linkedOpportunityId: int("linkedOpportunityId"),
    activityId: int("activityId"),
    readAt: timestamp("readAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byAccount: index("ix_um_account").on(t.workspaceId, t.unipileAccountId),
    byChat: index("ix_um_chat").on(t.chatId),
    byContact: index("ix_um_contact").on(t.linkedContactId),
    byLead: index("ix_um_lead").on(t.linkedLeadId),
    byMsgId: index("ix_um_msgid").on(t.messageId),
  }),
);
export type UnipileMessage = typeof unipileMessages.$inferSelect;

export const unipileInvites = mysqlTable(
  "unipile_invites",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    unipileAccountId: varchar("unipileAccountId", { length: 200 }).notNull(),
    recipientProviderId: varchar("recipientProviderId", { length: 500 }).notNull(),
    recipientName: varchar("recipientName", { length: 200 }),
    message: text("message"),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    linkedContactId: int("linkedContactId"),
    linkedLeadId: int("linkedLeadId"),
    activityId: int("activityId"),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
    acceptedAt: timestamp("acceptedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("ix_ui_user").on(t.workspaceId, t.userId),
    byAccount: index("ix_ui_account").on(t.unipileAccountId),
    byContact: index("ix_ui_contact").on(t.linkedContactId),
  }),
);
export type UnipileInvite = typeof unipileInvites.$inferSelect;

/**
 * unipile_emails_cache — Webhook-fed local cache of email events.
 *
 * Populated by POST /api/unipile/mail-webhook on mail_received / mail_sent /
 * mail_moved. The UnipileMailAdapter falls back to this table when Unipile's
 * /emails endpoint returns 0 items (the "sync hasn't indexed history" failure
 * mode). Once /emails comes online for an account, this cache continues to
 * serve as a write-through layer for real-time updates without polling.
 *
 * Note: this is NOT a full historical archive — only emails that arrived
 * after the webhook was registered. Historical mail requires Unipile's
 * server-side sync to complete.
 */
export const unipileEmailsCache = mysqlTable(
  "unipile_emails_cache",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    unipileAccountId: varchar("unipileAccountId", { length: 200 }).notNull(),
    emailId: varchar("emailId", { length: 200 }).notNull(),
    threadId: varchar("threadId", { length: 200 }),
    providerMessageId: varchar("providerMessageId", { length: 500 }),
    subject: text("subject"),
    fromName: varchar("fromName", { length: 320 }),
    fromEmail: varchar("fromEmail", { length: 320 }),
    toJson: json("toJson"),
    ccJson: json("ccJson"),
    bccJson: json("bccJson"),
    replyToJson: json("replyToJson"),
    bodyHtml: text("bodyHtml"),
    bodyPlain: text("bodyPlain"),
    attachmentsJson: json("attachmentsJson"),
    foldersJson: json("foldersJson"),
    role: varchar("role", { length: 40 }),
    hasAttachments: boolean("hasAttachments").default(false).notNull(),
    readDate: timestamp("readDate"),
    inReplyToId: varchar("inReplyToId", { length: 200 }),
    emailDate: timestamp("emailDate"),
    origin: varchar("origin", { length: 20 }),
    trackingId: varchar("trackingId", { length: 200 }),
    lastEvent: varchar("lastEvent", { length: 30 }),
    rawJson: json("rawJson"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uqEmailId: uniqueIndex("uq_uec_emailid").on(t.emailId),
    byAccountDate: index("ix_uec_account_date").on(
      t.workspaceId,
      t.unipileAccountId,
      t.emailDate,
    ),
    byThread: index("ix_uec_thread").on(t.threadId),
  }),
);
export type UnipileEmailCache = typeof unipileEmailsCache.$inferSelect;
export type InsertUnipileEmailCache = typeof unipileEmailsCache.$inferInsert;

/* ──────────────────────────────────────────────────────────────────────────
   Member Permissions
   ────────────────────────────────────────────────────────────────────────── */

export const memberPermissions = mysqlTable(
  "member_permissions",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    feature: varchar("feature", { length: 80 }).notNull(),
    granted: boolean("granted").default(true).notNull(),
    grantedBy: int("grantedBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("ix_mp_uniq").on(t.workspaceId, t.userId, t.feature),
    byUser: index("ix_mp_user").on(t.workspaceId, t.userId),
  }),
);
export type MemberPermission = typeof memberPermissions.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Proposals
   ────────────────────────────────────────────────────────────────────────── */

export const proposals = mysqlTable(
  "proposals",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    createdBy: int("createdBy").notNull(),
    // Client info
    title: varchar("title", { length: 255 }).notNull(),
    clientName: varchar("clientName", { length: 255 }).notNull(),
    clientEmail: varchar("clientEmail", { length: 320 }),
    clientWebsite: varchar("clientWebsite", { length: 512 }),
    orgAbbr: varchar("orgAbbr", { length: 32 }),
    // Linked CRM records (optional)
    contactId: int("contactId"),
    accountId: int("accountId"),
    // Project details
    projectType: varchar("projectType", { length: 120 }),
    rfpDeadline: timestamp("rfpDeadline"),
    completionDate: timestamp("completionDate"),
    budget: decimal("budget", { precision: 14, scale: 2 }),
    description: text("description"),
    requirements: json("requirements").$type<string[]>().default([]),
    // Status workflow
    status: mysqlEnum("status", [
      "draft",
      "sent",
      "under_review",
      "accepted",
      "not_accepted",
      "revision_requested",
    ])
      .default("draft")
      .notNull(),
    // Sharing
    shareToken: varchar("shareToken", { length: 128 }).unique(),
    sentAt: timestamp("sentAt"),
    emailOpenedAt: timestamp("emailOpenedAt"),
    emailClickedAt: timestamp("emailClickedAt"),
    acceptedAt: timestamp("acceptedAt"),
    expiresAt: timestamp("expiresAt"),
    /** When true, the email-open auto-extend logic is skipped for this proposal */
    skipAutoExtend: boolean("skipAutoExtend").default(false).notNull(),
    // Pipeline integration
    linkedOpportunityId: int("linkedOpportunityId"),  // fk to opportunities
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWorkspace: index("ix_prop_ws").on(t.workspaceId),
    byCreator: index("ix_prop_creator").on(t.workspaceId, t.createdBy),
    byToken: uniqueIndex("ix_prop_token").on(t.shareToken),
  }),
);
export type Proposal = typeof proposals.$inferSelect;
export type InsertProposal = typeof proposals.$inferInsert;

export const proposalSections = mysqlTable(
  "proposal_sections",
  {
    id: int("id").autoincrement().primaryKey(),
    proposalId: int("proposalId").notNull(),
    sectionKey: varchar("sectionKey", { length: 64 }).notNull(),
    content: text("content").default("").notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("ix_ps_uniq").on(t.proposalId, t.sectionKey),
    byProposal: index("ix_ps_proposal").on(t.proposalId),
  }),
);
export type ProposalSection = typeof proposalSections.$inferSelect;

export const proposalMilestones = mysqlTable(
  "proposal_milestones",
  {
    id: int("id").autoincrement().primaryKey(),
    proposalId: int("proposalId").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    milestoneDate: timestamp("milestoneDate"),
    description: text("description"),
    owner: mysqlEnum("owner", ["lsi_media", "client", "both"]).default("lsi_media").notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
  },
  (t) => ({
    byProposal: index("ix_pm_proposal").on(t.proposalId),
  }),
);
export type ProposalMilestone = typeof proposalMilestones.$inferSelect;

export const proposalFeedback = mysqlTable(
  "proposal_feedback",
  {
    id: int("id").autoincrement().primaryKey(),
    proposalId: int("proposalId").notNull(),
    authorName: varchar("authorName", { length: 255 }).notNull(),
    authorEmail: varchar("authorEmail", { length: 320 }),
    message: text("message").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byProposal: index("ix_pf_proposal").on(t.proposalId),
  }),
);
export type ProposalFeedback = typeof proposalFeedback.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Proposal Revisions (version history)
   ────────────────────────────────────────────────────────────────────────── */
export const proposalRevisions = mysqlTable(
  "proposal_revisions",
  {
    id: int("id").autoincrement().primaryKey(),
    proposalId: int("proposalId").notNull(),
    sectionKey: varchar("sectionKey", { length: 64 }).notNull(),
    content: text("content").notNull(),
    savedByUserId: int("savedByUserId"),
    savedByName: varchar("savedByName", { length: 120 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byProposal: index("ix_pr_proposal").on(t.proposalId),
    bySection: index("ix_pr_section").on(t.proposalId, t.sectionKey),
  }),
);
export type ProposalRevision = typeof proposalRevisions.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Proposal Score History (daily engagement score snapshots)
   ────────────────────────────────────────────────────────────────────────── */
export const proposalScoreHistory = mysqlTable(
  "proposal_score_history",
  {
    id: int("id").autoincrement().primaryKey(),
    proposalId: int("proposalId").notNull(),
    score: int("score").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byProposal: index("ix_psh_proposal").on(t.proposalId),
    byProposalDate: index("ix_psh_proposal_date").on(t.proposalId, t.createdAt),
  }),
);
export type ProposalScoreHistory = typeof proposalScoreHistory.$inferSelect;

/* ══════════════════════════════════════════════════════════════════════════════
   AUTONOMOUS REVENUE ENGINE (ARE) — Round 19
   Tables: icp_profiles, are_campaigns, prospect_queue, prospect_intelligence,
           are_execution_queue, are_signal_log, are_ab_variants,
           are_suppression_list, are_scrape_jobs
   ══════════════════════════════════════════════════════════════════════════════ */

/* ──────────────────────────────────────────────────────────────────────────
   ICP Profiles — versioned Ideal Customer Profile inferred by AI
   ────────────────────────────────────────────────────────────────────────── */
export const icpProfiles = mysqlTable(
  "icp_profiles",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    version: int("version").default(1).notNull(),
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
    // Target dimensions (JSON arrays of weighted objects)
    targetIndustries: json("targetIndustries"),   // [{industry, weight, examples[]}]
    targetCompanySizeMin: int("targetCompanySizeMin"),
    targetCompanySizeMax: int("targetCompanySizeMax"),
    targetRevenueMin: decimal("targetRevenueMin", { precision: 18, scale: 2 }),
    targetRevenueMax: decimal("targetRevenueMax", { precision: 18, scale: 2 }),
    targetTitles: json("targetTitles"),           // [{title, seniority, role, weight}]
    targetGeographies: json("targetGeographies"), // [{country, region, weight}]
    targetTechStack: json("targetTechStack"),     // [{technology, signal_type, weight}]
    antiPatterns: json("antiPatterns"),           // [{dimension, value, reason}]
    // Deal metrics
    avgDealValue: decimal("avgDealValue", { precision: 14, scale: 2 }),
    avgSalesCycleDays: int("avgSalesCycleDays"),
    topConversionSignals: json("topConversionSignals"), // [{signal, correlation_score}]
    // Meta
    confidenceScore: int("confidenceScore").default(0).notNull(), // 0-100
    sampleWonDeals: int("sampleWonDeals").default(0).notNull(),
    aiRationale: text("aiRationale"),  // markdown narrative
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_icp_ws").on(t.workspaceId),
    byWsVersion: index("ix_icp_ws_ver").on(t.workspaceId, t.version),
  }),
);
export type IcpProfile = typeof icpProfiles.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   ARE Campaigns — autonomous prospecting campaign configuration
   ────────────────────────────────────────────────────────────────────────── */
export const areCampaigns = mysqlTable(
  "are_campaigns",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    status: mysqlEnum("status", ["draft", "active", "paused", "completed"]).default("draft").notNull(),
    autonomyMode: mysqlEnum("autonomyMode", ["full", "batch_approval", "review_release"]).default("batch_approval").notNull(),
    icpProfileId: int("icpProfileId"),  // FK to icp_profiles; null = use latest active
    icpOverrides: json("icpOverrides"), // partial ICP overrides for this campaign
    // Sourcing
    prospectSources: json("prospectSources"), // ['internal','google_business','linkedin','web','news','apollo','zoominfo','clay','ai_research']
    targetProspectCount: int("targetProspectCount").default(100).notNull(),
    dailySendCap: int("dailySendCap").default(50).notNull(),
    // Channels
    channelsEnabled: json("channelsEnabled"), // {email:bool, linkedin:bool, sms:bool, voice:bool}
    sequenceTemplate: varchar("sequenceTemplate", { length: 64 }).default("standard_7step").notNull(),
    /** Free-form instructions appended to the Sequence Agent system prompt
     *  for this campaign (voice/tone/constraints). Null → defaults only. */
    sequencePrompt: text("sequencePrompt"),
    /** Structured prompting editor (migration 0090). promptSubject/promptBody
     *  are AI GUIDANCE woven into the template + personalization prompts;
     *  promptSignature is a LITERAL block appended verbatim to every generated
     *  email body (the agent is told not to write its own sign-off). All null
     *  → behave exactly as before. */
    promptSubject: text("promptSubject"),
    promptBody: text("promptBody"),
    promptSignature: text("promptSignature"),
    /** Campaign-level 7-step skeleton generated once (one LLM call) and
     *  reused across every prospect's personalization pass. Stored as
     *  { steps: [{stepIndex, day, channel, archetype, skeleton, ctaPattern}] }. */
    generatedTemplate: json("generatedTemplate"),
    generatedTemplateAt: timestamp("generatedTemplateAt"),
    /** Per-slice rotation state used by the discovery query fan-out
     *  (migration 0084). Shape:
     *    { slices: [{ id, q, lastSearchedAt, lastNewCount }], updatedAt }
     *  Engine seeds it on first tick and updates after every slice it
     *  runs, so the stalest slice always fires next. */
    discoveryQueryState: json("discoveryQueryState"),
    goalType: mysqlEnum("goalType", ["meeting_booked", "reply", "opportunity_created"]).default("reply").notNull(),
    // Metrics (denormalised for fast dashboard reads)
    prospectsDiscovered: int("prospectsDiscovered").default(0).notNull(),
    prospectsEnriched: int("prospectsEnriched").default(0).notNull(),
    prospectsApproved: int("prospectsApproved").default(0).notNull(),
    prospectsEnrolled: int("prospectsEnrolled").default(0).notNull(),
    prospectsContacted: int("prospectsContacted").default(0).notNull(),
    prospectsReplied: int("prospectsReplied").default(0).notNull(),
    meetingsBooked: int("meetingsBooked").default(0).notNull(),
    opportunitiesCreated: int("opportunitiesCreated").default(0).notNull(),
    ownerUserId: int("ownerUserId"),
    // Automation settings
    autoApproveThreshold: int("autoApproveThreshold"),  // null = manual review; 0-100 = auto-approve if icpMatchScore >= this
    minConfidence: int("minConfidence"),  // null = default 40; min icpMatchScore a prospect needs before enrichment spends LLM budget
    signalToOpportunityEnabled: boolean("signalToOpportunityEnabled").default(false).notNull(), // auto-create opp on meeting_booked signal
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_arec_ws").on(t.workspaceId),
    byStatus: index("ix_arec_status").on(t.workspaceId, t.status),
  }),
);
export type AreCampaign = typeof areCampaigns.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Prospect Queue — staged prospects awaiting enrichment + sequence generation
   ────────────────────────────────────────────────────────────────────────── */
export const prospectQueue = mysqlTable(
  "prospect_queue",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId").notNull(),
    // Source
    sourceType: mysqlEnum("sourceType", [
      "internal_contact", "internal_lead",
      "google_business", "linkedin_company", "linkedin_people",
      "web_scrape", "news_event", "industry_event",
      "apollo", "zoominfo", "clay", "ai_research",
    ]).notNull(),
    sourceId: varchar("sourceId", { length: 256 }), // external ID from data provider
    sourceUrl: text("sourceUrl"),                    // original URL scraped
    // Person
    firstName: varchar("firstName", { length: 80 }),
    lastName: varchar("lastName", { length: 80 }),
    email: varchar("email", { length: 320 }),
    linkedinUrl: text("linkedinUrl"),
    phone: varchar("phone", { length: 40 }),
    title: varchar("title", { length: 120 }),
    // Company
    companyName: varchar("companyName", { length: 200 }),
    companyDomain: varchar("companyDomain", { length: 200 }),
    companySize: varchar("companySize", { length: 40 }),
    industry: varchar("industry", { length: 80 }),
    geography: varchar("geography", { length: 120 }),
    // Scoring
    icpMatchScore: int("icpMatchScore").default(0).notNull(), // 0-100
    icpMatchBreakdown: json("icpMatchBreakdown"), // {industry, title, size, geo, tech, antiPattern}
    // Status
    enrichmentStatus: mysqlEnum("enrichmentStatus", ["pending", "enriching", "complete", "failed"]).default("pending").notNull(),
    enrichmentError: text("enrichmentError"),
    enrichedAt: timestamp("enrichedAt"),
    sequenceStatus: mysqlEnum("sequenceStatus", ["pending", "approved", "enrolled", "skipped", "completed", "replied", "paused", "canceled"]).default("pending").notNull(),
    approvedAt: timestamp("approvedAt"),
    approvedByUserId: int("approvedByUserId"),
    rejectedAt: timestamp("rejectedAt"),
    rejectedByUserId: int("rejectedByUserId"),
    rejectionReason: text("rejectionReason"),
    // Linked CRM records (created after positive reply)
    linkedContactId: int("linkedContactId"),
    linkedOpportunityId: int("linkedOpportunityId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byCampaign: index("ix_pq_campaign").on(t.campaignId),
    byWs: index("ix_pq_ws").on(t.workspaceId),
    byEmail: index("ix_pq_email").on(t.email),
    byStatus: index("ix_pq_status").on(t.campaignId, t.enrichmentStatus),
  }),
);
export type ProspectQueue = typeof prospectQueue.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Prospect Intelligence — enrichment dossier per prospect
   ────────────────────────────────────────────────────────────────────────── */
export const prospectIntelligence = mysqlTable(
  "prospect_intelligence",
  {
    id: int("id").autoincrement().primaryKey(),
    prospectQueueId: int("prospectQueueId").notNull().unique(),
    workspaceId: int("workspaceId").notNull(),
    // Enrichment data
    triggerEvents: json("triggerEvents"),       // [{type, description, date, recencyScore, sourceUrl}]
    painSignals: json("painSignals"),           // [{signal, evidence, strength, sourceUrl}]
    relationshipPaths: json("relationshipPaths"), // [{type, contactId, description}]
    personalisationHooks: json("personalisationHooks"), // [{hook, source, verifiedAt, hookType}]
    techStack: json("techStack"),               // string[]
    recentNews: json("recentNews"),             // [{headline, url, date, sentiment}]
    industryEvents: json("industryEvents"),     // [{eventName, date, role, url}]
    googleBusinessData: json("googleBusinessData"), // {rating, reviewCount, categories[], address, phone, website}
    linkedinSummary: text("linkedinSummary"),   // AI-generated 2-sentence summary
    companyOneLiner: text("companyOneLiner"),   // AI-generated one-sentence company description
    // Recommendations
    recommendedChannel: mysqlEnum("recommendedChannel", ["email", "linkedin", "sms", "voice"]).default("email").notNull(),
    recommendedTiming: json("recommendedTiming"), // {dayOfWeek, hourOfDay, timezone}
    enrichmentConfidence: int("enrichmentConfidence").default(0).notNull(), // 0-100
    // Generated sequence
    generatedSequence: json("generatedSequence"), // [{stepIndex, day, channel, subject?, body, variantKey}]
    sequenceQualityScore: int("sequenceQualityScore"), // 0-40 (sum of 4 dimensions × 10)
    sequenceQualityBreakdown: json("sequenceQualityBreakdown"), // {specificity, clarity, brevity, cta}
    sequenceRewriteCount: int("sequenceRewriteCount").default(0).notNull(),
    enhancedHook: text("enhancedHook"),           // AI-rewritten hook after signal enhancement
    signalEnhancedAt: timestamp("signalEnhancedAt"), // when the hook was last enhanced
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byProspect: index("ix_pi_prospect").on(t.prospectQueueId),
    byWs: index("ix_pi_ws").on(t.workspaceId),
  }),
);
export type ProspectIntelligence = typeof prospectIntelligence.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   ARE Execution Queue — scheduled outreach steps across all channels
   ────────────────────────────────────────────────────────────────────────── */
export const areExecutionQueue = mysqlTable(
  "are_execution_queue",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId").notNull(),
    prospectQueueId: int("prospectQueueId").notNull(),
    stepIndex: int("stepIndex").notNull(),
    channel: mysqlEnum("channel", ["email", "linkedin", "sms", "voice"]).notNull(),
    scheduledAt: timestamp("scheduledAt").notNull(),
    executedAt: timestamp("executedAt"),
    status: mysqlEnum("status", ["scheduled", "sent", "failed", "skipped", "paused"]).default("scheduled").notNull(),
    messageContent: json("messageContent"), // {subject?, body, variantKey, abVariantId?}
    externalId: varchar("externalId", { length: 256 }), // message ID from sending provider
    failureReason: text("failureReason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("ix_aeq_campaign").on(t.campaignId),
    byProspect: index("ix_aeq_prospect").on(t.prospectQueueId),
    byScheduled: index("ix_aeq_scheduled").on(t.workspaceId, t.status, t.scheduledAt),
  }),
);
export type AreExecutionQueue = typeof areExecutionQueue.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   ARE Signal Log — raw signal events (opens, replies, calls, clicks)
   ────────────────────────────────────────────────────────────────────────── */
export const areSignalLog = mysqlTable(
  "are_signal_log",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    executionQueueId: int("executionQueueId"),
    prospectQueueId: int("prospectQueueId").notNull(),
    campaignId: int("campaignId").notNull(),
    signalType: mysqlEnum("signalType", [
      "email_open", "email_click", "email_reply", "email_bounce", "email_unsubscribe",
      "linkedin_accepted", "linkedin_reply",
      "sms_reply", "sms_unsubscribe",
      "voice_connected_interested", "voice_connected_not_interested", "voice_voicemail", "voice_no_answer",
      "meeting_booked", "opportunity_created",
    ]).notNull(),
    rawPayload: json("rawPayload"),   // full webhook/event payload
    sentiment: mysqlEnum("sentiment", ["positive", "neutral", "negative", "objection"]),
    sentimentReason: text("sentimentReason"), // AI-extracted reason
    processedAt: timestamp("processedAt").defaultNow().notNull(),
    actionTaken: varchar("actionTaken", { length: 120 }), // 'paused_sequence' | 'created_opportunity' | 'added_suppression' | etc.
  },
  (t) => ({
    byProspect: index("ix_asl_prospect").on(t.prospectQueueId),
    byCampaign: index("ix_asl_campaign").on(t.campaignId),
    byType: index("ix_asl_type").on(t.workspaceId, t.signalType),
  }),
);
export type AreSignalLog = typeof areSignalLog.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   ARE Engine Logs — per-campaign timeline of engine actions (Logs tab)
   ────────────────────────────────────────────────────────────────────────── */
export const areEngineLogs = mysqlTable(
  "are_engine_logs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId").notNull(),
    /** Phase tag: enrich | screen | sequence | enroll | dispatch | discovery | counters | complete | tick | error */
    phase: varchar("phase", { length: 32 }).notNull(),
    /** info | warn | error */
    level: varchar("level", { length: 8 }).default("info").notNull(),
    message: text("message").notNull(),
    details: json("details"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("ix_ael_campaign").on(t.campaignId, t.createdAt),
    byWs: index("ix_ael_ws").on(t.workspaceId, t.createdAt),
  }),
);
export type AreEngineLog = typeof areEngineLogs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Personas — reusable target-profile templates applied to campaigns,
   searches, and sequences (Job Titles, Industries, Size, Geo, Keywords).
   ────────────────────────────────────────────────────────────────────────── */
export const personas = mysqlTable(
  "personas",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    targetTitles: json("targetTitles"),
    targetIndustries: json("targetIndustries"),
    targetGeographies: json("targetGeographies"),
    employeeMin: int("employeeMin"),
    employeeMax: int("employeeMax"),
    keywords: json("keywords"),
    isPreset: boolean("isPreset").default(false).notNull(),
    categoryId: int("categoryId"),
    createdByUserId: int("createdByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_personas_ws").on(t.workspaceId),
  }),
);
export type Persona = typeof personas.$inferSelect;

/** User-defined groupings for the Personas page. NULL personas.categoryId =
 *  uncategorized. sortOrder drives section order (no FK — schema has none). */
export const personaCategories = mysqlTable(
  "persona_categories",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    sortOrder: int("sortOrder").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_persona_categories_ws").on(t.workspaceId, t.sortOrder),
  }),
);
export type PersonaCategory = typeof personaCategories.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   ARE A/B Variants — message variant performance tracking
   ────────────────────────────────────────────────────────────────────────── */
export const areAbVariants = mysqlTable(
  "are_ab_variants",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId").notNull(),
    stepIndex: int("stepIndex").notNull(),
    variantKey: varchar("variantKey", { length: 8 }).notNull(), // 'A' | 'B'
    hookType: varchar("hookType", { length: 64 }), // 'trigger_event' | 'pain_signal' | 'relationship_path'
    subjectLine: varchar("subjectLine", { length: 240 }),
    bodyPreview: text("bodyPreview"), // first 300 chars
    sentCount: int("sentCount").default(0).notNull(),
    openCount: int("openCount").default(0).notNull(),
    replyCount: int("replyCount").default(0).notNull(),
    meetingCount: int("meetingCount").default(0).notNull(),
    isWinner: boolean("isWinner").default(false).notNull(),
    promotedAt: timestamp("promotedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("ix_aav_campaign").on(t.campaignId),
    byVariant: uniqueIndex("ix_aav_variant").on(t.campaignId, t.stepIndex, t.variantKey),
  }),
);
export type AreAbVariant = typeof areAbVariants.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   ARE Suppression List — contacts that must never be contacted
   ────────────────────────────────────────────────────────────────────────── */
export const areSuppressionList = mysqlTable(
  "are_suppression_list",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    email: varchar("email", { length: 320 }),
    linkedinUrl: text("linkedinUrl"),
    companyDomain: varchar("companyDomain", { length: 200 }),
    reason: mysqlEnum("reason", ["unsubscribe", "bounce", "competitor", "existing_customer", "manual", "do_not_contact"]).notNull(),
    addedByUserId: int("addedByUserId"),
    addedAt: timestamp("addedAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_asupp_ws").on(t.workspaceId),
    byEmail: index("ix_asupp_email").on(t.workspaceId, t.email),
  }),
);
export type AreSuppressionList = typeof areSuppressionList.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Prospect Notes — rep-authored notes on a queued prospect
   ────────────────────────────────────────────────────────────────────────── */
export const prospectNotes = mysqlTable(
  "prospect_notes",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    prospectQueueId: int("prospectQueueId").notNull(),
    userId: int("userId").notNull(),
    body: text("body").notNull(),
    isPinned: boolean("isPinned").default(false).notNull(),
    category: varchar("category", { length: 32 }).default("general").notNull(),
    editedAt: timestamp("editedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byProspect: index("ix_pn_prospect").on(t.prospectQueueId),
    byWs: index("ix_pn_ws").on(t.workspaceId),
  }),
);
export type ProspectNote = typeof prospectNotes.$inferSelect;
/* ──────────────────────────────────────────────────────────────────────────
   ARE Scrape Jobs — web/Google Business/LinkedIn/news scrape job log
   ────────────────────────────────────────────────────────────────────────── */
export const areScrapeJobs = mysqlTable(
  "are_scrape_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId"),
    sourceType: mysqlEnum("sourceType", [
      "google_business", "linkedin_company", "linkedin_people",
      "web_scrape", "news", "industry_events",
    ]).notNull(),
    query: text("query").notNull(),          // search query or URL
    status: mysqlEnum("status", ["pending", "running", "complete", "failed"]).default("pending").notNull(),
    resultCount: int("resultCount").default(0).notNull(),
    rawResults: json("rawResults"),          // array of discovered prospect objects
    errorMessage: text("errorMessage"),
    scrapedAt: timestamp("scrapedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_asj_ws").on(t.workspaceId),
    byCampaign: index("ix_asj_campaign").on(t.campaignId),
  }),
);
export type AreScrapeJob = typeof areScrapeJobs.$inferSelect;

// ── ARE Re-evaluation Run History ─────────────────────────────────────────────
export const reevalRuns = mysqlTable(
  "reeval_runs",
  {
    id: int("id").primaryKey().autoincrement(),
    workspaceId: int("workspaceId").notNull(),
    campaignId: int("campaignId").notNull(),
    createdByUserId: int("createdByUserId"),
    thresholdUsed: int("thresholdUsed").notNull(),
    processed: int("processed").notNull().default(0),
    requalified: int("requalified").notNull().default(0),
    runAt: timestamp("runAt").defaultNow().notNull(),
  },
  (t) => ({
    byCampaign: index("ix_rr_campaign").on(t.campaignId),
    byWs: index("ix_rr_ws").on(t.workspaceId),
  }),
);
export type ReevalRun = typeof reevalRuns.$inferSelect;

// ── Page Descriptions (editable per-page subtitles) ───────────────────────────
export const pageDescriptions = mysqlTable(
  "page_descriptions",
  {
    id: int("id").primaryKey().autoincrement(),
    pageKey: varchar("pageKey", { length: 100 }).notNull().unique(),
    description: text("description").notNull(),
    updatedByUserId: int("updatedByUserId"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byKey: index("ix_pd_key").on(t.pageKey),
  }),
);
export type PageDescription = typeof pageDescriptions.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Clodura.ai — Prospect Search, Ingestion & Contact Enrichment (0048)
   ────────────────────────────────────────────────────────────────────────── */

// ── Standalone prospects table (Clodura-sourced outbound prospects) ───────────
export const prospects = mysqlTable(
  "prospects",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    cloduraPersonId: varchar("clodura_person_id", { length: 64 }).unique(),
    cloduraOrgId: varchar("clodura_org_id", { length: 64 }),
    cloduraSyncedAt: timestamp("clodura_synced_at"),
    firstName: varchar("firstName", { length: 80 }).notNull(),
    lastName: varchar("lastName", { length: 80 }).notNull(),
    title: varchar("title", { length: 120 }),
    seniority: varchar("seniority", { length: 64 }),
    functionalArea: varchar("functional_area", { length: 64 }),
    linkedinUrl: text("linkedin_url"),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    city: varchar("city", { length: 80 }),
    state: varchar("state", { length: 80 }),
    country: varchar("country", { length: 80 }),
    company: varchar("company", { length: 200 }),
    companyDomain: varchar("company_domain", { length: 200 }),
    industry: varchar("industry", { length: 80 }),
    // Free-text school / university, powering the People → Education filter.
    // Populated by enrichment; NULL until then. Migration 0092.
    education: varchar("education", { length: 200 }),
    emailStatus: varchar("email_status", { length: 20 }), // verified|unverified|unavailable
    emailRevealedAt: timestamp("email_revealed_at"),
    phoneRevealedAt: timestamp("phone_revealed_at"),
    // Set whenever the scraper service runs Reoon on this prospect.
    emailVerifiedAt: timestamp("email_verified_at"),
    // Full scraper output (emails/phones/socials found, patterns verified, etc.).
    // Shape: see EnrichmentData in server/services/scraper/index.ts.
    enrichmentData: json("enrichment_data"),
    linkedContactId: int("linked_contact_id"),
    // Set when a prospect is converted to a Lead (funnel: Prospect → Lead).
    // Migration 0088. Mirrors linkedContactId but for the lead-first funnel.
    linkedLeadId: int("linked_lead_id"),
    // ── Company association (migration 0098) — auto-linked from company/
    //    companyDomain by CompanyAssociationService. ──
    accountId: int("account_id"),
    globalOrganizationId: int("global_organization_id"),
    companyMatchStatus: varchar("company_match_status", { length: 16 }), // linked|needs_review|missing|conflict
    // ── Discovery v2 verification fields (migration 0078) ───────────────
    // confidence + verification let a saved prospect carry its provenance
    // forward: confidenceScore (0-100), tier bucket, status (verified /
    // needs_review / rejected), human-readable notes, every source URL
    // that contributed, whether the LinkedIn URL was verified via Unipile,
    // and which discovery run last touched the row.
    confidenceScore: int("confidenceScore"),
    confidenceTier: mysqlEnum("confidenceTier", ["high", "medium", "low"]),
    verificationStatus: mysqlEnum("verificationStatus", ["verified", "needs_review", "rejected"]),
    verificationNotes: text("verificationNotes"),
    sourceUrls: json("sourceUrls"),
    linkedinUrlVerified: boolean("linkedinUrlVerified").default(false).notNull(),
    lastEnrichedAt: timestamp("lastEnrichedAt"),
    lastDiscoveryRunId: int("lastDiscoveryRunId"),
    // ── Profile image (optional enrichment metadata; migration 0094) ───────
    // Only permitted sources may populate these (authorized enrichment
    // provider, CRM import, user upload, or a legally accessible URL) — NEVER
    // scraped from LinkedIn. Surfaced ONLY on the full prospect profile, never
    // in People Search results, bulk tables, or exports. resolver:
    // server/services/profileImage.ts.
    profileImageUrl: text("profile_image_url"),
    profileImageSource: mysqlEnum("profile_image_source", ["enrichment_provider", "crm_import", "user_uploaded", "public_authorized_url"]),
    profileImageSourceUrl: text("profile_image_source_url"),
    profileImageLastVerifiedAt: timestamp("profile_image_last_verified_at"),
    profileImageStatus: mysqlEnum("profile_image_status", ["unknown", "available", "unavailable", "failed_to_load", "removed", "blocked_by_policy"]).default("unknown").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_pro_ws").on(t.workspaceId),
    byEmail: index("ix_pro_email").on(t.email),
  }),
);
export type Prospect = typeof prospects.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Discovery v2 — unified person/account search with verification
   (see server/services/discovery/ for the runtime; migration 0078).
   ────────────────────────────────────────────────────────────────────────── */

export const rawFinds = mysqlTable(
  "raw_finds",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    runId: int("runId").notNull(),
    source: varchar("source", { length: 40 }).notNull(),
    sourceUrl: text("sourceUrl"),
    pageTitle: varchar("pageTitle", { length: 400 }),
    snippet: text("snippet"),
    firstName: varchar("firstName", { length: 80 }),
    lastName: varchar("lastName", { length: 80 }),
    title: varchar("title", { length: 200 }),
    companyName: varchar("companyName", { length: 200 }),
    companyDomain: varchar("companyDomain", { length: 200 }),
    linkedinUrl: text("linkedinUrl"),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 40 }),
    location: varchar("location", { length: 200 }),
    rawJson: json("rawJson"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byRun: index("ix_rf_run").on(t.runId),
    byWs: index("ix_rf_ws").on(t.workspaceId, t.createdAt),
  }),
);
export type RawFind = typeof rawFinds.$inferSelect;

export const discoveryRuns = mysqlTable(
  "discovery_runs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId"),
    /** Optional link to an ARE campaign so the run surfaces in that
     *  campaign's Logs tab (migration 0079). Null for general searches
     *  fired from /find-prospects. */
    campaignId: int("campaignId"),
    mode: mysqlEnum("mode", ["person", "account"]).notNull(),
    input: json("input").notNull(),
    status: mysqlEnum("status", ["running", "complete", "failed"]).default("running").notNull(),
    rawFindCount: int("rawFindCount").default(0).notNull(),
    prospectsCreated: int("prospectsCreated").default(0).notNull(),
    highConfidenceCount: int("highConfidenceCount").default(0).notNull(),
    mediumConfidenceCount: int("mediumConfidenceCount").default(0).notNull(),
    lowConfidenceCount: int("lowConfidenceCount").default(0).notNull(),
    durationMs: int("durationMs").default(0).notNull(),
    errorMessage: text("errorMessage"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  (t) => ({
    byWs: index("ix_dr_ws").on(t.workspaceId, t.startedAt),
  }),
);
export type DiscoveryRun = typeof discoveryRuns.$inferSelect;

export const discoveryLogs = mysqlTable(
  "discovery_logs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    runId: int("runId").notNull(),
    phase: varchar("phase", { length: 32 }).notNull(),
    level: varchar("level", { length: 8 }).default("info").notNull(),
    message: text("message").notNull(),
    details: json("details"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byRun: index("ix_dl_run").on(t.runId, t.createdAt),
  }),
);
export type DiscoveryLog = typeof discoveryLogs.$inferSelect;

// ── Async reveal job tracking ─────────────────────────────────────────────────
export const cloduraRevealJobs = mysqlTable(
  "clodura_reveal_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    trackingId: varchar("tracking_id", { length: 128 }).unique().notNull(),
    prospectId: int("prospect_id").notNull(),
    kind: varchar("kind", { length: 10 }).notNull(), // email|phone
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    requestedBy: int("requested_by"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    error: text("error"),
  },
  (t) => ({
    byProspect: index("ix_crj_prospect").on(t.prospectId),
    byTracking: index("ix_crj_tracking").on(t.trackingId),
  }),
);
export type CloduraRevealJob = typeof cloduraRevealJobs.$inferSelect;

// ── Per-user saved search filters ─────────────────────────────────────────────
export const cloduraSavedSearches = mysqlTable(
  "clodura_saved_searches",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id").notNull(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }),
    filters: json("filters").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byUser: index("ix_css_user").on(t.userId, t.workspaceId),
  }),
);
export type CloduraSavedSearch = typeof cloduraSavedSearches.$inferSelect;

// ── 24-hour search response cache ─────────────────────────────────────────────
export const cloduraSearchCache = mysqlTable(
  "clodura_search_cache",
  {
    cacheKey: varchar("cache_key", { length: 128 }).notNull(),
    workspaceId: int("workspaceId").notNull(),
    response: json("response").notNull(),
    cachedAt: timestamp("cached_at").defaultNow().notNull(),
  },
  (t) => ({
    byWsCached: index("ix_csc_ws_cached").on(t.workspaceId, t.cachedAt),
  }),
);
export type CloduraSearchCache = typeof cloduraSearchCache.$inferSelect;

// ── Domain scrape cache (30-day TTL) ──────────────────────────────────────────
// Memoizes the company-site scrape (emails/phones/social URLs) so that when
// many prospects share a company domain we only touch the company website
// once per month. Workspace-agnostic — domains are public resources and
// rate-limiting/etiquette is a global concern.
export const domainScrapeCache = mysqlTable(
  "domain_scrape_cache",
  {
    domain: varchar("domain", { length: 253 }).primaryKey(),
    result: json("result").notNull(), // ScrapedSite shape
    scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
  },
  (t) => ({
    byScrapedAt: index("ix_dsc_scraped_at").on(t.scrapedAt),
  }),
);
export type DomainScrapeCache = typeof domainScrapeCache.$inferSelect;

// ── Enrichment job tracking ────────────────────────────────────────────────────
export const cloduraEnrichmentJobs = mysqlTable(
  "clodura_enrichment_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    contactId: int("contact_id").notNull(),
    trigger: varchar("trigger", { length: 20 }).notNull(), // manual|bulk|auto_on_create|scheduled
    identifierSet: json("identifier_set").notNull(),
    confidence: varchar("confidence", { length: 20 }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    creditsConsumed: int("credits_consumed").default(0),
    rawResponse: json("raw_response"),
    rawResponsePurgedAt: timestamp("raw_response_purged_at"),
    requestedBy: int("requested_by"),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    error: text("error"),
  },
  (t) => ({
    byContact: index("ix_cej_contact").on(t.contactId),
    byStatus: index("ix_cej_status").on(t.status, t.requestedAt),
    byWs: index("ix_cej_ws").on(t.workspaceId),
  }),
);
export type CloduraEnrichmentJob = typeof cloduraEnrichmentJobs.$inferSelect;

// ── Field-level enrichment history ────────────────────────────────────────────
export const contactEnrichmentHistory = mysqlTable(
  "contact_enrichment_history",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    contactId: int("contact_id").notNull(),
    enrichmentJobId: int("enrichment_job_id"),
    fieldName: varchar("field_name", { length: 80 }).notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    appliedBy: int("applied_by"),
    appliedAt: timestamp("applied_at").defaultNow().notNull(),
    source: varchar("source", { length: 40 }).notNull().default("clodura_enrich"),
  },
  (t) => ({
    byContact: index("ix_ceh_contact").on(t.contactId, t.appliedAt),
    byWs: index("ix_ceh_ws").on(t.workspaceId),
  }),
);
export type ContactEnrichmentHistory = typeof contactEnrichmentHistory.$inferSelect;

// ── Per-workspace enrichment settings ─────────────────────────────────────────
export const cloduraEnrichmentSettings = mysqlTable(
  "clodura_enrichment_settings",
  {
    workspaceId: int("workspaceId").primaryKey(),
    autoEnrichOnCreate: boolean("auto_enrich_on_create").notNull().default(false),
    scheduledReenrichEnabled: boolean("scheduled_reenrich_enabled").notNull().default(false),
    staleThresholdDays: int("stale_threshold_days").notNull().default(90),
    dailyBudgetCap: int("daily_budget_cap").notNull().default(1500),
    updatedBy: int("updated_by"),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
);
export type CloduraEnrichmentSettings = typeof cloduraEnrichmentSettings.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   AI Feature Gap Tables (Migration 0050)
   ────────────────────────────────────────────────────────────────────────── */

// ── AI Workflow Suggestions ────────────────────────────────────────────────────
export const aiWorkflowSuggestions = mysqlTable(
  "ai_workflow_suggestions",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull(),
    triggerType: varchar("triggerType", { length: 60 }).notNull(),
    triggerConfig: json("triggerConfig").notNull(),
    conditions: json("conditions").notNull(),
    actions: json("actions").notNull(),
    dismissed: boolean("dismissed").notNull().default(false),
    appliedRuleId: int("appliedRuleId"),
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_aiws_ws").on(t.workspaceId) }),
);
export type AiWorkflowSuggestion = typeof aiWorkflowSuggestions.$inferSelect;

// ── Forecast AI Commentary ─────────────────────────────────────────────────────
export const forecastAiCommentary = mysqlTable(
  "forecast_ai_commentary",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    periodLabel: varchar("periodLabel", { length: 20 }).notNull(),
    commentary: text("commentary").notNull(),
    highlights: json("highlights"),
    generatedAt: timestamp("generatedAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_fac_ws").on(t.workspaceId, t.periodLabel) }),
);
export type ForecastAiCommentary = typeof forecastAiCommentary.$inferSelect;

// ── Mailbox AI Triage ──────────────────────────────────────────────────────────
export const mailboxAiTriage = mysqlTable(
  "mailbox_ai_triage",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("accountId").notNull(),
    threadId: varchar("threadId", { length: 255 }).notNull(),
    triageLabel: varchar("triageLabel", { length: 20 }).notNull(),
    confidence: int("confidence").notNull().default(80),
    rationale: text("rationale"),
    labelledAt: timestamp("labelledAt").defaultNow().notNull(),
  },
  (t) => ({
    uqTriage: uniqueIndex("uq_triage").on(t.workspaceId, t.accountId, t.threadId),
    byWs: index("ix_triage_ws").on(t.workspaceId, t.accountId),
  }),
);
export type MailboxAiTriage = typeof mailboxAiTriage.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Help Center + Guided Tour Learning Layer (Migration 0051)
   ────────────────────────────────────────────────────────────────────────── */

export const helpCategories = mysqlTable(
  "help_categories",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    icon: varchar("icon", { length: 64 }).notNull().default("BookOpen"),
    sortOrder: int("sortOrder").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_hcat_ws").on(t.workspaceId) }),
);
export type HelpCategory = typeof helpCategories.$inferSelect;

export const helpArticles = mysqlTable(
  "help_articles",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    categoryId: int("categoryId"),
    slug: varchar("slug", { length: 200 }).notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    summary: text("summary"),
    bodyMarkdown: text("bodyMarkdown"),
    tags: json("tags"),
    status: mysqlEnum("status", ["draft", "published", "archived"]).notNull().default("draft"),
    associatedTourId: int("associatedTourId"),
    authorId: int("authorId"),
    viewCount: int("viewCount").notNull().default(0),
    helpfulCount: int("helpfulCount").notNull().default(0),
    notHelpfulCount: int("notHelpfulCount").notNull().default(0),
    pageKey: varchar("pageKey", { length: 120 }),
    readingTimeMinutes: int("readingTimeMinutes"),
    pageKeys: json("pageKeys"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (t) => ({
    uqSlug: uniqueIndex("uq_ha_ws_slug").on(t.workspaceId, t.slug),
    byWs: index("ix_ha_ws").on(t.workspaceId),
    byCat: index("ix_ha_cat").on(t.categoryId),
  }),
);
export type HelpArticle = typeof helpArticles.$inferSelect;

export const helpSearchLog = mysqlTable(
  "help_search_log",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    query: varchar("query", { length: 500 }).notNull(),
    resultsCount: int("resultsCount").notNull().default(0),
    clickedResultId: int("clickedResultId"),
    satisfied: boolean("satisfied"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_hsl_ws").on(t.workspaceId),
    byUser: index("ix_hsl_user").on(t.userId),
  }),
);

export const aiHelpConversations = mysqlTable(
  "ai_help_conversations",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    lastMessageAt: timestamp("lastMessageAt").defaultNow().notNull(),
  },
  (t) => ({ byWsUser: index("ix_ahc_ws_user").on(t.workspaceId, t.userId) }),
);
export type AiHelpConversation = typeof aiHelpConversations.$inferSelect;

export const aiHelpMessages = mysqlTable(
  "ai_help_messages",
  {
    id: int("id").autoincrement().primaryKey(),
    conversationId: int("conversationId").notNull(),
    role: mysqlEnum("role", ["user", "assistant"]).notNull(),
    body: text("body").notNull(),
    citedArticleIds: json("citedArticleIds"),
    confidence: decimal("confidence", { precision: 5, scale: 2 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byConv: index("ix_ahm_conv").on(t.conversationId) }),
);
export type AiHelpMessage = typeof aiHelpMessages.$inferSelect;

export const tours = mysqlTable(
  "tours",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description"),
    type: mysqlEnum("type", ["onboarding", "feature", "whats_new", "custom"]).notNull().default("feature"),
    roleTags: json("roleTags"),
    estimatedMinutes: int("estimatedMinutes").notNull().default(3),
    prerequisiteTourId: int("prerequisiteTourId"),
    status: mysqlEnum("status", ["draft", "published"]).notNull().default("draft"),
    createdBy: int("createdBy"),
    pageKey: varchar("pageKey", { length: 120 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (t) => ({ byWs: index("ix_tours_ws").on(t.workspaceId) }),
);
export type Tour = typeof tours.$inferSelect;

export const tourSteps = mysqlTable(
  "tour_steps",
  {
    id: int("id").autoincrement().primaryKey(),
    tourId: int("tourId").notNull(),
    sortOrder: int("sortOrder").notNull().default(0),
    targetSelector: varchar("targetSelector", { length: 500 }),
    targetDataTourId: varchar("targetDataTourId", { length: 200 }),
    routeTo: varchar("routeTo", { length: 200 }),
    title: varchar("title", { length: 300 }).notNull(),
    bodyMarkdown: text("bodyMarkdown"),
    visualTreatment: mysqlEnum("visualTreatment", ["spotlight", "pulse", "arrow", "coach"]).notNull().default("spotlight"),
    advanceCondition: mysqlEnum("advanceCondition", ["next_button", "element_clicked", "form_field_filled", "route_changed", "custom_event"]).notNull().default("next_button"),
    advanceConfig: json("advanceConfig"),
    skipAllowed: boolean("skipAllowed").notNull().default(true),
    backAllowed: boolean("backAllowed").notNull().default(true),
    branchingRules: json("branchingRules"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byTour: index("ix_ts_tour").on(t.tourId) }),
);
export type TourStep = typeof tourSteps.$inferSelect;

export const userTourProgress = mysqlTable(
  "user_tour_progress",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    tourId: int("tourId").notNull(),
    status: mysqlEnum("status", ["not_started", "in_progress", "completed", "skipped"]).notNull().default("not_started"),
    currentStep: int("currentStep").notNull().default(0),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    lastResumedAt: timestamp("lastResumedAt"),
  },
  (t) => ({
    uqUserTour: uniqueIndex("uq_utp_user_tour").on(t.userId, t.tourId),
    byWs: index("ix_utp_ws").on(t.workspaceId),
  }),
);
export type UserTourProgress = typeof userTourProgress.$inferSelect;

export const userLearningPreferences = mysqlTable(
  "user_learning_preferences",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    showCoachMascot: boolean("showCoachMascot").notNull().default(true),
    showProactiveHints: boolean("showProactiveHints").notNull().default(true),
    completedOnboarding: boolean("completedOnboarding").notNull().default(false),
    preferredTourSpeed: mysqlEnum("preferredTourSpeed", ["slow", "normal", "fast"]).notNull().default("normal"),
    dontShowHints: boolean("dontShowHints").notNull().default(false),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (t) => ({ uqWsUser: uniqueIndex("uq_ulp_ws_user").on(t.workspaceId, t.userId) }),
);
export type UserLearningPreferences = typeof userLearningPreferences.$inferSelect;

export const helpArticleFeedback = mysqlTable(
  "help_article_feedback",
  {
    id: int("id").autoincrement().primaryKey(),
    articleId: int("articleId").notNull(),
    userId: int("userId").notNull(),
    helpful: boolean("helpful").notNull(),
    comment: text("comment"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byArticle: index("ix_haf_article").on(t.articleId) }),
);
export type HelpArticleFeedback = typeof helpArticleFeedback.$inferSelect;

export const tourAchievements = mysqlTable(
  "tour_achievements",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    tourId: int("tourId").notNull(),
    badge: varchar("badge", { length: 120 }),
    earnedAt: timestamp("earnedAt").defaultNow().notNull(),
  },
  (t) => ({ byWsUser: index("ix_ta_ws_user").on(t.workspaceId, t.userId) }),
);
export type TourAchievement = typeof tourAchievements.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Mindmaps
   ────────────────────────────────────────────────────────────────────────── */
export const mindmaps = mysqlTable(
  "mindmaps",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 240 }).notNull(),
    description: text("description"),
    createdByUserId: int("createdByUserId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({ byWs: index("ix_mindmap_ws").on(t.workspaceId) }),
);
export type Mindmap = typeof mindmaps.$inferSelect;

export const mindmapNodes = mysqlTable(
  "mindmap_nodes",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // client-generated UUID
    mindmapId: int("mindmapId").notNull(),
    workspaceId: int("workspaceId").notNull(),
    type: mysqlEnum("type", ["root", "topic", "subtopic", "task", "note", "idea"]).default("topic").notNull(),
    label: varchar("label", { length: 240 }).notNull(),
    notes: text("notes"),
    posX: int("posX").default(0).notNull(),
    posY: int("posY").default(0).notNull(),
    color: varchar("color", { length: 30 }),
    parentId: varchar("parentId", { length: 64 }),
    linkedEntityType: varchar("linkedEntityType", { length: 30 }),
    linkedEntityId: int("linkedEntityId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byMap: index("ix_mmnode_map").on(t.mindmapId) }),
);
export type MindmapNode = typeof mindmapNodes.$inferSelect;

export const mindmapEdges = mysqlTable(
  "mindmap_edges",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    mindmapId: int("mindmapId").notNull(),
    workspaceId: int("workspaceId").notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    target: varchar("target", { length: 64 }).notNull(),
    label: varchar("label", { length: 120 }),
  },
  (t) => ({ byMap: index("ix_mmedge_map").on(t.mindmapId) }),
);
export type MindmapEdge = typeof mindmapEdges.$inferSelect;

// ─── Google Places budget tracking ─────────────────────────────────────────
// One row per workspace. The auto-cap fires when usageCents reaches
// monthlyBudgetCents; the threshold alert fires when usageCents crosses
// (monthlyBudgetCents * thresholdPct / 100). Both reset at month boundary
// via lazy check on each insert (no cron required — see places service).
export const placesBudget = mysqlTable(
  "places_budget",
  {
    workspaceId: int("workspaceId").primaryKey(),
    // Limit in USD cents (e.g. 20000 = $200 = the free Google credit)
    monthlyBudgetCents: int("monthly_budget_cents").default(20000).notNull(),
    // Send the threshold alert when usage hits this percentage of budget
    thresholdPct: int("threshold_pct").default(80).notNull(),
    // Master kill switch — when false, no Places API calls are allowed
    enabled: boolean("enabled").default(true).notNull(),
    // Running totals for the current period
    usageCents: int("usage_cents").default(0).notNull(),
    callsCount: int("calls_count").default(0).notNull(),
    // Period bookkeeping
    periodStart: timestamp("period_start").defaultNow().notNull(),
    thresholdAlertSentAt: timestamp("threshold_alert_sent_at"),
    capReachedAt: timestamp("cap_reached_at"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
);
export type PlacesBudget = typeof placesBudget.$inferSelect;

// Per-call audit log so admins can see what was spent on what.
export const placesSearchLog = mysqlTable(
  "places_search_log",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId"),
    endpoint: varchar("endpoint", { length: 64 }).notNull(), // "textsearch" | "details" | etc.
    query: text("query"),
    // Cost in cents (e.g. 1.7 cents per Text Search → store as 2 with rounding,
    // or just track call counts and bill per-endpoint cost in usageCents)
    costCents: int("cost_cents").notNull(),
    resultsCount: int("results_count"),
    status: varchar("status", { length: 16 }).notNull(), // "ok" | "blocked" | "error"
    error: text("error"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_psl_ws").on(t.workspaceId, t.createdAt),
  }),
);
export type PlacesSearchLog = typeof placesSearchLog.$inferSelect;

// ─── LinkedIn profile-lookup audit + rate-limit ───────────────────────────────
// One row per Unipile LinkedIn profile fetch. Used to enforce the per-account
// daily cap (LinkedIn throttles individual accounts at ~80-150 profile views
// /day; we default conservatively). Counting "today's rows for this
// unipileAccountId" gives the current usage without a separate counter table.
export const linkedinLookupLog = mysqlTable(
  "linkedin_lookup_log",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    // The Velocity user who initiated the lookup (may differ from the
    // account owner when an admin routes through the pool).
    requestedByUserId: int("requested_by_user_id").notNull(),
    // The Unipile account the lookup was performed THROUGH.
    unipileAccountId: varchar("unipile_account_id", { length: 200 }).notNull(),
    // The Velocity user who owns that bridged account.
    accountOwnerUserId: int("account_owner_user_id"),
    // LinkedIn URL / identifier that was looked up.
    targetUrl: text("target_url"),
    targetIdentifier: varchar("target_identifier", { length: 200 }),
    status: varchar("status", { length: 16 }).notNull(), // "ok" | "blocked" | "error"
    error: text("error"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byAccountDay: index("ix_lll_acct_day").on(t.unipileAccountId, t.createdAt),
    byWs: index("ix_lll_ws").on(t.workspaceId, t.createdAt),
  }),
);
export type LinkedinLookupLog = typeof linkedinLookupLog.$inferSelect;

// ─── LinkedIn per-account daily usage counter ─────────────────────────────────
// Load-bearing for the rate limit (linkedin_lookup_log is audit-only). The
// cap is enforced by an atomic conditional UPDATE on `count` — concurrent
// lookups can't blow past the cap the way a COUNT(*)-then-check could.
// Daily reset is implicit: usageDate is part of the PK, so a new UTC day is
// a fresh row starting at 0 (no cron needed).
export const linkedinDailyUsage = mysqlTable(
  "linkedin_daily_usage",
  {
    unipileAccountId: varchar("unipile_account_id", { length: 200 }).notNull(),
    /** UTC calendar date, "YYYY-MM-DD". */
    usageDate: varchar("usage_date", { length: 10 }).notNull(),
    count: int("count").default(0).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    // Composite uniqueness (account + day). The actual PRIMARY KEY is
    // declared in migration 0068; this uniqueIndex gives Drizzle the key
    // it needs for typed onDuplicateKeyUpdate.
    byAcctDate: uniqueIndex("ix_ldu_acct_date").on(t.unipileAccountId, t.usageDate),
  }),
);
export type LinkedinDailyUsage = typeof linkedinDailyUsage.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   LinkedIn enrichment (Unipile) — migration 0095

   Compliant LinkedIn profile enrichment via the AUTHORIZED Unipile vendor
   layer ONLY (no scraping). Batch URL import → Unipile retrieval (reuses
   server/services/linkedinLookup) → match to an existing prospect → store
   enrichment as OPTIONAL metadata in its own tables (never overloads the
   prospects row) → daily change check → compact UI indicators.

   Connected accounts are NOT a new table — they reuse `unipile_accounts`
   (provider='LINKEDIN'); its `metadata` json + `lastSyncAt` cover the
   capability/health fields the spec called for.

   PK convention: int AUTO_INCREMENT to match the rest of this schema (the
   source spec's UUIDs are adapted to int — every other table here uses int).
   ────────────────────────────────────────────────────────────────────────── */

/** One batch of pasted/uploaded LinkedIn URLs to enrich. */
export const linkedinEnrichmentBatches = mysqlTable(
  "linkedin_enrichment_batches",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    uploadedByUserId: int("uploaded_by_user_id").notNull(),
    /** pasted_urls | csv_upload */
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    /** created | validating | validated | running | completed | failed */
    status: varchar("status", { length: 24 }).default("created").notNull(),
    totalRows: int("total_rows").default(0).notNull(),
    validRows: int("valid_rows").default(0).notNull(),
    invalidRows: int("invalid_rows").default(0).notNull(),
    matchedRows: int("matched_rows").default(0).notNull(),
    needsReviewRows: int("needs_review_rows").default(0).notNull(),
    failedRows: int("failed_rows").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    byWs: index("ix_leb_ws").on(t.workspaceId),
  }),
);
export type LinkedinEnrichmentBatch = typeof linkedinEnrichmentBatches.$inferSelect;

/** One URL row inside a batch: validation, matching, and enrichment status. */
export const linkedinEnrichmentBatchRows = mysqlTable(
  "linkedin_enrichment_batch_rows",
  {
    id: int("id").autoincrement().primaryKey(),
    batchId: int("batch_id").notNull(),
    workspaceId: int("workspaceId").notNull(),
    originalUrl: text("original_url").notNull(),
    normalizedUrl: varchar("normalized_url", { length: 255 }),
    providedFullName: varchar("provided_full_name", { length: 200 }),
    providedFirstName: varchar("provided_first_name", { length: 100 }),
    providedLastName: varchar("provided_last_name", { length: 100 }),
    providedCompany: varchar("provided_company", { length: 200 }),
    providedTitle: varchar("provided_title", { length: 200 }),
    providedEmail: varchar("provided_email", { length: 320 }),
    providedProspectId: int("provided_prospect_id"),
    /** valid | invalid | duplicate */
    validationStatus: varchar("validation_status", { length: 16 }).default("valid").notNull(),
    validationError: varchar("validation_error", { length: 300 }),
    /** exact_match | high_confidence | possible_match | no_match | conflict */
    matchStatus: varchar("match_status", { length: 24 }),
    matchedProspectId: int("matched_prospect_id"),
    matchScore: int("match_score"),
    matchReasons: json("match_reasons"),
    /** Resolved prospect_linkedin_enrichments.id once enrichment is applied. */
    enrichmentId: int("enrichment_id"),
    /** pending | enriched | partially_enriched | failed | no_match | needs_review | skipped */
    rowStatus: varchar("row_status", { length: 24 }).default("pending").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byBatch: index("ix_lebr_batch").on(t.batchId),
    byMatched: index("ix_lebr_ws_matched").on(t.workspaceId, t.matchedProspectId),
  }),
);
export type LinkedinEnrichmentBatchRow = typeof linkedinEnrichmentBatchRows.$inferSelect;

/** Per-prospect LinkedIn enrichment record (optional metadata, one per prospect). */
export const prospectLinkedinEnrichments = mysqlTable(
  "prospect_linkedin_enrichments",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    prospectId: int("prospect_id").notNull(),
    linkedinProfileUrl: text("linkedin_profile_url").notNull(),
    linkedinProfileIdentifier: varchar("linkedin_profile_identifier", { length: 200 }),
    linkedinPublicId: varchar("linkedin_public_id", { length: 200 }),
    linkedinFullName: varchar("linkedin_full_name", { length: 200 }),
    linkedinFirstName: varchar("linkedin_first_name", { length: 100 }),
    linkedinLastName: varchar("linkedin_last_name", { length: 100 }),
    linkedinHeadline: varchar("linkedin_headline", { length: 500 }),
    linkedinLocation: varchar("linkedin_location", { length: 200 }),
    linkedinProfileImageUrl: text("linkedin_profile_image_url"),
    linkedinProfileImageAllowed: boolean("linkedin_profile_image_allowed").default(false).notNull(),
    currentTitle: varchar("current_title", { length: 200 }),
    currentCompanyName: varchar("current_company_name", { length: 200 }),
    currentCompanyLinkedinUrl: text("current_company_linkedin_url"),
    currentCompanyDomain: varchar("current_company_domain", { length: 200 }),
    currentCompanyStartDate: date("current_company_start_date"),
    experienceHistoryJson: json("experience_history_json"),
    educationHistoryJson: json("education_history_json"),
    skillsJson: json("skills_json"),
    summaryAbout: text("summary_about"),
    industry: varchar("industry", { length: 120 }),
    languagesJson: json("languages_json"),
    /** exact_match | high_confidence | possible_match | manual | created_new */
    linkedinMatchStatus: varchar("linkedin_match_status", { length: 24 }).default("manual").notNull(),
    linkedinConnectionDegree: varchar("linkedin_connection_degree", { length: 16 }),
    /** pending | enriched | partially_enriched | failed | no_match | blocked_by_policy | source_unavailable | vendor_error | needs_review */
    linkedinDataStatus: varchar("linkedin_data_status", { length: 24 }).default("pending").notNull(),
    /** unipile_linkedin_profile | unipile_sales_navigator | crm_import | user_uploaded_url | manual_user_entry | licensed_enrichment_provider */
    linkedinSourceType: varchar("linkedin_source_type", { length: 40 }).default("unipile_linkedin_profile").notNull(),
    linkedinSourceVendor: varchar("linkedin_source_vendor", { length: 32 }).default("unipile").notNull(),
    linkedinSourceAccountId: varchar("linkedin_source_account_id", { length: 200 }),
    linkedinLastRetrievedAt: timestamp("linkedin_last_retrieved_at"),
    linkedinLastCheckedAt: timestamp("linkedin_last_checked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byProspect: uniqueIndex("uq_ple_ws_prospect").on(t.workspaceId, t.prospectId),
    byUrl: index("ix_ple_ws_url").on(t.workspaceId, t.linkedinProfileIdentifier),
  }),
);
export type ProspectLinkedinEnrichment = typeof prospectLinkedinEnrichments.$inferSelect;

/** Point-in-time snapshot of the normalized profile, for daily change diffing. */
export const prospectLinkedinFieldSnapshots = mysqlTable(
  "prospect_linkedin_field_snapshots",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    prospectId: int("prospect_id").notNull(),
    enrichmentId: int("enrichment_id").notNull(),
    snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
    snapshotJson: json("snapshot_json").notNull(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
  },
  (t) => ({
    byProspect: index("ix_plfs_ws_prospect").on(t.workspaceId, t.prospectId),
  }),
);
export type ProspectLinkedinFieldSnapshot = typeof prospectLinkedinFieldSnapshots.$inferSelect;

/** A single detected field change (the source of the compact UI indicators). */
export const prospectLinkedinFieldChanges = mysqlTable(
  "prospect_linkedin_field_changes",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    prospectId: int("prospect_id").notNull(),
    enrichmentId: int("enrichment_id").notNull(),
    fieldName: varchar("field_name", { length: 64 }).notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    oldValueHash: varchar("old_value_hash", { length: 64 }),
    newValueHash: varchar("new_value_hash", { length: 64 }),
    /** title_changed | company_changed | location_changed | headline_changed | new_profile_photo | … */
    changeType: varchar("change_type", { length: 40 }).notNull(),
    sourceVendor: varchar("source_vendor", { length: 32 }).default("unipile").notNull(),
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    confidence: decimal("confidence", { precision: 5, scale: 2 }),
    detectedAt: timestamp("detected_at").defaultNow().notNull(),
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedByUserId: int("acknowledged_by_user_id"),
    /** high | medium | low | normal */
    displayPriority: varchar("display_priority", { length: 12 }).default("normal").notNull(),
    isVisible: boolean("is_visible").default(true).notNull(),
  },
  (t) => ({
    byProspect: index("ix_plfc_ws_prospect_detected").on(t.workspaceId, t.prospectId, t.detectedAt),
    byVisible: index("ix_plfc_ws_visible_ack").on(t.workspaceId, t.isVisible, t.acknowledgedAt),
  }),
);
export type ProspectLinkedinFieldChange = typeof prospectLinkedinFieldChanges.$inferSelect;

/** One run of the daily LinkedIn change-check job (per workspace). */
export const linkedinDailyCheckJobs = mysqlTable(
  "linkedin_daily_check_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    /** pending | running | completed | failed */
    status: varchar("status", { length: 16 }).default("pending").notNull(),
    checkedCount: int("checked_count").default(0).notNull(),
    changedCount: int("changed_count").default(0).notNull(),
    failedCount: int("failed_count").default(0).notNull(),
    /** manual | scheduled */
    trigger: varchar("trigger", { length: 16 }).default("scheduled").notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_ldcj_ws").on(t.workspaceId),
  }),
);
export type LinkedinDailyCheckJob = typeof linkedinDailyCheckJobs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   One-click LinkedIn enrichment jobs (migration 0096)

   Prospect-oriented job (NOT URL-upload). The user selects prospects (or "all
   in a list") and clicks Enrich; the orchestrator resolves a lookup strategy
   per prospect (existing URL → name/company lookup → unavailable), retrieves
   via Unipile, auto-matches against the INTENDED prospect, applies, and
   schedules daily monitoring. The URL-upload batch tables stay for the
   advanced/admin import utility.
   ────────────────────────────────────────────────────────────────────────── */

/** One Enrich action (single, bulk, or whole-list). */
export const linkedinEnrichmentJobs = mysqlTable(
  "linkedin_enrichment_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    triggeredByUserId: int("triggered_by_user_id").notNull(),
    /** people_bulk_action | people_row_action | open_profile_action | full_profile_action | list_bulk_action | list_enrich_all | account_contacts_action | daily_monitoring | manual_admin_run */
    triggerType: varchar("trigger_type", { length: 32 }).notNull(),
    /** queued | running | completed | failed */
    status: varchar("status", { length: 16 }).default("queued").notNull(),
    totalProspects: int("total_prospects").default(0).notNull(),
    eligibleCount: int("eligible_count").default(0).notNull(),
    enrichedCount: int("enriched_count").default(0).notNull(),
    skippedCount: int("skipped_count").default(0).notNull(),
    failedCount: int("failed_count").default(0).notNull(),
    needsReviewCount: int("needs_review_count").default(0).notNull(),
    conflictCount: int("conflict_count").default(0).notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    byWs: index("ix_lej_ws").on(t.workspaceId),
  }),
);
export type LinkedinEnrichmentJob = typeof linkedinEnrichmentJobs.$inferSelect;

/** Per-prospect result within an Enrich job. */
export const linkedinEnrichmentJobItems = mysqlTable(
  "linkedin_enrichment_job_items",
  {
    id: int("id").autoincrement().primaryKey(),
    jobId: int("job_id").notNull(),
    workspaceId: int("workspaceId").notNull(),
    prospectId: int("prospect_id").notNull(),
    /** existing_prospect_linkedin_url | crm_imported_linkedin_url | prior_enrichment_linkedin_url | enrichment_provider_linkedin_url | unipile_name_company_lookup | unavailable */
    linkedinLookupStrategy: varchar("linkedin_lookup_strategy", { length: 40 }),
    linkedinUrlUsed: text("linkedin_url_used"),
    /** exact_match | high_confidence | possible_match | no_match | conflict */
    matchStatus: varchar("match_status", { length: 24 }),
    matchScore: int("match_score"),
    /** pending | skipped | retrieving | matched | enriched | needs_review | conflict | failed | blocked_by_policy | unavailable */
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byJob: index("ix_leji_job").on(t.jobId),
    byProspect: index("ix_leji_ws_prospect").on(t.workspaceId, t.prospectId),
  }),
);
export type LinkedinEnrichmentJobItem = typeof linkedinEnrichmentJobItems.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Scoring system — Velocity Priority Score (migration 0097)

   Apollo-style, explainable, configurable fit + priority scoring. Scored
   objects map to existing tables: object_type "person" → prospects/contacts,
   "company" → accounts. score_models + criteria define configurable fit models
   (person / company); the four remaining priority components (intent,
   engagement, data quality, sequence readiness) are computed by built-in
   calculators. The Velocity Priority Score blends all six.
   ────────────────────────────────────────────────────────────────────────── */

export const scoreModels = mysqlTable(
  "score_models",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    objectType: mysqlEnum("object_type", ["person", "company"]).notNull(),
    modelType: mysqlEnum("model_type", ["auto", "custom"]).notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    status: mysqlEnum("status", ["draft", "active", "archived"]).default("draft").notNull(),
    impactMode: mysqlEnum("impact_mode", ["label", "numeric"]).default("label").notNull(),
    excellentMin: int("excellent_min").default(80).notNull(),
    goodMin: int("good_min").default(60).notNull(),
    fairMin: int("fair_min").default(35).notNull(),
    notFitMax: int("not_fit_max").default(34).notNull(),
    createdByUserId: int("created_by_user_id").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    archivedAt: timestamp("archived_at"),
  },
  (t) => ({
    byWs: index("ix_sm_ws").on(t.workspaceId, t.objectType, t.isPrimary),
  }),
);
export type ScoreModel = typeof scoreModels.$inferSelect;

export const scoreCriteriaGroups = mysqlTable(
  "score_criteria_groups",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    scoreModelId: int("score_model_id").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    description: text("description"),
    maxPoints: int("max_points").notNull(),
    weight: decimal("weight", { precision: 6, scale: 2 }),
    categoryKey: varchar("category_key", { length: 48 }),
    orderIndex: int("order_index").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byModel: index("ix_scg_model").on(t.workspaceId, t.scoreModelId),
  }),
);
export type ScoreCriteriaGroup = typeof scoreCriteriaGroups.$inferSelect;

export const scoreCriteria = mysqlTable(
  "score_criteria",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    scoreModelId: int("score_model_id").notNull(),
    groupId: int("group_id").notNull(),
    fieldName: varchar("field_name", { length: 80 }).notNull(),
    operator: varchar("operator", { length: 32 }).notNull(),
    valueJson: json("value_json").notNull(),
    points: int("points").notNull(),
    impactLabel: varchar("impact_label", { length: 32 }),
    criterionType: mysqlEnum("criterion_type", ["stackable", "mutually_exclusive", "negative", "disqualifier"]).notNull(),
    categoryKey: varchar("category_key", { length: 48 }),
    isNegative: boolean("is_negative").default(false).notNull(),
    isDisqualifier: boolean("is_disqualifier").default(false).notNull(),
    explanationTemplate: varchar("explanation_template", { length: 400 }),
    orderIndex: int("order_index").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byModel: index("ix_sc_model").on(t.workspaceId, t.scoreModelId),
    byGroup: index("ix_sc_group").on(t.groupId),
  }),
);
export type ScoreCriterion = typeof scoreCriteria.$inferSelect;

export const scoreResults = mysqlTable(
  "score_results",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    scoreModelId: int("score_model_id").notNull(),
    objectType: mysqlEnum("object_type", ["person", "company"]).notNull(),
    objectId: int("object_id").notNull(),
    rawScore: int("raw_score").notNull(),
    maxPossibleScore: int("max_possible_score").notNull(),
    normalizedScore: decimal("normalized_score", { precision: 6, scale: 2 }).notNull(),
    rating: mysqlEnum("rating", ["excellent", "good", "fair", "not_a_fit"]).notNull(),
    isDisqualified: boolean("is_disqualified").default(false).notNull(),
    disqualificationReasons: json("disqualification_reasons"),
    calculatedAt: timestamp("calculated_at").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("ix_sr_uniq").on(t.scoreModelId, t.objectType, t.objectId),
    byObject: index("ix_sr_object").on(t.workspaceId, t.objectType, t.objectId),
    byModelScore: index("ix_sr_model_score").on(t.workspaceId, t.scoreModelId, t.normalizedScore),
    byRating: index("ix_sr_rating").on(t.workspaceId, t.rating),
  }),
);
export type ScoreResult = typeof scoreResults.$inferSelect;

export const scoreResultBreakdowns = mysqlTable(
  "score_result_breakdowns",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    scoreResultId: int("score_result_id").notNull(),
    criterionId: int("criterion_id"),
    groupName: varchar("group_name", { length: 160 }).notNull(),
    fieldName: varchar("field_name", { length: 80 }).notNull(),
    matched: boolean("matched").notNull(),
    pointsAwarded: int("points_awarded").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    explanation: varchar("explanation", { length: 400 }).notNull(),
    oldValue: varchar("old_value", { length: 255 }),
    currentValue: varchar("current_value", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byResult: index("ix_srb_result").on(t.scoreResultId),
  }),
);
export type ScoreResultBreakdown = typeof scoreResultBreakdowns.$inferSelect;

export const scoreHistory = mysqlTable(
  "score_history",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    scoreModelId: int("score_model_id").notNull(),
    objectType: mysqlEnum("object_type", ["person", "company"]).notNull(),
    objectId: int("object_id").notNull(),
    previousScore: decimal("previous_score", { precision: 6, scale: 2 }),
    newScore: decimal("new_score", { precision: 6, scale: 2 }).notNull(),
    previousRating: varchar("previous_rating", { length: 16 }),
    newRating: varchar("new_rating", { length: 16 }).notNull(),
    changeReason: varchar("change_reason", { length: 200 }),
    changedAt: timestamp("changed_at").defaultNow().notNull(),
  },
  (t) => ({
    byObject: index("ix_sh_object").on(t.workspaceId, t.objectType, t.objectId, t.changedAt),
  }),
);
export type ScoreHistoryRow = typeof scoreHistory.$inferSelect;

export const priorityScoreResults = mysqlTable(
  "priority_score_results",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    objectType: mysqlEnum("object_type", ["person", "company"]).notNull(),
    objectId: int("object_id").notNull(),
    personFitScore: decimal("person_fit_score", { precision: 6, scale: 2 }),
    companyFitScore: decimal("company_fit_score", { precision: 6, scale: 2 }),
    intentScore: decimal("intent_score", { precision: 6, scale: 2 }),
    engagementScore: decimal("engagement_score", { precision: 6, scale: 2 }),
    dataQualityScore: decimal("data_quality_score", { precision: 6, scale: 2 }),
    sequenceReadinessScore: decimal("sequence_readiness_score", { precision: 6, scale: 2 }),
    priorityScore: decimal("priority_score", { precision: 6, scale: 2 }).notNull(),
    priorityRating: varchar("priority_rating", { length: 16 }).notNull(),
    calculatedAt: timestamp("calculated_at").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("ix_psr_uniq").on(t.objectType, t.objectId, t.workspaceId),
    byPriority: index("ix_psr_priority").on(t.workspaceId, t.priorityScore),
  }),
);
export type PriorityScoreResult = typeof priorityScoreResults.$inferSelect;

export const scoreRecalculationJobs = mysqlTable(
  "score_recalculation_jobs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    scoreModelId: int("score_model_id"),
    jobType: varchar("job_type", { length: 32 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    totalRecords: int("total_records").default(0).notNull(),
    processedRecords: int("processed_records").default(0).notNull(),
    failedRecords: int("failed_records").default(0).notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byStatus: index("ix_srj_status").on(t.workspaceId, t.status),
  }),
);
export type ScoreRecalculationJob = typeof scoreRecalculationJobs.$inferSelect;

/* ──────────────────────────────────────────────────────────────────────────
   Company / Account system (migration 0098)

   Two-layer model: `global_organizations` is the shared company-identity layer;
   the existing `accounts` table is the workspace-account layer (extended above
   with global_organization_id + firmographic/logo/stage columns). Prospects and
   contacts auto-link to accounts + global orgs via CompanyAssociationService.
   ────────────────────────────────────────────────────────────────────────── */

export const globalOrganizations = mysqlTable(
  "global_organizations",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 200 }).notNull(),
    domain: varchar("domain", { length: 200 }),
    normalizedDomain: varchar("normalized_domain", { length: 200 }),
    websiteUrl: text("website_url"),
    linkedinCompanyUrl: text("linkedin_company_url"),
    industry: varchar("industry", { length: 80 }),
    subIndustry: varchar("sub_industry", { length: 80 }),
    employeeCount: int("employee_count"),
    employeeCountRange: varchar("employee_count_range", { length: 40 }),
    revenue: decimal("revenue", { precision: 16, scale: 2 }),
    revenueRange: varchar("revenue_range", { length: 40 }),
    description: text("description"),
    headquartersCity: varchar("headquarters_city", { length: 80 }),
    headquartersState: varchar("headquarters_state", { length: 80 }),
    headquartersCountry: varchar("headquarters_country", { length: 80 }),
    companyPhone: varchar("company_phone", { length: 40 }),
    foundedYear: int("founded_year"),
    logoUrl: text("logo_url"),
    logoSourceType: varchar("logo_source_type", { length: 32 }),
    logoStatus: varchar("logo_status", { length: 24 }).default("unknown").notNull(),
    dataStatus: varchar("data_status", { length: 16 }).default("partial").notNull(),
    lastEnrichedAt: timestamp("last_enriched_at"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byNormDomain: index("ix_go_norm_domain").on(t.normalizedDomain),
    byNormName: index("ix_go_norm_name").on(t.normalizedName),
  }),
);
export type GlobalOrganization = typeof globalOrganizations.$inferSelect;

export const contactAccountLinks = mysqlTable(
  "contact_account_links",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    /** Person side — a prospect OR a contact (personType distinguishes). */
    personType: varchar("person_type", { length: 12 }).notNull(), // prospect|contact
    personId: int("person_id").notNull(),
    accountId: int("account_id").notNull(),
    globalOrganizationId: int("global_organization_id"),
    relationshipType: varchar("relationship_type", { length: 24 }).notNull(),
    titleAtCompany: varchar("title_at_company", { length: 200 }),
    isCurrent: boolean("is_current").default(true).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    confidence: decimal("confidence", { precision: 6, scale: 2 }),
    linkedAt: timestamp("linked_at").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byPerson: index("ix_cal_person").on(t.workspaceId, t.personType, t.personId),
    byAccount: index("ix_cal_account").on(t.workspaceId, t.accountId),
  }),
);
export type ContactAccountLink = typeof contactAccountLinks.$inferSelect;

export const organizationDomains = mysqlTable(
  "organization_domains",
  {
    id: int("id").autoincrement().primaryKey(),
    globalOrganizationId: int("global_organization_id").notNull(),
    domain: varchar("domain", { length: 200 }).notNull(),
    normalizedDomain: varchar("normalized_domain", { length: 200 }).notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byNorm: index("ix_od_norm").on(t.normalizedDomain),
    byOrg: index("ix_od_org").on(t.globalOrganizationId),
  }),
);
export type OrganizationDomain = typeof organizationDomains.$inferSelect;

export const accountDomains = mysqlTable(
  "account_domains",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("account_id").notNull(),
    domain: varchar("domain", { length: 200 }).notNull(),
    normalizedDomain: varchar("normalized_domain", { length: 200 }).notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byNorm: index("ix_ad_norm").on(t.workspaceId, t.normalizedDomain),
    byAccount: index("ix_ad_account").on(t.accountId),
  }),
);
export type AccountDomain = typeof accountDomains.$inferSelect;

export const organizationLocations = mysqlTable(
  "organization_locations",
  {
    id: int("id").autoincrement().primaryKey(),
    globalOrganizationId: int("global_organization_id").notNull(),
    locationType: varchar("location_type", { length: 24 }),
    city: varchar("city", { length: 80 }),
    state: varchar("state", { length: 80 }),
    country: varchar("country", { length: 80 }),
    addressRaw: text("address_raw"),
    isHeadquarters: boolean("is_headquarters").default(false).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byOrg: index("ix_ol_org").on(t.globalOrganizationId) }),
);
export type OrganizationLocation = typeof organizationLocations.$inferSelect;

export const organizationTechnologies = mysqlTable(
  "organization_technologies",
  {
    id: int("id").autoincrement().primaryKey(),
    globalOrganizationId: int("global_organization_id").notNull(),
    technologyName: varchar("technology_name", { length: 120 }).notNull(),
    technologyCategory: varchar("technology_category", { length: 80 }),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    detectedAt: timestamp("detected_at"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byOrg: index("ix_ot_org").on(t.globalOrganizationId) }),
);
export type OrganizationTechnology = typeof organizationTechnologies.$inferSelect;

export const organizationFundingEvents = mysqlTable(
  "organization_funding_events",
  {
    id: int("id").autoincrement().primaryKey(),
    globalOrganizationId: int("global_organization_id").notNull(),
    fundingType: varchar("funding_type", { length: 48 }),
    amount: decimal("amount", { precision: 18, scale: 2 }),
    currency: varchar("currency", { length: 8 }),
    announcedAt: date("announced_at"),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({ byOrg: index("ix_ofe_org").on(t.globalOrganizationId) }),
);
export type OrganizationFundingEvent = typeof organizationFundingEvents.$inferSelect;

export const organizationEnrichmentEvents = mysqlTable(
  "organization_enrichment_events",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    accountId: int("account_id"),
    globalOrganizationId: int("global_organization_id"),
    sourceVendor: varchar("source_vendor", { length: 48 }).notNull(),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    fieldsUpdated: json("fields_updated"),
    rawSummary: json("raw_summary"),
    creditsUsed: decimal("credits_used", { precision: 10, scale: 2 }).default("0"),
    enrichedByUserId: int("enriched_by_user_id"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    byAccount: index("ix_oee_account").on(t.workspaceId, t.accountId),
  }),
);
export type OrganizationEnrichmentEvent = typeof organizationEnrichmentEvents.$inferSelect;

export const companyLogoAssets = mysqlTable(
  "company_logo_assets",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId"),
    globalOrganizationId: int("global_organization_id"),
    accountId: int("account_id"),
    logoUrl: text("logo_url"),
    sourceType: varchar("source_type", { length: 32 }).notNull(),
    sourceUrl: text("source_url"),
    status: varchar("status", { length: 24 }).notNull(),
    lastVerifiedAt: timestamp("last_verified_at"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    byAccount: index("ix_cla_account").on(t.accountId),
    byOrg: index("ix_cla_org").on(t.globalOrganizationId),
  }),
);
export type CompanyLogoAsset = typeof companyLogoAssets.$inferSelect;
