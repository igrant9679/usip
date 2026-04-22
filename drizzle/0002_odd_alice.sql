CREATE TABLE `lead_routing_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`priority` int NOT NULL DEFAULT 100,
	`enabled` boolean NOT NULL DEFAULT true,
	`conditions` json NOT NULL,
	`strategy` enum('round_robin','geography','industry','direct') NOT NULL,
	`targetUserIds` json,
	`rrCursor` int NOT NULL DEFAULT 0,
	`matchCount` int NOT NULL DEFAULT 0,
	`lastMatchedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lead_routing_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lead_score_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`firmoOrgTypeWeight` int NOT NULL DEFAULT 15,
	`firmoTitleWeight` int NOT NULL DEFAULT 15,
	`firmoCompletenessWeight` int NOT NULL DEFAULT 10,
	`behavOpenPoints` int NOT NULL DEFAULT 5,
	`behavOpenMax` int NOT NULL DEFAULT 15,
	`behavClickPoints` int NOT NULL DEFAULT 10,
	`behavClickMax` int NOT NULL DEFAULT 20,
	`behavReplyPoints` int NOT NULL DEFAULT 25,
	`behavStepPoints` int NOT NULL DEFAULT 3,
	`behavBouncePenalty` int NOT NULL DEFAULT -10,
	`behavUnsubPenalty` int NOT NULL DEFAULT -15,
	`behavDecayPctPer30d` int NOT NULL DEFAULT 10,
	`aiFitMax` int NOT NULL DEFAULT 30,
	`tierWarmMin` int NOT NULL DEFAULT 31,
	`tierHotMin` int NOT NULL DEFAULT 61,
	`tierSalesReadyMin` int NOT NULL DEFAULT 81,
	`notifyOnSalesReady` boolean NOT NULL DEFAULT true,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_score_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `lead_score_config_workspaceId_unique` UNIQUE(`workspaceId`)
);
--> statement-breakpoint
CREATE TABLE `lead_score_history` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`leadId` int NOT NULL,
	`firmographic` int NOT NULL,
	`behavioral` int NOT NULL,
	`aiFit` int NOT NULL,
	`total` int NOT NULL,
	`tier` varchar(16) NOT NULL,
	`aiFitPayload` json,
	`computedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `lead_score_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_lrr_ws` ON `lead_routing_rules` (`workspaceId`,`priority`);--> statement-breakpoint
CREATE INDEX `ix_lsh_lead` ON `lead_score_history` (`leadId`,`computedAt`);--> statement-breakpoint
CREATE INDEX `ix_lsh_ws` ON `lead_score_history` (`workspaceId`,`computedAt`);