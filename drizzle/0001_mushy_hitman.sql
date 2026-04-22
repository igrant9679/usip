CREATE TABLE `accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`domain` varchar(200),
	`industry` varchar(80),
	`employeeBand` varchar(40),
	`revenueBand` varchar(40),
	`region` varchar(80),
	`parentAccountId` int,
	`territoryId` int,
	`ownerUserId` int,
	`arr` decimal(14,2) DEFAULT '0',
	`color` varchar(16),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `activities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`type` enum('call','meeting','email','note','linkedin','stage_change','system') NOT NULL,
	`relatedType` varchar(30) NOT NULL,
	`relatedId` int NOT NULL,
	`subject` varchar(240),
	`body` text,
	`callDisposition` enum('connected','voicemail','no_answer','bad_number','gatekeeper','callback_requested','not_interested'),
	`callDurationSec` int,
	`callOutcome` text,
	`meetingStartedAt` timestamp,
	`meetingEndedAt` timestamp,
	`meetingAttendees` json,
	`mentions` json,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`actorUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `activities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`relatedType` varchar(30) NOT NULL,
	`relatedId` int NOT NULL,
	`fileKey` varchar(512) NOT NULL,
	`url` text NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`mimeType` varchar(120),
	`sizeBytes` int,
	`uploadedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`actorUserId` int,
	`action` enum('create','update','delete','login','logout','scim') NOT NULL,
	`entityType` varchar(40) NOT NULL,
	`entityId` int,
	`before` json,
	`after` json,
	`ip` varchar(64),
	`userAgent` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaign_components` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`campaignId` int NOT NULL,
	`componentType` enum('sequence','social_post','ad','content','event') NOT NULL,
	`componentId` int,
	`label` varchar(200) NOT NULL,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `campaign_components_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`objective` varchar(80),
	`status` enum('planning','scheduled','live','completed','paused') NOT NULL DEFAULT 'planning',
	`startsAt` timestamp,
	`endsAt` timestamp,
	`budget` decimal(14,2) DEFAULT '0',
	`targetSegment` text,
	`description` text,
	`checklist` json,
	`ownerUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`accountId` int,
	`firstName` varchar(80) NOT NULL,
	`lastName` varchar(80) NOT NULL,
	`title` varchar(120),
	`email` varchar(320),
	`phone` varchar(40),
	`linkedinUrl` text,
	`city` varchar(80),
	`seniority` varchar(32),
	`isPrimary` boolean NOT NULL DEFAULT false,
	`ownerUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contract_amendments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`customerId` int NOT NULL,
	`type` enum('upgrade','downgrade','addon','renewal','termination','price_change') NOT NULL,
	`arrDelta` decimal(14,2) NOT NULL DEFAULT '0',
	`effectiveAt` timestamp NOT NULL,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`createdByUserId` int,
	CONSTRAINT `contract_amendments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`accountId` int NOT NULL,
	`arr` decimal(14,2) NOT NULL DEFAULT '0',
	`contractStart` timestamp,
	`contractEnd` timestamp,
	`tier` enum('enterprise','midmarket','smb') NOT NULL DEFAULT 'midmarket',
	`cmUserId` int,
	`healthScore` int NOT NULL DEFAULT 50,
	`healthTier` enum('healthy','watch','at_risk','critical') NOT NULL DEFAULT 'watch',
	`usageScore` int NOT NULL DEFAULT 50,
	`engagementScore` int NOT NULL DEFAULT 50,
	`supportScore` int NOT NULL DEFAULT 50,
	`npsScore` int NOT NULL DEFAULT 0,
	`npsHistory` json,
	`expansionPotential` decimal(14,2) DEFAULT '0',
	`aiPlay` text,
	`renewalStage` enum('early','ninety','sixty','thirty','at_risk','renewed','churned') NOT NULL DEFAULT 'early',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dashboard_widgets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`dashboardId` int NOT NULL,
	`type` enum('kpi','bar','line','pie','funnel','table') NOT NULL,
	`title` varchar(160) NOT NULL,
	`config` json NOT NULL,
	`position` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dashboard_widgets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` text,
	`layout` json,
	`isShared` boolean NOT NULL DEFAULT true,
	`ownerUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dashboards_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `deal_line_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`productId` int NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`unitPrice` decimal(14,2) NOT NULL,
	`discountPct` decimal(5,2) NOT NULL DEFAULT '0',
	`lineTotal` decimal(14,2) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deal_line_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_drafts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`subject` varchar(240) NOT NULL,
	`body` text NOT NULL,
	`toContactId` int,
	`toLeadId` int,
	`toEmail` varchar(320),
	`sequenceId` int,
	`enrollmentId` int,
	`status` enum('pending_review','approved','rejected','sent') NOT NULL DEFAULT 'pending_review',
	`aiGenerated` boolean NOT NULL DEFAULT true,
	`aiPrompt` text,
	`createdByUserId` int,
	`reviewedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`sentAt` timestamp,
	CONSTRAINT `email_drafts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `enrollments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`sequenceId` int NOT NULL,
	`contactId` int,
	`leadId` int,
	`status` enum('active','paused','finished','exited') NOT NULL DEFAULT 'active',
	`currentStep` int NOT NULL DEFAULT 0,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`nextActionAt` timestamp,
	CONSTRAINT `enrollments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `leads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`firstName` varchar(80) NOT NULL,
	`lastName` varchar(80) NOT NULL,
	`email` varchar(320),
	`phone` varchar(40),
	`company` varchar(200),
	`title` varchar(120),
	`source` varchar(60),
	`status` enum('new','working','qualified','unqualified','converted') NOT NULL DEFAULT 'new',
	`score` int NOT NULL DEFAULT 0,
	`grade` varchar(4),
	`scoreReasons` json,
	`tags` json,
	`convertedContactId` int,
	`convertedAccountId` int,
	`convertedOpportunityId` int,
	`ownerUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `leads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`kind` enum('mention','task_assigned','task_due','deal_won','deal_lost','renewal_due','churn_risk','approval_request','workflow_fired','system') NOT NULL,
	`title` varchar(240) NOT NULL,
	`body` text,
	`relatedType` varchar(30),
	`relatedId` int,
	`readAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`accountId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`stage` enum('discovery','qualified','proposal','negotiation','won','lost') NOT NULL DEFAULT 'discovery',
	`value` decimal(14,2) NOT NULL DEFAULT '0',
	`winProb` int NOT NULL DEFAULT 20,
	`closeDate` timestamp,
	`daysInStage` int NOT NULL DEFAULT 0,
	`aiNote` text,
	`nextStep` text,
	`lostReason` varchar(120),
	`campaignId` int,
	`ownerUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `opportunities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `opportunity_contact_roles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`contactId` int NOT NULL,
	`role` enum('champion','decision_maker','influencer','evaluator','blocker','user','other') NOT NULL DEFAULT 'influencer',
	`isPrimary` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `opportunity_contact_roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ocr` UNIQUE(`opportunityId`,`contactId`,`role`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`sku` varchar(60) NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`category` varchar(80),
	`listPrice` decimal(14,2) NOT NULL,
	`cost` decimal(14,2) DEFAULT '0',
	`billingCycle` enum('one_time','monthly','annual') NOT NULL DEFAULT 'annual',
	`active` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_prod_sku` UNIQUE(`workspaceId`,`sku`)
);
--> statement-breakpoint
CREATE TABLE `qbrs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`customerId` int NOT NULL,
	`scheduledAt` timestamp,
	`completedAt` timestamp,
	`status` enum('scheduled','completed','cancelled') NOT NULL DEFAULT 'scheduled',
	`aiPrep` json,
	`notes` text,
	`nextActions` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `qbrs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `quote_line_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`quoteId` int NOT NULL,
	`productId` int,
	`name` varchar(200) NOT NULL,
	`description` text,
	`quantity` int NOT NULL DEFAULT 1,
	`unitPrice` decimal(14,2) NOT NULL,
	`discountPct` decimal(5,2) NOT NULL DEFAULT '0',
	`lineTotal` decimal(14,2) NOT NULL,
	CONSTRAINT `quote_line_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`quoteNumber` varchar(40) NOT NULL,
	`status` enum('draft','sent','accepted','rejected','expired') NOT NULL DEFAULT 'draft',
	`expiresAt` timestamp,
	`subtotal` decimal(14,2) NOT NULL DEFAULT '0',
	`discountTotal` decimal(14,2) NOT NULL DEFAULT '0',
	`taxTotal` decimal(14,2) NOT NULL DEFAULT '0',
	`total` decimal(14,2) NOT NULL DEFAULT '0',
	`notes` text,
	`terms` text,
	`pdfFileKey` varchar(512),
	`pdfUrl` text,
	`sentAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `quotes_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_quote_num` UNIQUE(`workspaceId`,`quoteNumber`)
);
--> statement-breakpoint
CREATE TABLE `report_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`dashboardId` int NOT NULL,
	`frequency` enum('daily','weekly','monthly') NOT NULL,
	`recipients` json,
	`enabled` boolean NOT NULL DEFAULT true,
	`lastSentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `report_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scim_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`providerId` int NOT NULL,
	`resource` enum('Users','Groups') NOT NULL,
	`method` varchar(10) NOT NULL,
	`payload` json,
	`responseStatus` int,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `scim_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scim_providers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`bearerToken` varchar(128) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`lastEventAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `scim_providers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sequences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`status` enum('draft','active','paused','archived') NOT NULL DEFAULT 'draft',
	`steps` json NOT NULL,
	`ownerUserId` int,
	`enrolledCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sequences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `social_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`platform` enum('linkedin','twitter','facebook','instagram') NOT NULL,
	`handle` varchar(120) NOT NULL,
	`displayName` varchar(200),
	`avatarUrl` text,
	`connected` boolean NOT NULL DEFAULT false,
	`accessTokenStub` varchar(64),
	`connectedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `social_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `social_posts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`socialAccountId` int NOT NULL,
	`platform` enum('linkedin','twitter','facebook','instagram') NOT NULL,
	`body` text NOT NULL,
	`mediaUrls` json,
	`firstComment` text,
	`status` enum('draft','in_review','approved','scheduled','published','failed','rejected') NOT NULL DEFAULT 'draft',
	`scheduledFor` timestamp,
	`publishedAt` timestamp,
	`impressions` int NOT NULL DEFAULT 0,
	`engagements` int NOT NULL DEFAULT 0,
	`clicks` int NOT NULL DEFAULT 0,
	`campaignId` int,
	`aiVariants` json,
	`authorUserId` int,
	`approverUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `social_posts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`customerId` int NOT NULL,
	`subject` varchar(240) NOT NULL,
	`severity` enum('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
	`status` enum('open','pending','resolved','closed') NOT NULL DEFAULT 'open',
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	CONSTRAINT `support_tickets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`title` varchar(240) NOT NULL,
	`description` text,
	`type` enum('call','email','meeting','linkedin','todo','follow_up') NOT NULL DEFAULT 'todo',
	`priority` enum('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
	`status` enum('open','done','cancelled') NOT NULL DEFAULT 'open',
	`dueAt` timestamp,
	`completedAt` timestamp,
	`ownerUserId` int,
	`relatedType` varchar(30),
	`relatedId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `territories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`rules` json,
	`ownerUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `territories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workflow_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`triggerType` enum('record_created','record_updated','stage_changed','task_overdue','nps_submitted','signal_received','field_equals','schedule') NOT NULL,
	`triggerConfig` json NOT NULL,
	`conditions` json NOT NULL,
	`actions` json NOT NULL,
	`fireCount` int NOT NULL DEFAULT 0,
	`lastFiredAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workflow_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`ruleId` int NOT NULL,
	`triggeredBy` varchar(60),
	`relatedType` varchar(30),
	`relatedId` int,
	`status` enum('success','failed','skipped') NOT NULL,
	`actionsRun` json,
	`errorMessage` text,
	`runAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workflow_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`role` enum('super_admin','admin','manager','rep') NOT NULL DEFAULT 'rep',
	`title` varchar(120),
	`territoryId` int,
	`quota` decimal(14,2),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ws_user` UNIQUE(`workspaceId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`ownerUserId` int NOT NULL,
	`logoUrl` text,
	`plan` enum('trial','starter','growth','scale') NOT NULL DEFAULT 'trial',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspaces_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `avatarUrl` text;--> statement-breakpoint
CREATE INDEX `ix_acc_ws` ON `accounts` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_acc_parent` ON `accounts` (`parentAccountId`);--> statement-breakpoint
CREATE INDEX `ix_act_rel` ON `activities` (`relatedType`,`relatedId`);--> statement-breakpoint
CREATE INDEX `ix_act_ws` ON `activities` (`workspaceId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `ix_att_rel` ON `attachments` (`relatedType`,`relatedId`);--> statement-breakpoint
CREATE INDEX `ix_audit_ws` ON `audit_log` (`workspaceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ix_audit_ent` ON `audit_log` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `ix_cc_camp` ON `campaign_components` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_camp_ws` ON `campaigns` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_con_ws` ON `contacts` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_con_acc` ON `contacts` (`accountId`);--> statement-breakpoint
CREATE INDEX `ix_amend_cust` ON `contract_amendments` (`customerId`);--> statement-breakpoint
CREATE INDEX `ix_cust_ws` ON `customers` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_dw_dash` ON `dashboard_widgets` (`dashboardId`);--> statement-breakpoint
CREATE INDEX `ix_dash_ws` ON `dashboards` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_dli_opp` ON `deal_line_items` (`opportunityId`);--> statement-breakpoint
CREATE INDEX `ix_ed_ws` ON `email_drafts` (`workspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `ix_enr_seq` ON `enrollments` (`sequenceId`);--> statement-breakpoint
CREATE INDEX `ix_lead_ws` ON `leads` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_lead_score` ON `leads` (`workspaceId`,`score`);--> statement-breakpoint
CREATE INDEX `ix_notif_user` ON `notifications` (`workspaceId`,`userId`,`readAt`);--> statement-breakpoint
CREATE INDEX `ix_opp_ws` ON `opportunities` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_opp_stage` ON `opportunities` (`workspaceId`,`stage`);--> statement-breakpoint
CREATE INDEX `ix_ocr_opp` ON `opportunity_contact_roles` (`opportunityId`);--> statement-breakpoint
CREATE INDEX `ix_prod_ws` ON `products` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_qbr_cust` ON `qbrs` (`customerId`);--> statement-breakpoint
CREATE INDEX `ix_qli_quote` ON `quote_line_items` (`quoteId`);--> statement-breakpoint
CREATE INDEX `ix_quote_opp` ON `quotes` (`opportunityId`);--> statement-breakpoint
CREATE INDEX `ix_rs_ws` ON `report_schedules` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_scim_prov` ON `scim_events` (`providerId`,`receivedAt`);--> statement-breakpoint
CREATE INDEX `ix_scim_ws` ON `scim_providers` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_seq_ws` ON `sequences` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_sa_ws` ON `social_accounts` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_sp_ws` ON `social_posts` (`workspaceId`,`scheduledFor`);--> statement-breakpoint
CREATE INDEX `ix_sp_status` ON `social_posts` (`workspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `ix_tic_cust` ON `support_tickets` (`customerId`);--> statement-breakpoint
CREATE INDEX `ix_task_owner` ON `tasks` (`workspaceId`,`ownerUserId`,`status`);--> statement-breakpoint
CREATE INDEX `ix_task_rel` ON `tasks` (`relatedType`,`relatedId`);--> statement-breakpoint
CREATE INDEX `ix_terr_ws` ON `territories` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_wf_ws` ON `workflow_rules` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_wfr_rule` ON `workflow_runs` (`ruleId`,`runAt`);--> statement-breakpoint
CREATE INDEX `ix_wsm_ws` ON `workspace_members` (`workspaceId`);