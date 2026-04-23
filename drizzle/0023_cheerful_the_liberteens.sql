CREATE TABLE `calendar_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`provider` enum('google','outlook_caldav','apple_caldav','generic_caldav') NOT NULL,
	`label` varchar(120),
	`email` varchar(320),
	`oauthAccessToken` text,
	`oauthRefreshToken` text,
	`oauthTokenExpiry` timestamp,
	`oauthScope` text,
	`caldavUrl` varchar(500),
	`caldavUsername` varchar(320),
	`caldavPassword` text,
	`calendarId` varchar(500),
	`syncEnabled` boolean NOT NULL DEFAULT true,
	`lastSyncAt` timestamp,
	`lastSyncError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `calendar_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`calendarAccountId` int NOT NULL,
	`externalId` varchar(500) NOT NULL,
	`title` varchar(500) NOT NULL,
	`description` text,
	`location` varchar(500),
	`meetingUrl` varchar(1000),
	`startAt` timestamp NOT NULL,
	`endAt` timestamp NOT NULL,
	`allDay` boolean NOT NULL DEFAULT false,
	`attendees` json,
	`relatedType` varchar(30),
	`relatedId` int,
	`activityId` int,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `calendar_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_replies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`draftId` int,
	`sendingAccountId` int NOT NULL,
	`userId` int,
	`fromEmail` varchar(320) NOT NULL,
	`fromName` varchar(200),
	`subject` varchar(500),
	`bodyText` text,
	`bodyHtml` text,
	`messageId` varchar(500),
	`inReplyTo` varchar(500),
	`contactId` int,
	`leadId` int,
	`accountId` int,
	`imapUid` bigint,
	`gmailMessageId` varchar(200),
	`receivedAt` timestamp NOT NULL,
	`readAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_replies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `notifications` MODIFY COLUMN `kind` enum('mention','task_assigned','task_due','deal_won','deal_lost','renewal_due','churn_risk','approval_request','workflow_fired','system','email_reply') NOT NULL;--> statement-breakpoint
ALTER TABLE `sending_accounts` ADD `imapHost` varchar(255);--> statement-breakpoint
ALTER TABLE `sending_accounts` ADD `imapPort` int DEFAULT 993;--> statement-breakpoint
ALTER TABLE `sending_accounts` ADD `imapSecure` boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE `sending_accounts` ADD `imapUsername` varchar(255);--> statement-breakpoint
ALTER TABLE `sending_accounts` ADD `imapPassword` text;--> statement-breakpoint
CREATE INDEX `ix_ca_user` ON `calendar_accounts` (`workspaceId`,`userId`);--> statement-breakpoint
CREATE INDEX `ix_ce_user` ON `calendar_events` (`workspaceId`,`userId`);--> statement-breakpoint
CREATE INDEX `ix_ce_account` ON `calendar_events` (`calendarAccountId`);--> statement-breakpoint
CREATE INDEX `ix_ce_extid` ON `calendar_events` (`calendarAccountId`,`externalId`);--> statement-breakpoint
CREATE INDEX `ix_ce_range` ON `calendar_events` (`workspaceId`,`userId`,`startAt`,`endAt`);--> statement-breakpoint
CREATE INDEX `ix_er_ws` ON `email_replies` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_er_account` ON `email_replies` (`sendingAccountId`);--> statement-breakpoint
CREATE INDEX `ix_er_draft` ON `email_replies` (`draftId`);--> statement-breakpoint
CREATE INDEX `ix_er_msgid` ON `email_replies` (`messageId`);