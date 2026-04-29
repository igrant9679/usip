-- Migration 0048: Clodura prospect search, ingestion, and contact enrichment
-- Additive only — no drops or renames on existing tables.

-- ── 1. Standalone prospects table (Clodura-sourced outbound prospects) ────────
CREATE TABLE `prospects` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  -- Clodura identifiers
  `clodura_person_id` varchar(64) UNIQUE,
  `clodura_org_id` varchar(64),
  `clodura_synced_at` timestamp,
  -- Person fields
  `firstName` varchar(80) NOT NULL,
  `lastName` varchar(80) NOT NULL,
  `title` varchar(120),
  `seniority` varchar(64),
  `functional_area` varchar(64),
  `linkedin_url` text,
  `email` varchar(320),
  `phone` varchar(40),
  `city` varchar(80),
  `state` varchar(80),
  `country` varchar(80),
  -- Company fields
  `company` varchar(200),
  `company_domain` varchar(200),
  `industry` varchar(80),
  -- Email reveal status
  `email_status` varchar(20),  -- verified|unverified|unavailable
  `email_revealed_at` timestamp,
  `phone_revealed_at` timestamp,
  -- Linked CRM record (after promotion)
  `linked_contact_id` int,
  -- Metadata
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `prospects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_pro_ws` ON `prospects` (`workspaceId`);
--> statement-breakpoint
CREATE INDEX `ix_pro_email` ON `prospects` (`email`);
--> statement-breakpoint

-- ── 2. Async reveal job tracking ──────────────────────────────────────────────
CREATE TABLE `clodura_reveal_jobs` (
  `id` int AUTO_INCREMENT NOT NULL,
  `tracking_id` varchar(128) UNIQUE NOT NULL,
  `prospect_id` int NOT NULL,
  `kind` varchar(10) NOT NULL,  -- email|phone
  `status` varchar(20) NOT NULL DEFAULT 'pending',  -- pending|completed|failed|expired
  `requested_by` int,
  `requested_at` timestamp NOT NULL DEFAULT (now()),
  `completed_at` timestamp,
  `error` text,
  CONSTRAINT `clodura_reveal_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_crj_prospect` ON `clodura_reveal_jobs` (`prospect_id`);
--> statement-breakpoint
CREATE INDEX `ix_crj_tracking` ON `clodura_reveal_jobs` (`tracking_id`);
--> statement-breakpoint

-- ── 3. Per-user saved search filters ─────────────────────────────────────────
CREATE TABLE `clodura_saved_searches` (
  `id` int AUTO_INCREMENT NOT NULL,
  `user_id` int NOT NULL,
  `workspaceId` int NOT NULL,
  `name` varchar(120),
  `filters` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `clodura_saved_searches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_css_user` ON `clodura_saved_searches` (`user_id`, `workspaceId`);
--> statement-breakpoint

-- ── 4. 24-hour search response cache ─────────────────────────────────────────
CREATE TABLE `clodura_search_cache` (
  `cache_key` varchar(128) NOT NULL,
  `workspaceId` int NOT NULL,
  `response` json NOT NULL,
  `cached_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `clodura_search_cache_pk` PRIMARY KEY(`cache_key`, `workspaceId`)
);
--> statement-breakpoint
CREATE INDEX `ix_csc_ws_cached` ON `clodura_search_cache` (`workspaceId`, `cached_at`);
--> statement-breakpoint

-- ── 5. New columns on contacts (enrichment metadata) ─────────────────────────
ALTER TABLE `contacts` ADD COLUMN `source_prospect_id` int;
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `clodura_person_id` varchar(64);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `clodura_org_id` varchar(64);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `functional_area` varchar(64);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `industry` varchar(80);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_domain` varchar(200);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_employee_size` varchar(40);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_revenue` varchar(40);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_founded_year` int;
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_phone` varchar(40);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_city` varchar(80);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_state` varchar(80);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `company_country` varchar(80);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `enriched_at` timestamp;
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `enrichment_status` varchar(20);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `enrichment_confidence` varchar(20);
--> statement-breakpoint
ALTER TABLE `contacts` ADD COLUMN `manually_edited_fields` json DEFAULT ('[]');
--> statement-breakpoint

-- ── 6. Enrichment job tracking ────────────────────────────────────────────────
CREATE TABLE `clodura_enrichment_jobs` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `contact_id` int NOT NULL,
  `trigger` varchar(20) NOT NULL,  -- manual|bulk|auto_on_create|scheduled
  `identifier_set` json NOT NULL,
  `confidence` varchar(20),        -- highest|medium|low
  `status` varchar(20) NOT NULL DEFAULT 'pending',  -- pending|completed|no_match|failed
  `credits_consumed` int DEFAULT 0,
  `raw_response` json,
  `raw_response_purged_at` timestamp,
  `requested_by` int,
  `requested_at` timestamp NOT NULL DEFAULT (now()),
  `completed_at` timestamp,
  `error` text,
  CONSTRAINT `clodura_enrichment_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_cej_contact` ON `clodura_enrichment_jobs` (`contact_id`);
--> statement-breakpoint
CREATE INDEX `ix_cej_status` ON `clodura_enrichment_jobs` (`status`, `requested_at`);
--> statement-breakpoint
CREATE INDEX `ix_cej_ws` ON `clodura_enrichment_jobs` (`workspaceId`);
--> statement-breakpoint

-- ── 7. Field-level enrichment history ────────────────────────────────────────
CREATE TABLE `contact_enrichment_history` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `contact_id` int NOT NULL,
  `enrichment_job_id` int,
  `field_name` varchar(80) NOT NULL,
  `old_value` text,
  `new_value` text,
  `applied_by` int,
  `applied_at` timestamp NOT NULL DEFAULT (now()),
  `source` varchar(40) NOT NULL DEFAULT 'clodura_enrich',
  CONSTRAINT `contact_enrichment_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_ceh_contact` ON `contact_enrichment_history` (`contact_id`, `applied_at`);
--> statement-breakpoint
CREATE INDEX `ix_ceh_ws` ON `contact_enrichment_history` (`workspaceId`);
--> statement-breakpoint

-- ── 8. Per-workspace enrichment settings ─────────────────────────────────────
CREATE TABLE `clodura_enrichment_settings` (
  `workspaceId` int NOT NULL,
  `auto_enrich_on_create` boolean NOT NULL DEFAULT false,
  `scheduled_reenrich_enabled` boolean NOT NULL DEFAULT false,
  `stale_threshold_days` int NOT NULL DEFAULT 90,
  `daily_budget_cap` int NOT NULL DEFAULT 1500,
  `updated_by` int,
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `clodura_enrichment_settings_pk` PRIMARY KEY(`workspaceId`)
);
