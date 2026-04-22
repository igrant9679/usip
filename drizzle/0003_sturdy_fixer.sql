CREATE TABLE `usage_counters` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`month` varchar(7) NOT NULL,
	`llmTokens` int NOT NULL DEFAULT 0,
	`emailsSent` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `usage_counters_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_uc_ws_month` UNIQUE(`workspaceId`,`month`)
);
--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`workspaceId` int NOT NULL,
	`timezone` varchar(64) NOT NULL DEFAULT 'UTC',
	`brandPrimary` varchar(16) NOT NULL DEFAULT '#14B89A',
	`brandAccent` varchar(16) NOT NULL DEFAULT '#0F766E',
	`emailFromName` varchar(120),
	`emailSignature` text,
	`sessionTimeoutMin` int NOT NULL DEFAULT 480,
	`ipAllowlist` json,
	`enforce2fa` boolean NOT NULL DEFAULT false,
	`notifyPolicy` json,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_settings_workspaceId` PRIMARY KEY(`workspaceId`)
);
--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `deactivatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `lastActiveAt` timestamp;