CREATE TABLE `are_ab_variants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`campaignId` int NOT NULL,
	`stepIndex` int NOT NULL,
	`variantKey` varchar(8) NOT NULL,
	`hookType` varchar(64),
	`subjectLine` varchar(240),
	`bodyPreview` text,
	`sentCount` int NOT NULL DEFAULT 0,
	`openCount` int NOT NULL DEFAULT 0,
	`replyCount` int NOT NULL DEFAULT 0,
	`meetingCount` int NOT NULL DEFAULT 0,
	`isWinner` boolean NOT NULL DEFAULT false,
	`promotedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `are_ab_variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `ix_aav_variant` UNIQUE(`campaignId`,`stepIndex`,`variantKey`)
);
--> statement-breakpoint
CREATE TABLE `are_campaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`status` enum('draft','active','paused','completed') NOT NULL DEFAULT 'draft',
	`autonomyMode` enum('full','batch_approval','review_release') NOT NULL DEFAULT 'batch_approval',
	`icpProfileId` int,
	`icpOverrides` json,
	`prospectSources` json,
	`targetProspectCount` int NOT NULL DEFAULT 100,
	`dailySendCap` int NOT NULL DEFAULT 50,
	`channelsEnabled` json,
	`sequenceTemplate` varchar(64) NOT NULL DEFAULT 'standard_7step',
	`goalType` enum('meeting_booked','reply','opportunity_created') NOT NULL DEFAULT 'reply',
	`prospectsDiscovered` int NOT NULL DEFAULT 0,
	`prospectsEnriched` int NOT NULL DEFAULT 0,
	`prospectsApproved` int NOT NULL DEFAULT 0,
	`prospectsEnrolled` int NOT NULL DEFAULT 0,
	`prospectsContacted` int NOT NULL DEFAULT 0,
	`prospectsReplied` int NOT NULL DEFAULT 0,
	`meetingsBooked` int NOT NULL DEFAULT 0,
	`opportunitiesCreated` int NOT NULL DEFAULT 0,
	`ownerUserId` int,
	`startedAt` timestamp,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `are_campaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `are_execution_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`campaignId` int NOT NULL,
	`prospectQueueId` int NOT NULL,
	`stepIndex` int NOT NULL,
	`channel` enum('email','linkedin','sms','voice') NOT NULL,
	`scheduledAt` timestamp NOT NULL,
	`executedAt` timestamp,
	`status` enum('scheduled','sent','failed','skipped','paused') NOT NULL DEFAULT 'scheduled',
	`messageContent` json,
	`externalId` varchar(256),
	`failureReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `are_execution_queue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `are_scrape_jobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`campaignId` int,
	`sourceType` enum('google_business','linkedin_company','linkedin_people','web_scrape','news','industry_events') NOT NULL,
	`query` text NOT NULL,
	`status` enum('pending','running','complete','failed') NOT NULL DEFAULT 'pending',
	`resultCount` int NOT NULL DEFAULT 0,
	`rawResults` json,
	`errorMessage` text,
	`scrapedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `are_scrape_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `are_signal_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`executionQueueId` int,
	`prospectQueueId` int NOT NULL,
	`campaignId` int NOT NULL,
	`signalType` enum('email_open','email_click','email_reply','email_bounce','email_unsubscribe','linkedin_accepted','linkedin_reply','sms_reply','sms_unsubscribe','voice_connected_interested','voice_connected_not_interested','voice_voicemail','voice_no_answer','meeting_booked','opportunity_created') NOT NULL,
	`rawPayload` json,
	`sentiment` enum('positive','neutral','negative','objection'),
	`sentimentReason` text,
	`processedAt` timestamp NOT NULL DEFAULT (now()),
	`actionTaken` varchar(120),
	CONSTRAINT `are_signal_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `are_suppression_list` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`email` varchar(320),
	`linkedinUrl` text,
	`companyDomain` varchar(200),
	`reason` enum('unsubscribe','bounce','competitor','existing_customer','manual','do_not_contact') NOT NULL,
	`addedByUserId` int,
	`addedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `are_suppression_list_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `icp_profiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`targetIndustries` json,
	`targetCompanySizeMin` int,
	`targetCompanySizeMax` int,
	`targetRevenueMin` decimal(18,2),
	`targetRevenueMax` decimal(18,2),
	`targetTitles` json,
	`targetGeographies` json,
	`targetTechStack` json,
	`antiPatterns` json,
	`avgDealValue` decimal(14,2),
	`avgSalesCycleDays` int,
	`topConversionSignals` json,
	`confidenceScore` int NOT NULL DEFAULT 0,
	`sampleWonDeals` int NOT NULL DEFAULT 0,
	`aiRationale` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `icp_profiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `prospect_intelligence` (
	`id` int AUTO_INCREMENT NOT NULL,
	`prospectQueueId` int NOT NULL,
	`workspaceId` int NOT NULL,
	`triggerEvents` json,
	`painSignals` json,
	`relationshipPaths` json,
	`personalisationHooks` json,
	`techStack` json,
	`recentNews` json,
	`industryEvents` json,
	`googleBusinessData` json,
	`linkedinSummary` text,
	`companyOneLiner` text,
	`recommendedChannel` enum('email','linkedin','sms','voice') NOT NULL DEFAULT 'email',
	`recommendedTiming` json,
	`enrichmentConfidence` int NOT NULL DEFAULT 0,
	`generatedSequence` json,
	`sequenceQualityScore` int,
	`sequenceQualityBreakdown` json,
	`sequenceRewriteCount` int NOT NULL DEFAULT 0,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prospect_intelligence_id` PRIMARY KEY(`id`),
	CONSTRAINT `prospect_intelligence_prospectQueueId_unique` UNIQUE(`prospectQueueId`)
);
--> statement-breakpoint
CREATE TABLE `prospect_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` int NOT NULL,
	`campaignId` int NOT NULL,
	`sourceType` enum('internal_contact','internal_lead','google_business','linkedin_company','linkedin_people','web_scrape','news_event','industry_event','apollo','zoominfo','clay','ai_research') NOT NULL,
	`sourceId` varchar(256),
	`sourceUrl` text,
	`firstName` varchar(80),
	`lastName` varchar(80),
	`email` varchar(320),
	`linkedinUrl` text,
	`phone` varchar(40),
	`title` varchar(120),
	`companyName` varchar(200),
	`companyDomain` varchar(200),
	`companySize` varchar(40),
	`industry` varchar(80),
	`geography` varchar(120),
	`icpMatchScore` int NOT NULL DEFAULT 0,
	`icpMatchBreakdown` json,
	`enrichmentStatus` enum('pending','enriching','complete','failed') NOT NULL DEFAULT 'pending',
	`enrichedAt` timestamp,
	`sequenceStatus` enum('pending','approved','enrolled','skipped','completed','replied') NOT NULL DEFAULT 'pending',
	`approvedAt` timestamp,
	`approvedByUserId` int,
	`linkedContactId` int,
	`linkedOpportunityId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prospect_queue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ix_aav_campaign` ON `are_ab_variants` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_arec_ws` ON `are_campaigns` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_arec_status` ON `are_campaigns` (`workspaceId`,`status`);--> statement-breakpoint
CREATE INDEX `ix_aeq_campaign` ON `are_execution_queue` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_aeq_prospect` ON `are_execution_queue` (`prospectQueueId`);--> statement-breakpoint
CREATE INDEX `ix_aeq_scheduled` ON `are_execution_queue` (`workspaceId`,`status`,`scheduledAt`);--> statement-breakpoint
CREATE INDEX `ix_asj_ws` ON `are_scrape_jobs` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_asj_campaign` ON `are_scrape_jobs` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_asl_prospect` ON `are_signal_log` (`prospectQueueId`);--> statement-breakpoint
CREATE INDEX `ix_asl_campaign` ON `are_signal_log` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_asl_type` ON `are_signal_log` (`workspaceId`,`signalType`);--> statement-breakpoint
CREATE INDEX `ix_asupp_ws` ON `are_suppression_list` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_asupp_email` ON `are_suppression_list` (`workspaceId`,`email`);--> statement-breakpoint
CREATE INDEX `ix_icp_ws` ON `icp_profiles` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_icp_ws_ver` ON `icp_profiles` (`workspaceId`,`version`);--> statement-breakpoint
CREATE INDEX `ix_pi_prospect` ON `prospect_intelligence` (`prospectQueueId`);--> statement-breakpoint
CREATE INDEX `ix_pi_ws` ON `prospect_intelligence` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_pq_campaign` ON `prospect_queue` (`campaignId`);--> statement-breakpoint
CREATE INDEX `ix_pq_ws` ON `prospect_queue` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `ix_pq_email` ON `prospect_queue` (`email`);--> statement-breakpoint
CREATE INDEX `ix_pq_status` ON `prospect_queue` (`campaignId`,`enrichmentStatus`);