ALTER TABLE `workspace_settings` ADD `autoExtendOnOpen` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `autoExtendDays` int DEFAULT 7 NOT NULL;