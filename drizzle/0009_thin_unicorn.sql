CREATE TABLE `contact_import_rows` (
	`id` int AUTO_INCREMENT NOT NULL,
	`importId` int NOT NULL,
	`rowIndex` int NOT NULL,
	`rowData` json NOT NULL,
	`mappedData` json,
	`status` enum('pending','valid','duplicate','error','imported','skipped') NOT NULL DEFAULT 'pending',
	`errorReason` text,
	`contactId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `contact_import_rows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contact_imports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`filename` varchar(255) NOT NULL,
	`fileKey` text,
	`status` enum('pending','validating','ready','importing','completed','failed') NOT NULL DEFAULT 'pending',
	`totalRows` int NOT NULL DEFAULT 0,
	`importedRows` int NOT NULL DEFAULT 0,
	`skippedRows` int NOT NULL DEFAULT 0,
	`errorRows` int NOT NULL DEFAULT 0,
	`fieldMapping` json,
	`postImportActions` json,
	`ownerId` int NOT NULL,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contact_imports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_verification_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`reoonTaskId` varchar(64),
	`status` enum('pending','running','completed','failed') NOT NULL DEFAULT 'pending',
	`totalEmails` int NOT NULL DEFAULT 0,
	`checkedEmails` int NOT NULL DEFAULT 0,
	`progressPct` decimal(5,2) DEFAULT '0',
	`triggeredByUserId` int NOT NULL,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_verification_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `linkedin_connections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`workspaceId` int NOT NULL,
	`accessToken` text NOT NULL,
	`tokenExpiry` timestamp,
	`linkedinId` varchar(64),
	`displayName` varchar(200),
	`profileUrl` text,
	`syncedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `linkedin_connections_id` PRIMARY KEY(`id`),
	CONSTRAINT `linkedin_connections_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE INDEX `ix_cir_import` ON `contact_import_rows` (`importId`);--> statement-breakpoint
CREATE INDEX `ix_cir_status` ON `contact_import_rows` (`importId`,`status`);--> statement-breakpoint
CREATE INDEX `ix_ci_ws` ON `contact_imports` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_ci_owner` ON `contact_imports` (`ownerId`);--> statement-breakpoint
CREATE INDEX `ix_evj_ws` ON `email_verification_jobs` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_lc_ws` ON `linkedin_connections` (`workspaceId`);