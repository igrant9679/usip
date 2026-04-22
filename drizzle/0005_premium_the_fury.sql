CREATE TABLE `custom_field_defs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`entityType` varchar(32) NOT NULL,
	`fieldKey` varchar(64) NOT NULL,
	`label` varchar(120) NOT NULL,
	`fieldType` enum('text','number','date','boolean','select','multiselect','url') NOT NULL,
	`options` json,
	`required` boolean NOT NULL DEFAULT false,
	`showInList` boolean NOT NULL DEFAULT false,
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `custom_field_defs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_cfd_ws_entity_key` UNIQUE(`workspaceId`,`entityType`,`fieldKey`)
);
--> statement-breakpoint
CREATE TABLE `opportunity_intelligence` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`winProbability` decimal(5,2),
	`winProbabilityRationale` text,
	`nextBestActions` json,
	`conversationSignals` json,
	`actionItems` json,
	`emailEffectivenessScore` decimal(5,2),
	`altSubjectLines` json,
	`winStory` text,
	`outreachSequenceSuggestion` json,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `opportunity_intelligence_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `opportunity_stage_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`fromStage` varchar(64),
	`toStage` varchar(64) NOT NULL,
	`changedByUserId` int,
	`daysInPrevStage` int,
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `opportunity_stage_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`entityType` varchar(64) NOT NULL,
	`entityId` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`subject` text,
	`body` text,
	`promptUsed` text,
	`toneUsed` varchar(32),
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prompt_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `quota_targets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`period` varchar(7) NOT NULL,
	`periodType` enum('monthly','quarterly','annual') NOT NULL DEFAULT 'monthly',
	`revenueTarget` decimal(14,2) NOT NULL DEFAULT '0',
	`dealsTarget` int NOT NULL DEFAULT 0,
	`activitiesTarget` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `quota_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_qt_ws_user_period` UNIQUE(`workspaceId`,`userId`,`period`)
);
--> statement-breakpoint
CREATE TABLE `research_pipelines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`emailDraftId` int,
	`createdByUserId` int NOT NULL,
	`toContactId` int,
	`toLeadId` int,
	`toAccountId` int,
	`stage1_prospect` json,
	`stage2_signals` json,
	`stage3_angles` json,
	`stage4_draft` json,
	`stage5_final` json,
	`status` enum('running','complete','failed') NOT NULL DEFAULT 'running',
	`currentStage` int NOT NULL DEFAULT 1,
	`errorMessage` text,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `research_pipelines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stage_approvals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`requestedByUserId` int NOT NULL,
	`approverUserId` int,
	`fromStage` varchar(64) NOT NULL,
	`toStage` varchar(64) NOT NULL,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`note` text,
	`reviewNote` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `stage_approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `subject_variants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`emailDraftId` int NOT NULL,
	`subject` text NOT NULL,
	`spamScore` decimal(5,2),
	`spamFlags` json,
	`aiRationale` text,
	`isSelected` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `subject_variants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_cfd_ws` ON `custom_field_defs` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_oi_opp` ON `opportunity_intelligence` (`opportunityId`);--> statement-breakpoint
CREATE INDEX `ix_oi_ws` ON `opportunity_intelligence` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_osh_opp` ON `opportunity_stage_history` (`opportunityId`);--> statement-breakpoint
CREATE INDEX `ix_osh_ws` ON `opportunity_stage_history` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_pv_entity` ON `prompt_versions` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `ix_pv_ws` ON `prompt_versions` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_qt_ws` ON `quota_targets` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_rp_ws` ON `research_pipelines` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_rp_draft` ON `research_pipelines` (`emailDraftId`);--> statement-breakpoint
CREATE INDEX `ix_sa_opp` ON `stage_approvals` (`opportunityId`);--> statement-breakpoint
CREATE INDEX `ix_sa_ws` ON `stage_approvals` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_sv_draft` ON `subject_variants` (`emailDraftId`);--> statement-breakpoint
CREATE INDEX `ix_sv_ws` ON `subject_variants` (`workspaceId`);