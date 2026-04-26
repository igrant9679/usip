ALTER TABLE `prospect_notes` ADD `category` varchar(32) DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE `prospect_notes` ADD `editedAt` timestamp;