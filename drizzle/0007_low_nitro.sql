CREATE TABLE `brand_voice_profiles` (
	`workspaceId` int NOT NULL,
	`tone` enum('professional','conversational','direct','empathetic','authoritative') NOT NULL DEFAULT 'professional',
	`vocabulary` json,
	`avoidWords` json,
	`signatureHtml` text,
	`fromName` varchar(120),
	`fromEmail` varchar(200),
	`primaryColor` varchar(16) NOT NULL DEFAULT '#14B89A',
	`secondaryColor` varchar(16) NOT NULL DEFAULT '#0F766E',
	`applyToAI` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `brand_voice_profiles_workspaceId` PRIMARY KEY(`workspaceId`)
);
--> statement-breakpoint
CREATE TABLE `email_prompt_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`goal` enum('intro','follow_up','meeting_request','value_prop','breakup','check_in') NOT NULL,
	`promptText` text NOT NULL,
	`isActive` boolean NOT NULL DEFAULT false,
	`abGroup` enum('A','B') NOT NULL DEFAULT 'A',
	`draftsGenerated` int NOT NULL DEFAULT 0,
	`draftsApproved` int NOT NULL DEFAULT 0,
	`avgSubjectScore` decimal(5,2),
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_prompt_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_snippets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`category` enum('opener','value_prop','social_proof','objection_handler','cta','closing','ps') NOT NULL,
	`bodyHtml` text NOT NULL,
	`bodyPlain` text NOT NULL,
	`mergeTagsUsed` json,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_snippets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`category` varchar(64) NOT NULL DEFAULT 'general',
	`subject` text,
	`designData` json NOT NULL,
	`htmlOutput` text,
	`plainOutput` text,
	`status` enum('draft','active','archived') NOT NULL DEFAULT 'draft',
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_ept_ws` ON `email_prompt_templates` (`workspaceId`,`goal`,`isActive`);--> statement-breakpoint
CREATE INDEX `ix_es_ws` ON `email_snippets` (`workspaceId`,`category`);--> statement-breakpoint
CREATE INDEX `ix_et_ws` ON `email_templates` (`workspaceId`,`status`);