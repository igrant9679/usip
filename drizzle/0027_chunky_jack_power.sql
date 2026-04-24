ALTER TABLE `sequence_ab_variants` ADD `isWinner` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sequence_ab_variants` ADD `promotedAt` timestamp;--> statement-breakpoint
ALTER TABLE `sequence_ab_variants` ADD `minSendsForPromotion` int DEFAULT 10 NOT NULL;