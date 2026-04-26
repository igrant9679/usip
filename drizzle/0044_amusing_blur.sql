CREATE TABLE `prospect_notes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`prospectQueueId` int NOT NULL,
	`userId` int NOT NULL,
	`body` text NOT NULL,
	`isPinned` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prospect_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `prospect_queue` ADD `rejectedAt` timestamp;--> statement-breakpoint
ALTER TABLE `prospect_queue` ADD `rejectedByUserId` int;--> statement-breakpoint
ALTER TABLE `prospect_queue` ADD `rejectionReason` text;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areDefaultAutonomyMode` enum('full','batch_approval','review_release') DEFAULT 'batch_approval' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areDefaultDailySendCap` int DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areDefaultAutoApproveThreshold` int;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areDefaultSignalToOpportunity` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areDefaultChannels` json;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areDefaultSequenceTemplate` varchar(64) DEFAULT 'standard_7step' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areMaxConcurrentCampaigns` int DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areNotifyOnMeetingBooked` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areNotifyOnAutoApprove` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `areNotifyOnIcpUpdate` boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_pn_prospect` ON `prospect_notes` (`prospectQueueId`);--> statement-breakpoint
CREATE INDEX `ix_pn_ws` ON `prospect_notes` (`workspaceId`);