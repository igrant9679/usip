ALTER TABLE `email_drafts` ADD `bouncedAt` timestamp;--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `bounceType` enum('hard','soft','spam');--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `bounceMessage` varchar(512);