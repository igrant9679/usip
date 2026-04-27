CREATE TABLE `page_descriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pageKey` varchar(100) NOT NULL,
	`description` text NOT NULL,
	`updatedByUserId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `page_descriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `page_descriptions_pageKey_unique` UNIQUE(`pageKey`)
);
--> statement-breakpoint
CREATE INDEX `ix_pd_key` ON `page_descriptions` (`pageKey`);