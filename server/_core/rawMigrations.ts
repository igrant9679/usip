/**
 * Raw-SQL migration runner.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Drizzle journal (drizzle/meta/_journal.json) was frozen at migration
 * 0047. Several newer SQL files (0048–0053) were committed without matching
 * journal/snapshot entries, so `drizzle-kit migrate` silently skipped them on
 * production. This broke Tour Builder (tours.pageKey missing), Guided Tours,
 * and parts of the Help Center.
 *
 * APPROACH
 * --------
 * Rather than reading SQL files from the filesystem at runtime (which is
 * fragile because the CWD on Railway may not contain the drizzle/ directory),
 * the critical SQL is embedded here as TypeScript string constants. They are
 * bundled directly into dist/index.js and are always available.
 *
 * HOW IT RUNS
 * -----------
 * Call runRawMigrations() as a fire-and-forget task AFTER server.listen().
 * Never await it at startup — some DDL (ALTER TABLE on large tables) can take
 * seconds to minutes and must not block the healthcheck.
 *
 * The runner is idempotent: it tracks applied migrations in a
 * __manus_migrations__ table and skips already-applied ones.
 */
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const TRACKING_TABLE = "__manus_migrations__";

// MySQL error codes treated as "already applied" — silently skip.
// 1050: ER_TABLE_EXISTS_ERROR
// 1060: ER_DUP_FIELDNAME (column already exists)
// 1061: ER_DUP_KEYNAME   (index already exists)
// 1091: ER_CANT_DROP_FIELD_OR_KEY
// 1146: ER_NO_SUCH_TABLE
// 1826: ER_FK_DUP_NAME
const TOLERATED_ERRNOS = new Set([1050, 1060, 1061, 1091, 1146, 1826]);

// Hard cap: if the entire run takes longer than this, abort.
const TOTAL_TIMEOUT_MS = 180_000; // 3 minutes

// ---------------------------------------------------------------------------
// Embedded SQL migrations (in application order)
// ---------------------------------------------------------------------------

const MIGRATIONS: Array<{ name: string; statements: string[] }> = [
  // ── 0048: Clodura prospect tables ─────────────────────────────────────────
  {
    name: "0048_clodura_prospects.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`prospects\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`clodura_person_id\` varchar(64) UNIQUE,
        \`clodura_org_id\` varchar(64),
        \`clodura_synced_at\` timestamp,
        \`firstName\` varchar(80) NOT NULL,
        \`lastName\` varchar(80) NOT NULL,
        \`title\` varchar(120),
        \`seniority\` varchar(64),
        \`functional_area\` varchar(64),
        \`linkedin_url\` text,
        \`email\` varchar(320),
        \`phone\` varchar(40),
        \`city\` varchar(80),
        \`state\` varchar(80),
        \`country\` varchar(80),
        \`company\` varchar(200),
        \`company_domain\` varchar(200),
        \`industry\` varchar(80),
        \`email_status\` varchar(20),
        \`email_revealed_at\` timestamp,
        \`phone_revealed_at\` timestamp,
        \`linked_contact_id\` int,
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`prospects_id\` PRIMARY KEY(\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      // CREATE INDEX IF NOT EXISTS is not supported on MySQL < 8.0.3 — use plain, tolerate errno 1061.
      `CREATE INDEX \`ix_pro_ws\` ON \`prospects\` (\`workspaceId\`)`,
      // Plain ADD COLUMN — IF NOT EXISTS not supported on MySQL < 8.0.3. errno 1060 is tolerated.
      `ALTER TABLE \`contacts\` ADD COLUMN \`source_prospect_id\` int`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`clodura_person_id\` varchar(64)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`clodura_org_id\` varchar(64)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`functional_area\` varchar(64)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`industry\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_domain\` varchar(200)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_employee_size\` varchar(40)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_revenue\` varchar(40)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_founded_year\` int`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_phone\` varchar(40)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_city\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_state\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`company_country\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`enriched_at\` timestamp`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`enrichment_status\` varchar(20)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`enrichment_confidence\` varchar(20)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`manually_edited_fields\` json DEFAULT ('[]')`,
    ],
  },

  // ── 0049: Opportunity suggested stage ─────────────────────────────────────
  {
    name: "0049_opp_suggested_stage.sql",
    statements: [
      // Plain ADD COLUMN — IF NOT EXISTS not supported on MySQL < 8.0.3. errno 1060 is tolerated.
      `ALTER TABLE \`opportunities\` ADD COLUMN \`suggestedStage\` varchar(80)`,
      `ALTER TABLE \`opportunities\` ADD COLUMN \`suggestedStageReason\` text`,
      `ALTER TABLE \`opportunities\` ADD COLUMN \`suggestedStageAt\` timestamp`,
    ],
  },

  // ── 0050: AI features columns ─────────────────────────────────────────────
  {
    name: "0050_ai_features.sql",
    statements: [
      // Plain ADD COLUMN — IF NOT EXISTS not supported on MySQL < 8.0.3. errno 1060 is tolerated.
      `ALTER TABLE \`workspaces\` ADD COLUMN \`aiEnabled\` tinyint(1) NOT NULL DEFAULT 1`,
      `ALTER TABLE \`workspaces\` ADD COLUMN \`aiModel\` varchar(80)`,
      `ALTER TABLE \`workspaces\` ADD COLUMN \`aiProvider\` varchar(40)`,
      `ALTER TABLE \`workspaces\` ADD COLUMN \`aiApiKey\` varchar(500)`,
      `ALTER TABLE \`workspaces\` ADD COLUMN \`aiSystemPrompt\` text`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`aiSummary\` text`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`aiSummarizedAt\` timestamp`,
      `ALTER TABLE \`opportunities\` ADD COLUMN \`aiInsight\` text`,
    ],
  },

  // ── 0051: Help Center + Tours tables ──────────────────────────────────────
  {
    name: "0051_help_and_tours.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`help_categories\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`name\` varchar(120) NOT NULL,
        \`slug\` varchar(120) NOT NULL,
        \`icon\` varchar(80),
        \`sortOrder\` int NOT NULL DEFAULT 0,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`uq_hc_ws_slug\` (\`workspaceId\`, \`slug\`),
        INDEX \`ix_hc_ws\` (\`workspaceId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`help_articles\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`categoryId\` int,
        \`title\` varchar(300) NOT NULL,
        \`slug\` varchar(300) NOT NULL,
        \`body\` longtext NOT NULL,
        \`status\` enum('draft','published') NOT NULL DEFAULT 'draft',
        \`tags\` json,
        \`pageKey\` varchar(120),
        \`viewCount\` int NOT NULL DEFAULT 0,
        \`helpfulYes\` int NOT NULL DEFAULT 0,
        \`helpfulNo\` int NOT NULL DEFAULT 0,
        \`createdBy\` int,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`uq_ha_ws_slug\` (\`workspaceId\`, \`slug\`),
        INDEX \`ix_ha_ws\` (\`workspaceId\`),
        INDEX \`ix_ha_cat\` (\`categoryId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`help_search_log\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`userId\` int NOT NULL,
        \`query\` varchar(500) NOT NULL,
        \`resultsCount\` int NOT NULL DEFAULT 0,
        \`clickedResultId\` int,
        \`satisfied\` tinyint(1),
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`ix_hsl_ws\` (\`workspaceId\`),
        INDEX \`ix_hsl_user\` (\`userId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`ai_help_conversations\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`userId\` int NOT NULL,
        \`startedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`lastMessageAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`ix_ahc_ws_user\` (\`workspaceId\`, \`userId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`ai_help_messages\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`conversationId\` int NOT NULL,
        \`role\` enum('user','assistant') NOT NULL,
        \`body\` text NOT NULL,
        \`citedArticleIds\` json,
        \`confidence\` decimal(5,2),
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`ix_ahm_conv\` (\`conversationId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`tours\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`name\` varchar(200) NOT NULL,
        \`description\` text,
        \`type\` enum('onboarding','feature','whats_new','custom') NOT NULL DEFAULT 'feature',
        \`roleTags\` json,
        \`estimatedMinutes\` int NOT NULL DEFAULT 3,
        \`prerequisiteTourId\` int,
        \`status\` enum('draft','published') NOT NULL DEFAULT 'draft',
        \`createdBy\` int,
        \`pageKey\` varchar(120),
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`ix_tours_ws\` (\`workspaceId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`tour_steps\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`tourId\` int NOT NULL,
        \`sortOrder\` int NOT NULL DEFAULT 0,
        \`targetSelector\` varchar(500),
        \`targetDataTourId\` varchar(200),
        \`title\` varchar(300) NOT NULL,
        \`bodyMarkdown\` text,
        \`visualTreatment\` enum('spotlight','pulse','arrow','coach') NOT NULL DEFAULT 'spotlight',
        \`advanceCondition\` enum('next_button','element_clicked','form_field_filled','route_changed','custom_event') NOT NULL DEFAULT 'next_button',
        \`advanceConfig\` json,
        \`skipAllowed\` tinyint(1) NOT NULL DEFAULT 1,
        \`backAllowed\` tinyint(1) NOT NULL DEFAULT 1,
        \`branchingRules\` json,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`ix_ts_tour\` (\`tourId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`user_tour_progress\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`userId\` int NOT NULL,
        \`tourId\` int NOT NULL,
        \`status\` enum('not_started','in_progress','completed','skipped') NOT NULL DEFAULT 'not_started',
        \`currentStep\` int NOT NULL DEFAULT 0,
        \`startedAt\` timestamp,
        \`completedAt\` timestamp,
        \`lastResumedAt\` timestamp,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`uq_utp_user_tour\` (\`userId\`, \`tourId\`),
        INDEX \`ix_utp_ws\` (\`workspaceId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`user_learning_preferences\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`userId\` int NOT NULL,
        \`showCoachMascot\` tinyint(1) NOT NULL DEFAULT 1,
        \`showProactiveHints\` tinyint(1) NOT NULL DEFAULT 1,
        \`completedOnboarding\` tinyint(1) NOT NULL DEFAULT 0,
        \`preferredTourSpeed\` enum('slow','normal','fast') NOT NULL DEFAULT 'normal',
        \`dontShowHints\` tinyint(1) NOT NULL DEFAULT 0,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`uq_ulp_ws_user\` (\`workspaceId\`, \`userId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`help_article_feedback\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`articleId\` int NOT NULL,
        \`userId\` int NOT NULL,
        \`helpful\` tinyint(1) NOT NULL,
        \`comment\` text,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`ix_haf_article\` (\`articleId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`tour_achievements\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`userId\` int NOT NULL,
        \`tourId\` int NOT NULL,
        \`badge\` varchar(120),
        \`earnedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        INDEX \`ix_ta_ws_user\` (\`workspaceId\`, \`userId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },

  // ── 0053: Help articles extras ────────────────────────────────────────────
  {
    name: "0053_help_articles_extras.sql",
    statements: [
      // Plain ADD COLUMN — IF NOT EXISTS not supported on MySQL < 8.0.3. errno 1060 is tolerated.
      `ALTER TABLE \`help_articles\` ADD COLUMN \`readingTimeMinutes\` int NULL`,
      `ALTER TABLE \`help_articles\` ADD COLUMN \`pageKeys\` json NULL`,
      // MODIFY COLUMN for enum extension — tolerated if already has 'archived'
      `ALTER TABLE \`help_articles\` MODIFY COLUMN \`status\` enum('draft','published','archived') NOT NULL DEFAULT 'draft'`,
    ],
  },

  // ── 0054: Tour step routeTo column ────────────────────────────────────────
  {
    name: "0054_tour_step_route.sql",
    statements: [
      // Plain ADD COLUMN — IF NOT EXISTS is not supported on MySQL < 8.0.3.
      // errno 1060 (ER_DUP_FIELDNAME) is in TOLERATED_ERRNOS so re-runs are safe.
      `ALTER TABLE \`tour_steps\` ADD COLUMN \`routeTo\` varchar(200) NULL`,
    ],
  },

  // ── 0055: Mindmaps ────────────────────────────────────────────────────────
  {
    name: "0055_mindmaps.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`mindmaps\` (
        \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`workspaceId\` int NOT NULL,
        \`name\` varchar(240) NOT NULL,
        \`description\` text NULL,
        \`createdByUserId\` int NOT NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX \`ix_mindmap_ws\` (\`workspaceId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`mindmap_nodes\` (
        \`id\` varchar(64) NOT NULL PRIMARY KEY,
        \`mindmapId\` int NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`type\` enum('root','topic','subtopic','task','note','idea') NOT NULL DEFAULT 'topic',
        \`label\` varchar(240) NOT NULL,
        \`notes\` text NULL,
        \`posX\` int NOT NULL DEFAULT 0,
        \`posY\` int NOT NULL DEFAULT 0,
        \`color\` varchar(30) NULL,
        \`parentId\` varchar(64) NULL,
        \`linkedEntityType\` varchar(30) NULL,
        \`linkedEntityId\` int NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX \`ix_mmnode_map\` (\`mindmapId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`mindmap_edges\` (
        \`id\` varchar(64) NOT NULL PRIMARY KEY,
        \`mindmapId\` int NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`source\` varchar(64) NOT NULL,
        \`target\` varchar(64) NOT NULL,
        \`label\` varchar(120) NULL,
        INDEX \`ix_mmedge_map\` (\`mindmapId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },

  // ── 0056: BYOK AI provider credentials ─────────────────────────────────────
  // Plain ADD COLUMNs; errno 1060 (ER_DUP_FIELDNAME) is tolerated for re-runs.
  // API key columns hold AES-256-GCM ciphertext — never raw keys.
  {
    name: "0056_byok_ai_credentials.sql",
    statements: [
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`anthropicApiKeyEnc\` text NULL`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`openaiApiKeyEnc\` text NULL`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`geminiApiKeyEnc\` text NULL`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`anthropicModel\` varchar(128) NULL`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`openaiModel\` varchar(128) NULL`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`geminiModel\` varchar(128) NULL`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`aiDefaultProvider\` varchar(32) NULL`,
    ],
  },

  // ── 0057: Unipile bridge column on sending_accounts + calendar_accounts ───
  // Plain ADD COLUMN unipileAccountId — errno 1060 (ER_DUP_FIELDNAME) is
  // tolerated for re-runs. The previous iteration of this migration also
  // ran MODIFY COLUMN to widen the provider enum with 'unipile_microsoft',
  // but that triggered MySQL strict-mode errno 1265 "Data truncated for
  // column 'provider' at row 1" on production data. The architecture was
  // changed instead to reuse existing enum values for bridged rows, so
  // those MODIFYs are no longer needed.
  {
    name: "0057_unipile_bridge.sql",
    statements: [
      `ALTER TABLE \`sending_accounts\` ADD COLUMN \`unipileAccountId\` varchar(64) NULL`,
      `ALTER TABLE \`calendar_accounts\` ADD COLUMN \`unipileAccountId\` varchar(64) NULL`,
    ],
  },
  // ── 0059: Schema drift catch-up ──────────────────────────────────────────
  // The embedded port of 0050_ai_features.sql shipped only a fraction of
  // the original SQL (just aiSummary on contacts + aiInsight on
  // opportunities). The rest — relStrength on contacts, churnRisk on
  // customers, aiNextAction on leads, aiPrice on quotes, aiAutoSend on
  // workspace_settings, and three new AI tables — never made it to prod
  // and silently broke INSERT contacts ("Unknown column 'relStrengthScore'")
  // plus SELECT workspace_settings ("Unknown column 'aiAutoSendEnabled'").
  //
  // Clodura enrichment tables (jobs/history/settings) were also referenced
  // by the schema and worker code but had no migration. Adding them here
  // stops the "Table 'usip.clodura_enrichment_jobs' doesn't exist" loop in
  // the background enrichment worker.
  //
  // All statements use ADD COLUMN / CREATE TABLE IF NOT EXISTS and rely on
  // the runner's TOLERATED_ERRNOS set (1050/1060/1061) so re-runs are safe.
  {
    name: "0059_schema_drift_catchup.sql",
    statements: [
      // contacts: relationship strength (was section 3 of 0050)
      `ALTER TABLE \`contacts\` ADD COLUMN \`relStrengthScore\` int`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`relStrengthLabel\` varchar(16)`,
      `ALTER TABLE \`contacts\` ADD COLUMN \`relStrengthAt\` timestamp NULL`,
      // customers: churn risk (was section 1 of 0050)
      `ALTER TABLE \`customers\` ADD COLUMN \`churnRiskScore\` int`,
      `ALTER TABLE \`customers\` ADD COLUMN \`churnRiskLabel\` varchar(16)`,
      `ALTER TABLE \`customers\` ADD COLUMN \`churnRiskRationale\` text`,
      `ALTER TABLE \`customers\` ADD COLUMN \`churnRiskScoredAt\` timestamp NULL`,
      // leads: next-action suggestion (was section 2 of 0050)
      `ALTER TABLE \`leads\` ADD COLUMN \`aiNextAction\` varchar(40)`,
      `ALTER TABLE \`leads\` ADD COLUMN \`aiNextActionNote\` text`,
      `ALTER TABLE \`leads\` ADD COLUMN \`aiNextActionAt\` timestamp NULL`,
      // quotes: AI pricing (was section 4 of 0050)
      `ALTER TABLE \`quotes\` ADD COLUMN \`aiPriceMin\` decimal(14,2)`,
      `ALTER TABLE \`quotes\` ADD COLUMN \`aiPriceMax\` decimal(14,2)`,
      `ALTER TABLE \`quotes\` ADD COLUMN \`aiDiscountCeil\` decimal(5,2)`,
      `ALTER TABLE \`quotes\` ADD COLUMN \`aiPriceRationale\` text`,
      `ALTER TABLE \`quotes\` ADD COLUMN \`aiPriceScoredAt\` timestamp NULL`,
      // workspace_settings: auto-send toggle (was section 5 of 0050)
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`aiAutoSendEnabled\` boolean NOT NULL DEFAULT FALSE`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`aiAutoSendScoreMin\` int NOT NULL DEFAULT 70`,
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`aiAutoSendConfidenceMin\` int NOT NULL DEFAULT 75`,
      // ai_workflow_suggestions (was section 6 of 0050)
      `CREATE TABLE IF NOT EXISTS \`ai_workflow_suggestions\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`title\` varchar(200) NOT NULL,
        \`description\` text NOT NULL,
        \`triggerType\` varchar(60) NOT NULL,
        \`triggerConfig\` json NOT NULL,
        \`conditions\` json NOT NULL,
        \`actions\` json NOT NULL,
        \`dismissed\` boolean NOT NULL DEFAULT FALSE,
        \`appliedRuleId\` int,
        \`generatedAt\` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT \`ai_workflow_suggestions_id\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_aiws_ws\` ON \`ai_workflow_suggestions\` (\`workspaceId\`)`,
      // forecast_ai_commentary (was section 7 of 0050)
      `CREATE TABLE IF NOT EXISTS \`forecast_ai_commentary\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`periodLabel\` varchar(20) NOT NULL,
        \`commentary\` text NOT NULL,
        \`highlights\` json,
        \`generatedAt\` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT \`forecast_ai_commentary_id\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_fac_ws\` ON \`forecast_ai_commentary\` (\`workspaceId\`, \`periodLabel\`)`,
      // mailbox_ai_triage (was section 8 of 0050)
      `CREATE TABLE IF NOT EXISTS \`mailbox_ai_triage\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`accountId\` int NOT NULL,
        \`threadId\` varchar(255) NOT NULL,
        \`triageLabel\` varchar(20) NOT NULL,
        \`confidence\` int NOT NULL DEFAULT 80,
        \`rationale\` text,
        \`labelledAt\` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT \`mailbox_ai_triage_id\` PRIMARY KEY (\`id\`),
        CONSTRAINT \`uq_triage\` UNIQUE (\`workspaceId\`, \`accountId\`, \`threadId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_triage_ws\` ON \`mailbox_ai_triage\` (\`workspaceId\`, \`accountId\`)`,
      // clodura_enrichment_jobs — referenced by background worker but never
      // had a migration. Worker run failures appear once a minute in logs.
      `CREATE TABLE IF NOT EXISTS \`clodura_enrichment_jobs\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`contact_id\` int NOT NULL,
        \`trigger\` varchar(20) NOT NULL,
        \`identifier_set\` json NOT NULL,
        \`confidence\` varchar(20),
        \`status\` varchar(20) NOT NULL DEFAULT 'pending',
        \`credits_consumed\` int DEFAULT 0,
        \`raw_response\` json,
        \`raw_response_purged_at\` timestamp NULL,
        \`requested_by\` int,
        \`requested_at\` timestamp NOT NULL DEFAULT (now()),
        \`completed_at\` timestamp NULL,
        \`error\` text,
        CONSTRAINT \`clodura_enrichment_jobs_id\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_cej_contact\` ON \`clodura_enrichment_jobs\` (\`contact_id\`)`,
      `CREATE INDEX \`ix_cej_status\` ON \`clodura_enrichment_jobs\` (\`status\`, \`requested_at\`)`,
      `CREATE INDEX \`ix_cej_ws\` ON \`clodura_enrichment_jobs\` (\`workspaceId\`)`,
      // contact_enrichment_history (companion to clodura_enrichment_jobs)
      `CREATE TABLE IF NOT EXISTS \`contact_enrichment_history\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`contact_id\` int NOT NULL,
        \`enrichment_job_id\` int,
        \`field_name\` varchar(80) NOT NULL,
        \`old_value\` text,
        \`new_value\` text,
        \`applied_by\` int,
        \`applied_at\` timestamp NOT NULL DEFAULT (now()),
        \`source\` varchar(40) NOT NULL DEFAULT 'clodura_enrich',
        CONSTRAINT \`contact_enrichment_history_id\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_ceh_contact\` ON \`contact_enrichment_history\` (\`contact_id\`, \`applied_at\`)`,
      `CREATE INDEX \`ix_ceh_ws\` ON \`contact_enrichment_history\` (\`workspaceId\`)`,
      // clodura_enrichment_settings (per-workspace knobs)
      `CREATE TABLE IF NOT EXISTS \`clodura_enrichment_settings\` (
        \`workspaceId\` int NOT NULL,
        \`auto_enrich_on_create\` boolean NOT NULL DEFAULT FALSE,
        \`scheduled_reenrich_enabled\` boolean NOT NULL DEFAULT FALSE,
        \`stale_threshold_days\` int NOT NULL DEFAULT 90,
        \`daily_budget_cap\` int NOT NULL DEFAULT 1500,
        \`updated_by\` int,
        \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`clodura_enrichment_settings_workspaceId\` PRIMARY KEY (\`workspaceId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },

  // ── 0061: Track which sending account dispatched each emailDraft ─────────
  // Needed by the pool-aware send-resolution path: enforcing per-account
  // dailySendLimit requires knowing which account each sent draft used.
  {
    name: "0061_email_drafts_sending_account.sql",
    statements: [
      `ALTER TABLE \`email_drafts\` ADD COLUMN \`sendingAccountId\` int`,
      `CREATE INDEX \`ix_ed_sending_account\` ON \`email_drafts\` (\`sendingAccountId\`)`,
    ],
  },

  // ── 0060: Per-user email signature override ───────────────────────────────
  // Adds users.emailSignature so each rep can override the workspace
  // default (workspaceSettings.emailSignature). Send path prefers the
  // user value when present, otherwise falls back to the workspace value.
  {
    name: "0060_user_email_signature.sql",
    statements: [
      `ALTER TABLE \`users\` ADD COLUMN \`emailSignature\` text`,
    ],
  },

  // ── 0058: Unipile email webhook cache ────────────────────────────────────
  // Local write-through cache populated by POST /api/unipile/mail-webhook.
  // Used by UnipileMailAdapter as a fallback when /emails returns items=0,
  // and as the canonical real-time source going forward.
  {
    name: "0058_unipile_emails_cache.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`unipile_emails_cache\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`unipileAccountId\` varchar(200) NOT NULL,
        \`emailId\` varchar(200) NOT NULL,
        \`threadId\` varchar(200),
        \`providerMessageId\` varchar(500),
        \`subject\` text,
        \`fromName\` varchar(320),
        \`fromEmail\` varchar(320),
        \`toJson\` json,
        \`ccJson\` json,
        \`bccJson\` json,
        \`replyToJson\` json,
        \`bodyHtml\` text,
        \`bodyPlain\` text,
        \`attachmentsJson\` json,
        \`foldersJson\` json,
        \`role\` varchar(40),
        \`hasAttachments\` boolean NOT NULL DEFAULT false,
        \`readDate\` timestamp NULL,
        \`inReplyToId\` varchar(200),
        \`emailDate\` timestamp NULL,
        \`origin\` varchar(20),
        \`trackingId\` varchar(200),
        \`lastEvent\` varchar(30),
        \`rawJson\` json,
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`unipile_emails_cache_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`uq_uec_emailid\` UNIQUE (\`emailId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_uec_account_date\` ON \`unipile_emails_cache\` (\`workspaceId\`, \`unipileAccountId\`, \`emailDate\`)`,
      `CREATE INDEX \`ix_uec_thread\` ON \`unipile_emails_cache\` (\`threadId\`)`,
    ],
  },
];

// ---------------------------------------------------------------------------
// Runner internals
// ---------------------------------------------------------------------------

async function ensureTrackingTable(conn: Connection): Promise<void> {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS \`${TRACKING_TABLE}\` (
       \`name\` VARCHAR(255) NOT NULL PRIMARY KEY,
       \`applied_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
}

async function getAppliedSet(conn: Connection): Promise<Set<string>> {
  type Row = RowDataPacket & { name: string };
  const [rows] = await conn.query<Row[]>(
    `SELECT \`name\` FROM \`${TRACKING_TABLE}\``,
  );
  const applied = new Set<string>();
  for (const r of rows) applied.add(r.name);
  return applied;
}

async function markApplied(conn: Connection, name: string): Promise<void> {
  await conn.query(
    `INSERT IGNORE INTO \`${TRACKING_TABLE}\` (\`name\`) VALUES (?)`,
    [name],
  );
}

async function applyMigration(
  conn: Connection,
  name: string,
  statements: string[],
): Promise<void> {
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    try {
      await conn.query(trimmed);
    } catch (err: unknown) {
      const code = (err as { errno?: number }).errno;
      if (code !== undefined && TOLERATED_ERRNOS.has(code)) {
        continue; // already exists — idempotent
      }
      const msg = (err as Error)?.message ?? String(err);
      throw new Error(`[${name}] ${msg} (errno=${code ?? "n/a"})`);
    }
  }
}

async function _runMigrations(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("[RawMigrations] DATABASE_URL not set — skipping");
    return;
  }

  let conn: Connection | null = null;
  try {
    conn = await mysql.createConnection({
      uri: process.env.DATABASE_URL,
      multipleStatements: false,
      connectTimeout: 15_000,
    });

    // Set session-level DDL lock timeout so any ALTER that can't acquire a
    // metadata lock within 30 s fails fast rather than hanging.
    try {
      await conn.query("SET SESSION lock_wait_timeout = 30");
      await conn.query("SET SESSION innodb_lock_wait_timeout = 30");
    } catch {
      // Non-fatal — some managed MySQL variants don't allow this.
    }

    await ensureTrackingTable(conn);
    const applied = await getAppliedSet(conn);

    let newlyApplied = 0;
    let skipped = 0;

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) {
        skipped++;
        continue;
      }
      try {
        await applyMigration(conn, migration.name, migration.statements);
        await markApplied(conn, migration.name);
        newlyApplied++;
        console.log(`[RawMigrations] applied ${migration.name}`);
      } catch (err) {
        console.error(
          `[RawMigrations] FAILED ${migration.name}:`,
          (err as Error)?.message ?? err,
        );
        // Continue to next migration — one failure shouldn't block others.
      }
    }

    console.log(
      `[RawMigrations] done: ${newlyApplied} newly applied, ${skipped} already applied, ${MIGRATIONS.length} total`,
    );
  } catch (err) {
    console.error(
      "[RawMigrations] runner crashed:",
      (err as Error)?.message ?? err,
    );
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Public entry point. Fire-and-forget — do NOT await at server startup.
 * Call it like: runRawMigrations().catch(e => console.error(e));
 *
 * Wraps execution in a hard total timeout so it can never run forever.
 */
export async function runRawMigrations(): Promise<void> {
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `[RawMigrations] timed out after ${TOTAL_TIMEOUT_MS / 1000}s`,
          ),
        ),
      TOTAL_TIMEOUT_MS,
    ),
  );
  try {
    await Promise.race([_runMigrations(), timeout]);
  } catch (err) {
    console.error(
      "[RawMigrations] aborted:",
      (err as Error)?.message ?? err,
    );
  }
}
