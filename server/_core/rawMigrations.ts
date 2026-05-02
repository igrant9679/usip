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
      `CREATE INDEX IF NOT EXISTS \`ix_pro_ws\` ON \`prospects\` (\`workspaceId\`)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`source_prospect_id\` int`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`clodura_person_id\` varchar(64)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`clodura_org_id\` varchar(64)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`functional_area\` varchar(64)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`industry\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_domain\` varchar(200)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_employee_size\` varchar(40)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_revenue\` varchar(40)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_founded_year\` int`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_phone\` varchar(40)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_city\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_state\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`company_country\` varchar(80)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`enriched_at\` timestamp`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`enrichment_status\` varchar(20)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`enrichment_confidence\` varchar(20)`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`manually_edited_fields\` json DEFAULT ('[]')`,
    ],
  },

  // ── 0049: Opportunity suggested stage ─────────────────────────────────────
  {
    name: "0049_opp_suggested_stage.sql",
    statements: [
      `ALTER TABLE \`opportunities\` ADD COLUMN IF NOT EXISTS \`suggestedStage\` varchar(80)`,
      `ALTER TABLE \`opportunities\` ADD COLUMN IF NOT EXISTS \`suggestedStageReason\` text`,
      `ALTER TABLE \`opportunities\` ADD COLUMN IF NOT EXISTS \`suggestedStageAt\` timestamp`,
    ],
  },

  // ── 0050: AI features columns ─────────────────────────────────────────────
  {
    name: "0050_ai_features.sql",
    statements: [
      `ALTER TABLE \`workspaces\` ADD COLUMN IF NOT EXISTS \`aiEnabled\` tinyint(1) NOT NULL DEFAULT 1`,
      `ALTER TABLE \`workspaces\` ADD COLUMN IF NOT EXISTS \`aiModel\` varchar(80)`,
      `ALTER TABLE \`workspaces\` ADD COLUMN IF NOT EXISTS \`aiProvider\` varchar(40)`,
      `ALTER TABLE \`workspaces\` ADD COLUMN IF NOT EXISTS \`aiApiKey\` varchar(500)`,
      `ALTER TABLE \`workspaces\` ADD COLUMN IF NOT EXISTS \`aiSystemPrompt\` text`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`aiSummary\` text`,
      `ALTER TABLE \`contacts\` ADD COLUMN IF NOT EXISTS \`aiSummarizedAt\` timestamp`,
      `ALTER TABLE \`opportunities\` ADD COLUMN IF NOT EXISTS \`aiInsight\` text`,
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
      `ALTER TABLE \`help_articles\` ADD COLUMN IF NOT EXISTS \`readingTimeMinutes\` int NULL`,
      `ALTER TABLE \`help_articles\` ADD COLUMN IF NOT EXISTS \`pageKeys\` json NULL`,
      // MODIFY COLUMN for enum extension — tolerated if already has 'archived'
      `ALTER TABLE \`help_articles\` MODIFY COLUMN \`status\` enum('draft','published','archived') NOT NULL DEFAULT 'draft'`,
    ],
  },

  // ── 0054: Tour step routeTo column ────────────────────────────────────────
  {
    name: "0054_tour_step_route.sql",
    statements: [
      `ALTER TABLE \`tour_steps\` ADD COLUMN IF NOT EXISTS \`routeTo\` varchar(200) NULL`,
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
