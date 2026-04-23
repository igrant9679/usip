CREATE TABLE `email_tracking_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`draftId` int NOT NULL,
	`type` enum('open','click') NOT NULL,
	`url` varchar(2048),
	`userAgent` varchar(512),
	`ip` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_tracking_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `trackingToken` varchar(64);--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `openCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `clickCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `lastOpenedAt` timestamp;--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `lastClickedAt` timestamp;--> statement-breakpoint
CREATE INDEX `ix_ete_draft` ON `email_tracking_events` (`draftId`);--> statement-breakpoint
CREATE INDEX `ix_ete_ws` ON `email_tracking_events` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_ed_token` ON `email_drafts` (`trackingToken`);