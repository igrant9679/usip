CREATE TABLE `email_suppressions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`email` varchar(320) NOT NULL,
	`reason` enum('unsubscribe','bounce','spam_complaint','manual') NOT NULL,
	`draftId` int,
	`contactId` int,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_suppressions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_sup_ws` ON `email_suppressions` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_sup_email` ON `email_suppressions` (`email`);--> statement-breakpoint
CREATE INDEX `ix_sup_uniq` ON `email_suppressions` (`workspaceId`,`email`,`reason`);