CREATE TABLE `sender_pool_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`poolId` int NOT NULL,
	`accountId` int NOT NULL,
	`weight` int NOT NULL DEFAULT 10,
	`position` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sender_pool_members_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sender_pools` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` text,
	`rotationStrategy` enum('round_robin','weighted','random') NOT NULL DEFAULT 'round_robin',
	`lastUsedIndex` int NOT NULL DEFAULT 0,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sender_pools_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sending_account_daily_stats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`accountId` int NOT NULL,
	`date` varchar(10) NOT NULL,
	`sentCount` int NOT NULL DEFAULT 0,
	`bounceCount` int NOT NULL DEFAULT 0,
	`spamCount` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sending_account_daily_stats_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sending_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`provider` enum('gmail_oauth','outlook_oauth','amazon_ses','generic_smtp') NOT NULL,
	`fromEmail` varchar(320) NOT NULL,
	`fromName` varchar(120),
	`replyTo` varchar(320),
	`oauthAccessToken` text,
	`oauthRefreshToken` text,
	`oauthTokenExpiry` timestamp,
	`oauthScope` text,
	`smtpHost` varchar(255),
	`smtpPort` int DEFAULT 587,
	`smtpSecure` boolean DEFAULT false,
	`smtpUsername` varchar(255),
	`smtpPassword` text,
	`sesRegion` varchar(32),
	`dailySendLimit` int NOT NULL DEFAULT 500,
	`warmupStatus` enum('not_started','in_progress','complete') NOT NULL DEFAULT 'not_started',
	`bounceRate` varchar(10) NOT NULL DEFAULT '0',
	`spamRate` varchar(10) NOT NULL DEFAULT '0',
	`reputationTier` enum('excellent','good','fair','poor') NOT NULL DEFAULT 'excellent',
	`connectionStatus` enum('connected','error','untested') NOT NULL DEFAULT 'untested',
	`lastTestedAt` timestamp,
	`lastTestError` text,
	`enabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sending_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_spm_pool` ON `sender_pool_members` (`poolId`);--> statement-breakpoint
CREATE INDEX `ix_spm_acc` ON `sender_pool_members` (`accountId`);--> statement-breakpoint
CREATE INDEX `ix_spm_uniq` ON `sender_pool_members` (`poolId`,`accountId`);--> statement-breakpoint
CREATE INDEX `ix_sp_ws` ON `sender_pools` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_sads_acc` ON `sending_account_daily_stats` (`accountId`);--> statement-breakpoint
CREATE INDEX `ix_sads_date` ON `sending_account_daily_stats` (`accountId`,`date`);--> statement-breakpoint
CREATE INDEX `ix_sa_ws` ON `sending_accounts` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_sa_ws_email` ON `sending_accounts` (`workspaceId`,`fromEmail`);