ALTER TABLE `are_campaigns` ADD `autoApproveThreshold` int;--> statement-breakpoint
ALTER TABLE `are_campaigns` ADD `signalToOpportunityEnabled` boolean DEFAULT false NOT NULL;