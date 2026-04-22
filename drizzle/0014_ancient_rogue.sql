ALTER TABLE `email_drafts` MODIFY COLUMN `status` enum('pending_review','approved','rejected','sent','ai_pending_review') NOT NULL DEFAULT 'pending_review';--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `pipelineJobId` int;--> statement-breakpoint
ALTER TABLE `email_drafts` ADD `tone` varchar(64);--> statement-breakpoint
ALTER TABLE `sequences` ADD `enrollmentTrigger` json;--> statement-breakpoint
ALTER TABLE `sequences` ADD `dailyCap` int;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `archivedAt` timestamp;