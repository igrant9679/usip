ALTER TABLE `social_posts` ADD `recurrence` json;--> statement-breakpoint
ALTER TABLE `social_posts` ADD `parentPostId` int;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `notifEmail` varchar(320);--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `notifPrefs` json;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `slackWebhookUrl` text;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `teamsWebhookUrl` text;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `systemSenderAccountId` int;