CREATE TABLE `reeval_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`campaignId` int NOT NULL,
	`createdByUserId` int,
	`thresholdUsed` int NOT NULL,
	`processed` int NOT NULL DEFAULT 0,
	`requalified` int NOT NULL DEFAULT 0,
	`runAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reeval_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_rr_campaign` ON `reeval_runs` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_rr_ws` ON `reeval_runs` (`workspaceId`);