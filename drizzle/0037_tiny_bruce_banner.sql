CREATE TABLE `proposal_score_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proposalId` int NOT NULL,
	`score` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `proposal_score_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_psh_proposal` ON `proposal_score_history` (`proposalId`);--> statement-breakpoint
CREATE INDEX `ix_psh_proposal_date` ON `proposal_score_history` (`proposalId`,`createdAt`);