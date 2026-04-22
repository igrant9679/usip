CREATE TABLE `account_briefs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`accountId` int NOT NULL,
	`content` text NOT NULL,
	`pdfUrl` text,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`generatedByUserId` int,
	CONSTRAINT `account_briefs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_pipeline_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`contactId` int,
	`leadId` int,
	`status` enum('queued','running','done','failed') NOT NULL DEFAULT 'queued',
	`orgResearch` text,
	`contactResearch` text,
	`fitAnalysis` json,
	`draftsGenerated` int NOT NULL DEFAULT 0,
	`errorMessage` text,
	`triggeredByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `ai_pipeline_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pipeline_alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`opportunityId` int NOT NULL,
	`alertType` enum('no_activity','closing_soon_regression','amount_change','no_champion') NOT NULL,
	`details` json,
	`dismissedAt` timestamp,
	`dismissedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pipeline_alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_ab_ws` ON `account_briefs` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_ab_account` ON `account_briefs` (`accountId`);--> statement-breakpoint
CREATE INDEX `ix_apj_ws` ON `ai_pipeline_jobs` (`workspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `ix_apj_contact` ON `ai_pipeline_jobs` (`contactId`);--> statement-breakpoint
CREATE INDEX `ix_pa_ws` ON `pipeline_alerts` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_pa_opp` ON `pipeline_alerts` (`opportunityId`);