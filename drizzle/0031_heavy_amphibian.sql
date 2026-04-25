CREATE TABLE `login_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`workspaceId` int,
	`ipAddress` varchar(64),
	`userAgent` text,
	`outcome` enum('success','failed','expired_invite') NOT NULL DEFAULT 'success',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `login_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `inviteToken` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `inviteExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_settings` ADD `inviteExpiryDays` int DEFAULT 7;--> statement-breakpoint
CREATE INDEX `ix_lh_user` ON `login_history` (`userId`);--> statement-breakpoint
CREATE INDEX `ix_lh_ws` ON `login_history` (`workspaceId`);