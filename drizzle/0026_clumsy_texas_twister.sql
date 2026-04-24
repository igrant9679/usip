CREATE TABLE `sequence_ab_variants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`sequenceId` int NOT NULL,
	`stepIndex` int NOT NULL,
	`variantLabel` varchar(32) NOT NULL,
	`subject` varchar(240) NOT NULL,
	`body` text NOT NULL,
	`splitPct` int NOT NULL DEFAULT 50,
	`sentCount` int NOT NULL DEFAULT 0,
	`openCount` int NOT NULL DEFAULT 0,
	`replyCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sequence_ab_variants_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `workflow_rules` MODIFY COLUMN `triggerType` enum('record_created','record_updated','stage_changed','task_overdue','nps_submitted','signal_received','field_equals','schedule','deal_stuck') NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `aiSummary` text;--> statement-breakpoint
ALTER TABLE `calendar_events` ADD `aiSummarizedAt` timestamp;--> statement-breakpoint
CREATE INDEX `ix_sav_seq` ON `sequence_ab_variants` (`sequenceId`,`stepIndex`);--> statement-breakpoint
CREATE INDEX `ix_sav_ws` ON `sequence_ab_variants` (`workspaceId`);