CREATE TABLE `audience_segments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`matchType` varchar(10) NOT NULL DEFAULT 'all',
	`rules` json NOT NULL,
	`contactCount` int DEFAULT 0,
	`lastEvaluatedAt` timestamp,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `audience_segments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `email_verification_jobs` MODIFY COLUMN `triggeredByUserId` int;--> statement-breakpoint
CREATE INDEX `ix_as_ws` ON `audience_segments` (`workspaceId`);