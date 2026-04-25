CREATE TABLE `member_permissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`feature` varchar(80) NOT NULL,
	`granted` boolean NOT NULL DEFAULT true,
	`grantedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `member_permissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `ix_mp_uniq` UNIQUE(`workspaceId`,`userId`,`feature`)
);
--> statement-breakpoint
CREATE INDEX `ix_mp_user` ON `member_permissions` (`workspaceId`,`userId`);