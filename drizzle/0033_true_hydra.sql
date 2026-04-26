CREATE TABLE `proposal_feedback` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proposalId` int NOT NULL,
	`authorName` varchar(255) NOT NULL,
	`authorEmail` varchar(320),
	`message` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `proposal_feedback_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `proposal_milestones` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proposalId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`milestoneDate` timestamp,
	`description` text,
	`owner` enum('lsi_media','client','both') NOT NULL DEFAULT 'lsi_media',
	`sortOrder` int NOT NULL DEFAULT 0,
	CONSTRAINT `proposal_milestones_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `proposal_sections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proposalId` int NOT NULL,
	`sectionKey` varchar(64) NOT NULL,
	`content` text NOT NULL DEFAULT (''),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `proposal_sections_id` PRIMARY KEY(`id`),
	CONSTRAINT `ix_ps_uniq` UNIQUE(`proposalId`,`sectionKey`)
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`createdBy` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`clientName` varchar(255) NOT NULL,
	`clientEmail` varchar(320),
	`clientWebsite` varchar(512),
	`orgAbbr` varchar(32),
	`contactId` int,
	`accountId` int,
	`projectType` varchar(120),
	`rfpDeadline` timestamp,
	`completionDate` timestamp,
	`budget` decimal(14,2),
	`description` text,
	`requirements` json DEFAULT ('[]'),
	`status` enum('draft','sent','under_review','accepted','not_accepted','revision_requested') NOT NULL DEFAULT 'draft',
	`shareToken` varchar(128),
	`sentAt` timestamp,
	`acceptedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `proposals_id` PRIMARY KEY(`id`),
	CONSTRAINT `proposals_shareToken_unique` UNIQUE(`shareToken`),
	CONSTRAINT `ix_prop_token` UNIQUE(`shareToken`)
);
--> statement-breakpoint
CREATE INDEX `ix_pf_proposal` ON `proposal_feedback` (`proposalId`);--> statement-breakpoint
CREATE INDEX `ix_pm_proposal` ON `proposal_milestones` (`proposalId`);--> statement-breakpoint
CREATE INDEX `ix_ps_proposal` ON `proposal_sections` (`proposalId`);--> statement-breakpoint
CREATE INDEX `ix_prop_ws` ON `proposals` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_prop_creator` ON `proposals` (`workspaceId`,`createdBy`);