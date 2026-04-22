CREATE TABLE `email_verification_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`snapshotDate` date NOT NULL,
	`valid` int NOT NULL DEFAULT 0,
	`acceptAll` int NOT NULL DEFAULT 0,
	`risky` int NOT NULL DEFAULT 0,
	`invalid` int NOT NULL DEFAULT 0,
	`unknown` int NOT NULL DEFAULT 0,
	`total` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_verification_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `reverifyIntervalDays` int;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `reverifyStatuses` json;--> statement-breakpoint
CREATE INDEX `ix_evs_ws_date` ON `email_verification_snapshots` (`workspaceId`,`snapshotDate`);