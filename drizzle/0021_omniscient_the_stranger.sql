CREATE TABLE `campaign_step_stats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`campaignId` int NOT NULL,
	`stepIndex` int NOT NULL,
	`stepLabel` varchar(200),
	`sent` int NOT NULL DEFAULT 0,
	`delivered` int NOT NULL DEFAULT 0,
	`opened` int NOT NULL DEFAULT 0,
	`clicked` int NOT NULL DEFAULT 0,
	`replied` int NOT NULL DEFAULT 0,
	`bounced` int NOT NULL DEFAULT 0,
	`unsubscribed` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `campaign_step_stats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `audienceType` enum('contacts','segment') DEFAULT 'contacts';--> statement-breakpoint
ALTER TABLE `campaigns` ADD `audienceIds` json;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `audienceSegmentId` int;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `sequenceId` int;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `senderType` enum('account','pool') DEFAULT 'account';--> statement-breakpoint
ALTER TABLE `campaigns` ADD `sendingAccountId` int;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `senderPoolId` int;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `rotationStrategy` enum('round_robin','weighted','random') DEFAULT 'round_robin';--> statement-breakpoint
ALTER TABLE `campaigns` ADD `throttlePerHour` int DEFAULT 50;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `throttlePerDay` int DEFAULT 500;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `abVariants` json;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `totalSent` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `totalDelivered` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `totalOpened` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `totalClicked` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `totalReplied` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `totalBounced` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `totalUnsubscribed` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `ix_css_camp` ON `campaign_step_stats` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_css_uniq` ON `campaign_step_stats` (`workspaceId`,`campaignId`,`stepIndex`);