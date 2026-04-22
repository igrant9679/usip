CREATE TABLE `dashboard_layouts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`userId` int NOT NULL,
	`dashboardId` int NOT NULL,
	`layout` json NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dashboard_layouts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_dl_ws_user_dash` UNIQUE(`workspaceId`,`userId`,`dashboardId`)
);
--> statement-breakpoint
CREATE TABLE `sequence_edges` (
	`id` varchar(64) NOT NULL,
	`sequenceId` int NOT NULL,
	`workspaceId` int NOT NULL,
	`source` varchar(64) NOT NULL,
	`target` varchar(64) NOT NULL,
	`sourceHandle` varchar(32),
	`label` varchar(64),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sequence_edges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sequence_nodes` (
	`id` varchar(64) NOT NULL,
	`sequenceId` int NOT NULL,
	`workspaceId` int NOT NULL,
	`type` enum('start','email','wait','condition','action','goal') NOT NULL,
	`positionX` int NOT NULL DEFAULT 0,
	`positionY` int NOT NULL DEFAULT 0,
	`data` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sequence_nodes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_integrations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`provider` varchar(64) NOT NULL,
	`status` enum('connected','disconnected','error') NOT NULL DEFAULT 'disconnected',
	`config` json,
	`lastTestedAt` timestamp,
	`lastTestResult` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_integrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_wi_ws_prov` UNIQUE(`workspaceId`,`provider`)
);
--> statement-breakpoint
CREATE INDEX `ix_dl_ws` ON `dashboard_layouts` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_se_seq` ON `sequence_edges` (`sequenceId`);--> statement-breakpoint
CREATE INDEX `ix_sn_seq` ON `sequence_nodes` (`sequenceId`);--> statement-breakpoint
CREATE INDEX `ix_sn_ws` ON `sequence_nodes` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_wi_ws` ON `workspace_integrations` (`workspaceId`);