CREATE TABLE `segment_sequence_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`segmentId` int NOT NULL,
	`sequenceId` int NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`lastRunAt` timestamp,
	`enrolledCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `segment_sequence_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `smtp_configs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`host` varchar(255) NOT NULL,
	`port` int NOT NULL DEFAULT 587,
	`secure` boolean NOT NULL DEFAULT false,
	`username` varchar(255) NOT NULL,
	`encryptedPassword` text NOT NULL,
	`fromName` varchar(120),
	`fromEmail` varchar(255) NOT NULL,
	`replyTo` varchar(255),
	`enabled` boolean NOT NULL DEFAULT true,
	`lastTestedAt` timestamp,
	`lastTestStatus` varchar(16),
	`lastTestError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `smtp_configs_id` PRIMARY KEY(`id`),
	CONSTRAINT `smtp_configs_workspaceId_unique` UNIQUE(`workspaceId`)
);
--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `nightlyPipelineEnabled` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `nightlyScoreThreshold` int DEFAULT 60 NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_ssr_ws` ON `segment_sequence_rules` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_ssr_seg` ON `segment_sequence_rules` (`segmentId`);--> statement-breakpoint
CREATE INDEX `ix_ssr_seq` ON `segment_sequence_rules` (`sequenceId`);--> statement-breakpoint
CREATE INDEX `ix_ssr_uniq` ON `segment_sequence_rules` (`workspaceId`,`segmentId`,`sequenceId`);--> statement-breakpoint
CREATE INDEX `ix_smtp_ws` ON `smtp_configs` (`workspaceId`);