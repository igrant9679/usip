CREATE TABLE `email_saved_sections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` varchar(500),
	`category` enum('layout','header','footer','cta','testimonial','pricing','custom') NOT NULL DEFAULT 'custom',
	`blocks` json NOT NULL,
	`previewHtml` text,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_saved_sections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_ess_ws` ON `email_saved_sections` (`workspaceId`,`category`);--> statement-breakpoint
CREATE INDEX `ix_ess_creator` ON `email_saved_sections` (`createdByUserId`);