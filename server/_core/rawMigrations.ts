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

  // ── 0062: Schema-drift audit pass — three items missed by earlier ports ──
  // 1. clodura_reveal_jobs (was in 0048 SQL but not ported into rawMigrations).
  //    Inserted into by the Clodura "Reveal email/phone" buttons; without
  //    the table those mutations would 500.
  // 2. clodura_saved_searches (also from 0048, also missed). Used by the
  //    Prospects page's saved-filter chips.
  // 3. opportunity_intelligence.suggestedStage + suggestedStageRationale.
  //    Original 0049 SQL added these to opportunity_intelligence; the
  //    rawMigrations port mistakenly added different-named columns on
  //    `opportunities` instead. Schema.ts references opportunity_intelligence
  //    so any reader of those fields gets undefined.
  {
    name: "0062_drift_audit_pass.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`clodura_reveal_jobs\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`tracking_id\` varchar(128) NOT NULL,
        \`prospect_id\` int NOT NULL,
        \`kind\` varchar(10) NOT NULL,
        \`status\` varchar(20) NOT NULL DEFAULT 'pending',
        \`requested_by\` int,
        \`requested_at\` timestamp NOT NULL DEFAULT (now()),
        \`completed_at\` timestamp NULL,
        \`error\` text,
        CONSTRAINT \`clodura_reveal_jobs_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`uq_crj_tracking\` UNIQUE (\`tracking_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_crj_prospect\` ON \`clodura_reveal_jobs\` (\`prospect_id\`)`,
      `CREATE INDEX \`ix_crj_tracking\` ON \`clodura_reveal_jobs\` (\`tracking_id\`)`,

      `CREATE TABLE IF NOT EXISTS \`clodura_saved_searches\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`user_id\` int NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`name\` varchar(120),
        \`filters\` json NOT NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`clodura_saved_searches_id\` PRIMARY KEY(\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_css_user\` ON \`clodura_saved_searches\` (\`user_id\`, \`workspaceId\`)`,

      `ALTER TABLE \`opportunity_intelligence\` ADD COLUMN \`suggestedStage\` varchar(64)`,
      `ALTER TABLE \`opportunity_intelligence\` ADD COLUMN \`suggestedStageRationale\` text`,
    ],
  },

  // ── 0063: emailDrafts.stepIndex for per-step sequence analytics ──────────
  // Without this we can't reconstruct which sequence step a draft was
  // created for after the enrollment.currentStep advances. Populated by
  // the sequence engine at draft-creation time.
  {
    name: "0063_email_drafts_step_index.sql",
    statements: [
      `ALTER TABLE \`email_drafts\` ADD COLUMN \`stepIndex\` int`,
      `CREATE INDEX \`ix_ed_seq_step\` ON \`email_drafts\` (\`sequenceId\`, \`stepIndex\`)`,
    ],
  },

  // ── 0064: clodura_search_cache table ─────────────────────────────────────
  // Another 0048-era table that wasn't ported into rawMigrations — the
  // Clodura "Search Clodura" panel writes here to memoize query results,
  // and threw "Failed query ... clodura_search_cache" on every search.
  // Composite PK on (cache_key, workspaceId) so the same hashed query
  // in different tenants doesn't collide.
  {
    name: "0064_clodura_search_cache.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`clodura_search_cache\` (
        \`cache_key\` varchar(128) NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`response\` json NOT NULL,
        \`cached_at\` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT \`clodura_search_cache_pk\` PRIMARY KEY (\`cache_key\`, \`workspaceId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_csc_ws_cached\` ON \`clodura_search_cache\` (\`workspaceId\`, \`cached_at\`)`,
    ],
  },

  // ── 0065: prospects enrichment + domain scrape cache ─────────────────────
  // Backs the new contact-info scraper (server/services/scraper). Adds:
  //   - prospects.email_verified_at   — when we last ran Reoon on this row
  //   - prospects.enrichment_data     — full scraper output (emails/phones/
  //                                     socials found + Reoon verifications)
  //   - domain_scrape_cache table     — 30-day memoization of company-site
  //                                     scrapes so popular domains aren't
  //                                     re-fetched per-prospect
  // ALTER TABLE ... ADD COLUMN errors on dup (1060) are in TOLERATED_ERRNOS,
  // so re-runs are safe without explicit IF NOT EXISTS dancing.
  {
    name: "0065_prospects_enrichment.sql",
    statements: [
      `ALTER TABLE \`prospects\` ADD COLUMN \`email_verified_at\` TIMESTAMP NULL`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`enrichment_data\` JSON NULL`,
      `CREATE TABLE IF NOT EXISTS \`domain_scrape_cache\` (
        \`domain\` varchar(253) NOT NULL,
        \`result\` json NOT NULL,
        \`scraped_at\` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT \`domain_scrape_cache_pk\` PRIMARY KEY (\`domain\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_dsc_scraped_at\` ON \`domain_scrape_cache\` (\`scraped_at\`)`,
    ],
  },

  // ── 0066: Google Places budget tracking ─────────────────────────────────
  // Backs the new /find-prospects Google Places search. One budget row per
  // workspace + a per-call audit log. The hard-cap and 80% threshold logic
  // both live in app code (server/services/googlePlaces.ts) — schema just
  // stores the state.
  {
    name: "0066_places_budget.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`places_budget\` (
        \`workspaceId\` int NOT NULL,
        \`monthly_budget_cents\` int NOT NULL DEFAULT 20000,
        \`threshold_pct\` int NOT NULL DEFAULT 80,
        \`enabled\` tinyint(1) NOT NULL DEFAULT 1,
        \`usage_cents\` int NOT NULL DEFAULT 0,
        \`calls_count\` int NOT NULL DEFAULT 0,
        \`period_start\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`threshold_alert_sent_at\` timestamp NULL,
        \`cap_reached_at\` timestamp NULL,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`places_budget_pk\` PRIMARY KEY (\`workspaceId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS \`places_search_log\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`userId\` int NULL,
        \`endpoint\` varchar(64) NOT NULL,
        \`query\` text NULL,
        \`cost_cents\` int NOT NULL,
        \`results_count\` int NULL,
        \`status\` varchar(16) NOT NULL,
        \`error\` text NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT (now()),
        CONSTRAINT \`places_search_log_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_psl_ws\` ON \`places_search_log\` (\`workspaceId\`, \`createdAt\`)`,
    ],
  },

  // ── 0067: LinkedIn lookup audit + rate-limit log ────────────────────────
  // Backs Phase 3 of the prospect scraper (LinkedIn via Unipile). The
  // per-account daily cap is enforced by counting rows for a given
  // unipile_account_id created since UTC midnight — no separate counter.
  {
    name: "0067_linkedin_lookup_log.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`linkedin_lookup_log\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`requested_by_user_id\` int NOT NULL,
        \`unipile_account_id\` varchar(200) NOT NULL,
        \`account_owner_user_id\` int NULL,
        \`target_url\` text NULL,
        \`target_identifier\` varchar(200) NULL,
        \`status\` varchar(16) NOT NULL,
        \`error\` text NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`linkedin_lookup_log_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_lll_acct_day\` ON \`linkedin_lookup_log\` (\`unipile_account_id\`, \`createdAt\`)`,
      `CREATE INDEX \`ix_lll_ws\` ON \`linkedin_lookup_log\` (\`workspaceId\`, \`createdAt\`)`,
    ],
  },

  // ── 0068: LinkedIn per-account daily usage counter ──────────────────────
  // Makes the LinkedIn daily cap concurrency-safe. The cap is enforced by
  // `UPDATE ... SET count = count + 1 WHERE count < cap` (affectedRows
  // decides) instead of COUNT(*)-then-check, which had a TOCTOU window
  // under concurrent batch lookups (real LinkedIn-ban risk). Daily reset
  // is implicit — usage_date is part of the PK.
  {
    name: "0068_linkedin_daily_usage.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`linkedin_daily_usage\` (
        \`unipile_account_id\` varchar(200) NOT NULL,
        \`usage_date\` varchar(10) NOT NULL,
        \`count\` int NOT NULL DEFAULT 0,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`linkedin_daily_usage_pk\` PRIMARY KEY (\`unipile_account_id\`, \`usage_date\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },

  // ── 0069: auto-send to unscored (cold) recipients ───────────────────────
  // Lets a workspace opt into auto-sending sequence drafts to recipients
  // with a NULL relationship-strength / lead score (the cold mass-outreach
  // case — freshly imported contacts are always NULL-scored and nothing
  // computes it server-side). Default FALSE = no behavior change for
  // workspaces that don't opt in. errno 1060 (dup column) is tolerated so
  // re-runs are safe.
  {
    name: "0069_autosend_allow_unscored.sql",
    statements: [
      `ALTER TABLE \`workspace_settings\` ADD COLUMN \`aiAutoSendAllowUnscored\` boolean NOT NULL DEFAULT FALSE`,
    ],
  },

  // ── 0070: sequence canvas tables (nodes + edges) ────────────────────────
  // sequence_nodes / sequence_edges were defined in drizzle/schema.ts and
  // old drizzle-kit SQL (0004/0029) but NEVER ported into rawMigrations,
  // which is what actually migrates prod on boot. So the Sequence Canvas
  // auto-seed insert ("Sequence start" + first email node) failed with
  // "Failed query: insert into `sequence_nodes` ..." on any workspace
  // whose DB was built from rawMigrations only. CREATE IF NOT EXISTS +
  // tolerated dup-errnos make this safe where the tables already exist.
  {
    name: "0070_sequence_canvas.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`sequence_nodes\` (
        \`id\` varchar(64) NOT NULL,
        \`sequenceId\` int NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`type\` enum('start','email','wait','condition','action','goal','linkedin_dm','linkedin_invite') NOT NULL,
        \`positionX\` int NOT NULL DEFAULT 0,
        \`positionY\` int NOT NULL DEFAULT 0,
        \`data\` json NOT NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`sequence_nodes_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_sn_seq\` ON \`sequence_nodes\` (\`sequenceId\`)`,
      `CREATE INDEX \`ix_sn_ws\` ON \`sequence_nodes\` (\`workspaceId\`)`,
      `CREATE TABLE IF NOT EXISTS \`sequence_edges\` (
        \`id\` varchar(64) NOT NULL,
        \`sequenceId\` int NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`source\` varchar(64) NOT NULL,
        \`target\` varchar(64) NOT NULL,
        \`sourceHandle\` varchar(32) NULL,
        \`label\` varchar(64) NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`sequence_edges_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_se_seq\` ON \`sequence_edges\` (\`sequenceId\`)`,
    ],
  },

  // ── 0071: ARE (Autonomous Revenue Engine) tables ────────────────────────
  // The are_* / prospect_* tables were defined in drizzle/schema.ts but were
  // NEVER ported into rawMigrations, which is the authoritative prod migrator
  // on boot. On any DB built from rawMigrations only, EVERY ARE hub tab
  // (Prospects/Scraper/A-B/Signals/Settings/Rejections) and the ARE demo
  // seeder fail with "Table doesn't exist". CREATE TABLE IF NOT EXISTS +
  // tolerated dup-errnos (1050/1061) make this safe where they already exist.
  {
    name: "0071_are_engine_tables.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`are_campaigns\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`name\` varchar(200) NOT NULL,
        \`description\` text NULL,
        \`status\` enum('draft','active','paused','completed') NOT NULL DEFAULT 'draft',
        \`autonomyMode\` enum('full','batch_approval','review_release') NOT NULL DEFAULT 'batch_approval',
        \`icpProfileId\` int NULL,
        \`icpOverrides\` json NULL,
        \`prospectSources\` json NULL,
        \`targetProspectCount\` int NOT NULL DEFAULT 100,
        \`dailySendCap\` int NOT NULL DEFAULT 50,
        \`channelsEnabled\` json NULL,
        \`sequenceTemplate\` varchar(64) NOT NULL DEFAULT 'standard_7step',
        \`goalType\` enum('meeting_booked','reply','opportunity_created') NOT NULL DEFAULT 'reply',
        \`prospectsDiscovered\` int NOT NULL DEFAULT 0,
        \`prospectsEnriched\` int NOT NULL DEFAULT 0,
        \`prospectsApproved\` int NOT NULL DEFAULT 0,
        \`prospectsEnrolled\` int NOT NULL DEFAULT 0,
        \`prospectsContacted\` int NOT NULL DEFAULT 0,
        \`prospectsReplied\` int NOT NULL DEFAULT 0,
        \`meetingsBooked\` int NOT NULL DEFAULT 0,
        \`opportunitiesCreated\` int NOT NULL DEFAULT 0,
        \`ownerUserId\` int NULL,
        \`autoApproveThreshold\` int NULL,
        \`signalToOpportunityEnabled\` tinyint NOT NULL DEFAULT 0,
        \`startedAt\` timestamp NULL,
        \`completedAt\` timestamp NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`are_campaigns_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_arec_ws\` ON \`are_campaigns\` (\`workspaceId\`)`,
      `CREATE INDEX \`ix_arec_status\` ON \`are_campaigns\` (\`workspaceId\`, \`status\`)`,

      `CREATE TABLE IF NOT EXISTS \`prospect_queue\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`campaignId\` int NOT NULL,
        \`sourceType\` enum('internal_contact','internal_lead','google_business','linkedin_company','linkedin_people','web_scrape','news_event','industry_event','apollo','zoominfo','clay','ai_research') NOT NULL,
        \`sourceId\` varchar(256) NULL,
        \`sourceUrl\` text NULL,
        \`firstName\` varchar(80) NULL,
        \`lastName\` varchar(80) NULL,
        \`email\` varchar(320) NULL,
        \`linkedinUrl\` text NULL,
        \`phone\` varchar(40) NULL,
        \`title\` varchar(120) NULL,
        \`companyName\` varchar(200) NULL,
        \`companyDomain\` varchar(200) NULL,
        \`companySize\` varchar(40) NULL,
        \`industry\` varchar(80) NULL,
        \`geography\` varchar(120) NULL,
        \`icpMatchScore\` int NOT NULL DEFAULT 0,
        \`icpMatchBreakdown\` json NULL,
        \`enrichmentStatus\` enum('pending','enriching','complete','failed') NOT NULL DEFAULT 'pending',
        \`enrichedAt\` timestamp NULL,
        \`sequenceStatus\` enum('pending','approved','enrolled','skipped','completed','replied') NOT NULL DEFAULT 'pending',
        \`approvedAt\` timestamp NULL,
        \`approvedByUserId\` int NULL,
        \`rejectedAt\` timestamp NULL,
        \`rejectedByUserId\` int NULL,
        \`rejectionReason\` text NULL,
        \`linkedContactId\` int NULL,
        \`linkedOpportunityId\` int NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`prospect_queue_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_pq_campaign\` ON \`prospect_queue\` (\`campaignId\`)`,
      `CREATE INDEX \`ix_pq_ws\` ON \`prospect_queue\` (\`workspaceId\`)`,
      `CREATE INDEX \`ix_pq_email\` ON \`prospect_queue\` (\`email\`)`,
      `CREATE INDEX \`ix_pq_status\` ON \`prospect_queue\` (\`campaignId\`, \`enrichmentStatus\`)`,

      `CREATE TABLE IF NOT EXISTS \`prospect_intelligence\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`prospectQueueId\` int NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`triggerEvents\` json NULL,
        \`painSignals\` json NULL,
        \`relationshipPaths\` json NULL,
        \`personalisationHooks\` json NULL,
        \`techStack\` json NULL,
        \`recentNews\` json NULL,
        \`industryEvents\` json NULL,
        \`googleBusinessData\` json NULL,
        \`linkedinSummary\` text NULL,
        \`companyOneLiner\` text NULL,
        \`recommendedChannel\` enum('email','linkedin','sms','voice') NOT NULL DEFAULT 'email',
        \`recommendedTiming\` json NULL,
        \`enrichmentConfidence\` int NOT NULL DEFAULT 0,
        \`generatedSequence\` json NULL,
        \`sequenceQualityScore\` int NULL,
        \`sequenceQualityBreakdown\` json NULL,
        \`sequenceRewriteCount\` int NOT NULL DEFAULT 0,
        \`enhancedHook\` text NULL,
        \`signalEnhancedAt\` timestamp NULL,
        \`generatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`prospect_intelligence_pk\` PRIMARY KEY (\`id\`),
        CONSTRAINT \`prospect_intelligence_prospectQueueId_unique\` UNIQUE (\`prospectQueueId\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_pi_prospect\` ON \`prospect_intelligence\` (\`prospectQueueId\`)`,
      `CREATE INDEX \`ix_pi_ws\` ON \`prospect_intelligence\` (\`workspaceId\`)`,

      `CREATE TABLE IF NOT EXISTS \`are_execution_queue\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`campaignId\` int NOT NULL,
        \`prospectQueueId\` int NOT NULL,
        \`stepIndex\` int NOT NULL,
        \`channel\` enum('email','linkedin','sms','voice') NOT NULL,
        \`scheduledAt\` timestamp NOT NULL,
        \`executedAt\` timestamp NULL,
        \`status\` enum('scheduled','sent','failed','skipped','paused') NOT NULL DEFAULT 'scheduled',
        \`messageContent\` json NULL,
        \`externalId\` varchar(256) NULL,
        \`failureReason\` text NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`are_execution_queue_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_aeq_campaign\` ON \`are_execution_queue\` (\`campaignId\`)`,
      `CREATE INDEX \`ix_aeq_prospect\` ON \`are_execution_queue\` (\`prospectQueueId\`)`,
      `CREATE INDEX \`ix_aeq_scheduled\` ON \`are_execution_queue\` (\`workspaceId\`, \`status\`, \`scheduledAt\`)`,

      `CREATE TABLE IF NOT EXISTS \`are_signal_log\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`executionQueueId\` int NULL,
        \`prospectQueueId\` int NOT NULL,
        \`campaignId\` int NOT NULL,
        \`signalType\` enum('email_open','email_click','email_reply','email_bounce','email_unsubscribe','linkedin_accepted','linkedin_reply','sms_reply','sms_unsubscribe','voice_connected_interested','voice_connected_not_interested','voice_voicemail','voice_no_answer','meeting_booked','opportunity_created') NOT NULL,
        \`rawPayload\` json NULL,
        \`sentiment\` enum('positive','neutral','negative','objection') NULL,
        \`sentimentReason\` text NULL,
        \`processedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`actionTaken\` varchar(120) NULL,
        CONSTRAINT \`are_signal_log_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_asl_prospect\` ON \`are_signal_log\` (\`prospectQueueId\`)`,
      `CREATE INDEX \`ix_asl_campaign\` ON \`are_signal_log\` (\`campaignId\`)`,
      `CREATE INDEX \`ix_asl_type\` ON \`are_signal_log\` (\`workspaceId\`, \`signalType\`)`,

      `CREATE TABLE IF NOT EXISTS \`are_ab_variants\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`campaignId\` int NOT NULL,
        \`stepIndex\` int NOT NULL,
        \`variantKey\` varchar(8) NOT NULL,
        \`hookType\` varchar(64) NULL,
        \`subjectLine\` varchar(240) NULL,
        \`bodyPreview\` text NULL,
        \`sentCount\` int NOT NULL DEFAULT 0,
        \`openCount\` int NOT NULL DEFAULT 0,
        \`replyCount\` int NOT NULL DEFAULT 0,
        \`meetingCount\` int NOT NULL DEFAULT 0,
        \`isWinner\` tinyint NOT NULL DEFAULT 0,
        \`promotedAt\` timestamp NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`are_ab_variants_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_aav_campaign\` ON \`are_ab_variants\` (\`campaignId\`)`,
      `CREATE UNIQUE INDEX \`ix_aav_variant\` ON \`are_ab_variants\` (\`campaignId\`, \`stepIndex\`, \`variantKey\`)`,

      `CREATE TABLE IF NOT EXISTS \`are_suppression_list\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`email\` varchar(320) NULL,
        \`linkedinUrl\` text NULL,
        \`companyDomain\` varchar(200) NULL,
        \`reason\` enum('unsubscribe','bounce','competitor','existing_customer','manual','do_not_contact') NOT NULL,
        \`addedByUserId\` int NULL,
        \`addedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`are_suppression_list_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_asupp_ws\` ON \`are_suppression_list\` (\`workspaceId\`)`,
      `CREATE INDEX \`ix_asupp_email\` ON \`are_suppression_list\` (\`workspaceId\`, \`email\`)`,

      `CREATE TABLE IF NOT EXISTS \`prospect_notes\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`prospectQueueId\` int NOT NULL,
        \`userId\` int NOT NULL,
        \`body\` text NOT NULL,
        \`isPinned\` tinyint NOT NULL DEFAULT 0,
        \`category\` varchar(32) NOT NULL DEFAULT 'general',
        \`editedAt\` timestamp NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT \`prospect_notes_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_pn_prospect\` ON \`prospect_notes\` (\`prospectQueueId\`)`,
      `CREATE INDEX \`ix_pn_ws\` ON \`prospect_notes\` (\`workspaceId\`)`,

      `CREATE TABLE IF NOT EXISTS \`are_scrape_jobs\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`campaignId\` int NULL,
        \`sourceType\` enum('google_business','linkedin_company','linkedin_people','web_scrape','news','industry_events') NOT NULL,
        \`query\` text NOT NULL,
        \`status\` enum('pending','running','complete','failed') NOT NULL DEFAULT 'pending',
        \`resultCount\` int NOT NULL DEFAULT 0,
        \`rawResults\` json NULL,
        \`errorMessage\` text NULL,
        \`scrapedAt\` timestamp NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`are_scrape_jobs_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_asj_ws\` ON \`are_scrape_jobs\` (\`workspaceId\`)`,
      `CREATE INDEX \`ix_asj_campaign\` ON \`are_scrape_jobs\` (\`campaignId\`)`,

      `CREATE TABLE IF NOT EXISTS \`reeval_runs\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`workspaceId\` int NOT NULL,
        \`campaignId\` int NOT NULL,
        \`createdByUserId\` int NULL,
        \`thresholdUsed\` int NOT NULL,
        \`processed\` int NOT NULL DEFAULT 0,
        \`requalified\` int NOT NULL DEFAULT 0,
        \`runAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT \`reeval_runs_pk\` PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_rr_campaign\` ON \`reeval_runs\` (\`campaignId\`)`,
      `CREATE INDEX \`ix_rr_ws\` ON \`reeval_runs\` (\`workspaceId\`)`,
    ],
  },

  // ── 0072: Help Center column drift ──────────────────────────────────────
  // schema.ts (the Drizzle source of truth) renamed/added help_articles
  // columns — body→bodyMarkdown, helpfulYes→helpfulCount,
  // helpfulNo→notHelpfulCount, createdBy→authorId, plus new summary +
  // associatedTourId — but the prod table was created by 0051 with the OLD
  // names. Drizzle emits explicit column lists, so every helpCenter.* query
  // and insert threw "Unknown column" and the entire Help Center 500'd.
  // Also: help_categories.slug is NOT NULL in prod but absent from schema.ts,
  // so upsertCategory's insert (which omits slug) failed too. Add the new
  // columns, backfill from the legacy ones, and relax the now-unwritten
  // columns to nullable. errno 1060 (dup column) is tolerated on re-run.
  {
    name: "0072_help_center_column_drift.sql",
    statements: [
      `ALTER TABLE \`help_articles\` ADD COLUMN \`summary\` text NULL`,
      `ALTER TABLE \`help_articles\` ADD COLUMN \`bodyMarkdown\` text NULL`,
      `ALTER TABLE \`help_articles\` ADD COLUMN \`associatedTourId\` int NULL`,
      `ALTER TABLE \`help_articles\` ADD COLUMN \`authorId\` int NULL`,
      `ALTER TABLE \`help_articles\` ADD COLUMN \`helpfulCount\` int NOT NULL DEFAULT 0`,
      `ALTER TABLE \`help_articles\` ADD COLUMN \`notHelpfulCount\` int NOT NULL DEFAULT 0`,
      // Backfill from the legacy columns 0051 created.
      `UPDATE \`help_articles\` SET \`bodyMarkdown\` = \`body\` WHERE \`bodyMarkdown\` IS NULL`,
      `UPDATE \`help_articles\` SET \`authorId\` = \`createdBy\` WHERE \`authorId\` IS NULL`,
      `UPDATE \`help_articles\` SET \`helpfulCount\` = \`helpfulYes\`, \`notHelpfulCount\` = \`helpfulNo\``,
      // `body` is NOT NULL with no default; Drizzle inserts omit it → relax it.
      `ALTER TABLE \`help_articles\` MODIFY COLUMN \`body\` longtext NULL`,
      // help_categories.slug is NOT NULL in prod but not in schema.ts → relax
      // it so Drizzle inserts (which omit slug) succeed.
      `ALTER TABLE \`help_categories\` MODIFY COLUMN \`slug\` varchar(120) NULL`,
    ],
  },

  // ── 0073: personas + ARE engine logs ────────────────────────────────────
  // Adds two new tables introduced together:
  //   personas: reusable target-profile templates (titles/industries/size/
  //             geographies/keywords) that can be applied to any campaign,
  //             find-prospects search, or sequence — replaces re-typing the
  //             same filters into every wizard.
  //   are_engine_logs: per-campaign timeline of every back-end engine action
  //             (enrich, screen, sequence, enroll, dispatch, discovery,
  //             counters, errors). Powers the new Logs tab on the ARE
  //             campaign detail page so operators can see what the engine
  //             actually did on each tick instead of just the counter deltas.
  {
    name: "0073_personas_and_engine_logs.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`personas\` (
         \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
         \`workspaceId\` int NOT NULL,
         \`name\` varchar(120) NOT NULL,
         \`description\` text NULL,
         \`targetTitles\` json NULL,
         \`targetIndustries\` json NULL,
         \`targetGeographies\` json NULL,
         \`employeeMin\` int NULL,
         \`employeeMax\` int NULL,
         \`keywords\` json NULL,
         \`isPreset\` tinyint(1) NOT NULL DEFAULT 0,
         \`createdByUserId\` int NULL,
         \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
         \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_personas_ws\` ON \`personas\` (\`workspaceId\`)`,

      `CREATE TABLE IF NOT EXISTS \`are_engine_logs\` (
         \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
         \`workspaceId\` int NOT NULL,
         \`campaignId\` int NOT NULL,
         \`phase\` varchar(32) NOT NULL,
         \`level\` varchar(8) NOT NULL DEFAULT 'info',
         \`message\` text NOT NULL,
         \`details\` json NULL,
         \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_ael_campaign\` ON \`are_engine_logs\` (\`campaignId\`, \`createdAt\`)`,
      `CREATE INDEX \`ix_ael_ws\` ON \`are_engine_logs\` (\`workspaceId\`, \`createdAt\`)`,
    ],
  },

  // ── 0074: enrichmentError on prospect_queue ──────────────────────────────
  // When enrichment fails we previously only flipped enrichmentStatus to
  // 'failed' and threw — the actual reason vanished into server logs. The
  // Prospects tab then showed an unexplained red 'failed' chip. Add a text
  // column so the failure reason persists with the row and can be surfaced
  // in the UI (tooltip + expandable detail) and used to drive retries.
  {
    name: "0074_prospect_queue_enrichment_error.sql",
    statements: [
      `ALTER TABLE \`prospect_queue\` ADD COLUMN \`enrichmentError\` TEXT NULL`,
    ],
  },

  // ── 0075: per-campaign sequence prompt ────────────────────────────────
  // Lets each campaign tune the system prompt fed to the Sequence Agent.
  // Without this, every campaign across every workspace used the same
  // hard-coded copywriter prompt — fine for generic outreach, useless for
  // a campaign that needs a specific voice (technical, executive, etc.).
  {
    name: "0075_are_campaigns_sequence_prompt.sql",
    statements: [
      `ALTER TABLE \`are_campaigns\` ADD COLUMN \`sequencePrompt\` TEXT NULL`,
    ],
  },

  // ── 0076: campaign-level generated template (cached skeleton) ──────────
  // Top-level architectural change: instead of running a full multi-call
  // LLM generation per prospect, generate a 7-step *skeleton* once per
  // campaign (cached on this column) and personalize cheaply per prospect.
  // Cuts LLM cost ~70% without sacrificing perceived personalization,
  // because we still rewrite the parts a human notices (opener + hooks).
  {
    name: "0076_are_campaigns_generated_template.sql",
    statements: [
      `ALTER TABLE \`are_campaigns\` ADD COLUMN \`generatedTemplate\` JSON NULL`,
      `ALTER TABLE \`are_campaigns\` ADD COLUMN \`generatedTemplateAt\` TIMESTAMP NULL`,
    ],
  },

  // ── 0078: Discovery v2 pipeline (raw_finds, runs, logs, prospects ext) ─
  // Replaces the scattered prospect-search UI with a single guided
  // Person/Account workflow whose every step is traceable. Three new
  // tables + verification fields on prospects:
  //   raw_finds       — every snippet a scraper returned (evidence with
  //                     a source URL the user can click back to).
  //   discovery_runs  — one row per user search (mode, input, counters,
  //                     duration). Powers the new Logs tab.
  //   discovery_logs  — per-step trace within a run, kept separate from
  //                     are_engine_logs (which is campaign-bound).
  //   prospects.*     — confidenceScore + tier + verificationStatus +
  //                     notes + sourceUrls + linkedinUrlVerified +
  //                     lastEnrichedAt + lastDiscoveryRunId so a saved
  //                     prospect always knows where it came from.
  {
    name: "0078_discovery_v2.sql",
    statements: [
      `CREATE TABLE IF NOT EXISTS \`raw_finds\` (
         \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
         \`workspaceId\` int NOT NULL,
         \`runId\` int NOT NULL,
         \`source\` varchar(40) NOT NULL,
         \`sourceUrl\` text NULL,
         \`pageTitle\` varchar(400) NULL,
         \`snippet\` text NULL,
         \`firstName\` varchar(80) NULL,
         \`lastName\` varchar(80) NULL,
         \`title\` varchar(200) NULL,
         \`companyName\` varchar(200) NULL,
         \`companyDomain\` varchar(200) NULL,
         \`linkedinUrl\` text NULL,
         \`email\` varchar(320) NULL,
         \`phone\` varchar(40) NULL,
         \`location\` varchar(200) NULL,
         \`rawJson\` json NULL,
         \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_rf_run\` ON \`raw_finds\` (\`runId\`)`,
      `CREATE INDEX \`ix_rf_ws\` ON \`raw_finds\` (\`workspaceId\`, \`createdAt\`)`,

      `CREATE TABLE IF NOT EXISTS \`discovery_runs\` (
         \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
         \`workspaceId\` int NOT NULL,
         \`userId\` int NULL,
         \`mode\` enum('person','account') NOT NULL,
         \`input\` json NOT NULL,
         \`status\` enum('running','complete','failed') NOT NULL DEFAULT 'running',
         \`rawFindCount\` int NOT NULL DEFAULT 0,
         \`prospectsCreated\` int NOT NULL DEFAULT 0,
         \`highConfidenceCount\` int NOT NULL DEFAULT 0,
         \`mediumConfidenceCount\` int NOT NULL DEFAULT 0,
         \`lowConfidenceCount\` int NOT NULL DEFAULT 0,
         \`durationMs\` int NOT NULL DEFAULT 0,
         \`errorMessage\` text NULL,
         \`startedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
         \`completedAt\` timestamp NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_dr_ws\` ON \`discovery_runs\` (\`workspaceId\`, \`startedAt\`)`,

      `CREATE TABLE IF NOT EXISTS \`discovery_logs\` (
         \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
         \`workspaceId\` int NOT NULL,
         \`runId\` int NOT NULL,
         \`phase\` varchar(32) NOT NULL,
         \`level\` varchar(8) NOT NULL DEFAULT 'info',
         \`message\` text NOT NULL,
         \`details\` json NULL,
         \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_dl_run\` ON \`discovery_logs\` (\`runId\`, \`createdAt\`)`,

      `ALTER TABLE \`prospects\` ADD COLUMN \`confidenceScore\` int NULL`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`confidenceTier\` enum('high','medium','low') NULL`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`verificationStatus\` enum('verified','needs_review','rejected') NULL`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`verificationNotes\` text NULL`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`sourceUrls\` json NULL`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`linkedinUrlVerified\` tinyint(1) NOT NULL DEFAULT 0`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`lastEnrichedAt\` timestamp NULL`,
      `ALTER TABLE \`prospects\` ADD COLUMN \`lastDiscoveryRunId\` int NULL`,
    ],
  },

  // ── 0080: extend sequenceStatus enum with paused + canceled ─────────
  // Lets a user pause an enrolled prospect (dispatcher already skips
  // anything where sequenceStatus != 'enrolled', so pause is a no-op
  // at the queue level — just flip the status). Cancel additionally
  // marks every scheduled execution_queue row as 'skipped' with a
  // 'Sequence canceled' reason so nothing accidentally fires later.
  // Both states keep the prospect row intact + history visible.
  {
    name: "0080_sequence_status_paused_canceled.sql",
    statements: [
      `ALTER TABLE \`prospect_queue\` MODIFY COLUMN \`sequenceStatus\` ENUM('pending','approved','enrolled','skipped','completed','replied','paused','canceled') NOT NULL DEFAULT 'pending'`,
    ],
  },

  // ── 0079: link discovery runs to campaigns ──────────────────────────
  // Discovery v2 launched as workspace-scoped. The follow-up requirement
  // is that prospect-discovery activity tied to a specific ARE campaign
  // surfaces in THAT campaign's Logs tab (no separate page). Add an
  // optional campaignId column so a run can carry its campaign of
  // origin; the per-campaign LogsTab filters on it.
  {
    name: "0079_discovery_runs_campaign_id.sql",
    statements: [
      `ALTER TABLE \`discovery_runs\` ADD COLUMN \`campaignId\` int NULL`,
      `CREATE INDEX \`ix_dr_campaign\` ON \`discovery_runs\` (\`campaignId\`)`,
    ],
  },

  // ── 0077: composite PK on sequence canvas tables ──────────────────────
  // React Flow gives the start node id "start-1" on every canvas. With a
  // global single-column PK, the first sequence to save claims it and
  // every other sequence's save throws "Duplicate entry 'start-1' for key
  // PRIMARY". Same problem for the auto-numbered email/wait nodes. Fix is
  // to make the PK composite (sequenceId, id) so the same React Flow id
  // can exist in different sequences. The old single-column PK was
  // already unique → all existing rows satisfy the new composite PK, so
  // the ALTER is safe in-place.
  {
    name: "0077_sequence_canvas_composite_pk.sql",
    statements: [
      `ALTER TABLE \`sequence_nodes\` DROP PRIMARY KEY, ADD PRIMARY KEY (\`sequenceId\`, \`id\`)`,
      `ALTER TABLE \`sequence_edges\` DROP PRIMARY KEY, ADD PRIMARY KEY (\`sequenceId\`, \`id\`)`,
    ],
  },

  // ── 0081: CRM polish — notes, pipelines, opportunity additions ──────
  // Foundation for the CRM gap-closure work:
  //  * `crm_notes`: workspace-scoped notes attached to any CRM entity
  //    (account/contact/lead/opportunity). The existing `activities`
  //    table covers timeline events; this is a dedicated, pinnable note
  //    surface so the detail pages can show notes separate from the
  //    activity log.
  //  * `crm_pipelines` + `crm_pipeline_stages`: multi-pipeline support
  //    per workspace. Each workspace bootstraps a "Default" pipeline
  //    mirroring the legacy 6 stages on first read (handled in router,
  //    not here, so existing data keeps working). `opportunities` gains
  //    a nullable `pipelineId` — NULL means "default pipeline" until
  //    backfilled.
  //  * `opportunities.winReason`: companion to the existing `lostReason`
  //    for closed-won revenue intelligence.
  //  * `opportunities.lastActivityAt`: drives the pipelineAlerts stale-
  //    deal scanner; updated by `crm.activities.create` and reply
  //    pollers. Nullable so we don't need a backfill.
  {
    name: "0081_crm_polish.sql",
    statements: [
      // Opportunity additions
      `ALTER TABLE \`opportunities\` ADD COLUMN \`winReason\` VARCHAR(120) NULL`,
      `ALTER TABLE \`opportunities\` ADD COLUMN \`lastActivityAt\` TIMESTAMP NULL`,
      `ALTER TABLE \`opportunities\` ADD COLUMN \`pipelineId\` INT NULL`,
      `CREATE INDEX \`ix_opp_pipeline\` ON \`opportunities\` (\`workspaceId\`, \`pipelineId\`)`,
      `CREATE INDEX \`ix_opp_last_activity\` ON \`opportunities\` (\`workspaceId\`, \`lastActivityAt\`)`,

      // Notes table — one row per note, attached to any CRM entity.
      `CREATE TABLE IF NOT EXISTS \`crm_notes\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`entityType\` varchar(30) NOT NULL,
        \`entityId\` int NOT NULL,
        \`body\` text NOT NULL,
        \`pinned\` tinyint(1) NOT NULL DEFAULT 0,
        \`createdByUserId\` int NULL,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_crm_notes_entity\` ON \`crm_notes\` (\`workspaceId\`, \`entityType\`, \`entityId\`)`,

      // Pipelines and stages — per-workspace, ordered, with won/lost flags.
      `CREATE TABLE IF NOT EXISTS \`crm_pipelines\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`name\` varchar(120) NOT NULL,
        \`isDefault\` tinyint(1) NOT NULL DEFAULT 0,
        \`sortOrder\` int NOT NULL DEFAULT 0,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_crm_pipelines_ws\` ON \`crm_pipelines\` (\`workspaceId\`)`,

      `CREATE TABLE IF NOT EXISTS \`crm_pipeline_stages\` (
        \`id\` int AUTO_INCREMENT NOT NULL,
        \`workspaceId\` int NOT NULL,
        \`pipelineId\` int NOT NULL,
        \`key\` varchar(60) NOT NULL,
        \`label\` varchar(120) NOT NULL,
        \`sortOrder\` int NOT NULL DEFAULT 0,
        \`defaultWinProb\` int NOT NULL DEFAULT 20,
        \`isWon\` tinyint(1) NOT NULL DEFAULT 0,
        \`isLost\` tinyint(1) NOT NULL DEFAULT 0,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE INDEX \`ix_crm_stages_pipeline\` ON \`crm_pipeline_stages\` (\`workspaceId\`, \`pipelineId\`, \`sortOrder\`)`,
    ],
  },

  // ── 0082: widen opportunities.stage from ENUM to VARCHAR ──────────
  // The legacy 6 stages (discovery/qualified/proposal/negotiation/won/
  // lost) were a MySQL ENUM. Multi-pipeline support needs custom stage
  // keys (e.g. "demo_scheduled", "poc_running") that don't fit in the
  // enum. Widen to VARCHAR(60). Existing enum values are valid VARCHAR
  // strings, so no data migration is needed. The drizzle schema mirrors
  // this with `varchar` in place of `mysqlEnum`.
  {
    name: "0082_opportunities_stage_varchar.sql",
    statements: [
      `ALTER TABLE \`opportunities\` MODIFY COLUMN \`stage\` VARCHAR(60) NOT NULL DEFAULT 'discovery'`,
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
