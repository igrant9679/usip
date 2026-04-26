CREATE TABLE `proposal_revisions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proposalId` int NOT NULL,
	`sectionKey` varchar(64) NOT NULL,
	`content` text NOT NULL,
	`savedByUserId` int,
	`savedByName` varchar(120),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `proposal_revisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `proposals` ADD `linkedOpportunityId` int;--> statement-breakpoint
CREATE INDEX `ix_pr_proposal` ON `proposal_revisions` (`proposalId`);--> statement-breakpoint
CREATE INDEX `ix_pr_section` ON `proposal_revisions` (`proposalId`,`sectionKey`);