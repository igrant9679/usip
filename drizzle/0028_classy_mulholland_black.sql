CREATE TABLE `unipile_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`unipileAccountId` varchar(200) NOT NULL,
	`provider` varchar(30) NOT NULL,
	`displayName` varchar(200),
	`profilePicture` varchar(1000),
	`status` varchar(30) NOT NULL DEFAULT 'CONNECTING',
	`connectedAt` timestamp,
	`lastSyncAt` timestamp,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `unipile_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `unipile_invites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`unipileAccountId` varchar(200) NOT NULL,
	`recipientProviderId` varchar(500) NOT NULL,
	`recipientName` varchar(200),
	`message` text,
	`status` varchar(20) NOT NULL DEFAULT 'pending',
	`linkedContactId` int,
	`linkedLeadId` int,
	`activityId` int,
	`sentAt` timestamp NOT NULL DEFAULT (now()),
	`acceptedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `unipile_invites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `unipile_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`unipileAccountId` varchar(200) NOT NULL,
	`provider` varchar(30) NOT NULL,
	`chatId` varchar(500) NOT NULL,
	`messageId` varchar(500) NOT NULL,
	`direction` varchar(10) NOT NULL,
	`senderName` varchar(200),
	`senderProviderId` varchar(500),
	`recipientName` varchar(200),
	`recipientProviderId` varchar(500),
	`text` text,
	`attachmentUrl` varchar(1000),
	`linkedContactId` int,
	`linkedLeadId` int,
	`linkedOpportunityId` int,
	`activityId` int,
	`readAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `unipile_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_ua_user` ON `unipile_accounts` (`workspaceId`,`userId`);--> statement-breakpoint
CREATE INDEX `ix_ua_unipile_id` ON `unipile_accounts` (`unipileAccountId`);--> statement-breakpoint
CREATE INDEX `ix_ui_user` ON `unipile_invites` (`workspaceId`,`userId`);--> statement-breakpoint
CREATE INDEX `ix_ui_account` ON `unipile_invites` (`unipileAccountId`);--> statement-breakpoint
CREATE INDEX `ix_ui_contact` ON `unipile_invites` (`linkedContactId`);--> statement-breakpoint
CREATE INDEX `ix_um_account` ON `unipile_messages` (`workspaceId`,`unipileAccountId`);--> statement-breakpoint
CREATE INDEX `ix_um_chat` ON `unipile_messages` (`chatId`);--> statement-breakpoint
CREATE INDEX `ix_um_contact` ON `unipile_messages` (`linkedContactId`);--> statement-breakpoint
CREATE INDEX `ix_um_lead` ON `unipile_messages` (`linkedLeadId`);--> statement-breakpoint
CREATE INDEX `ix_um_msgid` ON `unipile_messages` (`messageId`);