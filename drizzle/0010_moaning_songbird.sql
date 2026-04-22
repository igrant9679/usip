ALTER TABLE `contacts` ADD `emailVerificationStatus` varchar(20);--> statement-breakpoint
ALTER TABLE `contacts` ADD `emailVerifiedAt` timestamp;--> statement-breakpoint
ALTER TABLE `contacts` ADD `emailVerificationData` json;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `blockInvalidEmailsFromSequences` boolean DEFAULT false NOT NULL;