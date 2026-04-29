-- Migration 0051: Help Center + Guided Tour Learning Layer

-- Help categories
CREATE TABLE `help_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `icon` varchar(64) NOT NULL DEFAULT 'BookOpen',
  `sortOrder` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_hcat_ws` (`workspaceId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Help articles
CREATE TABLE `help_articles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `categoryId` int,
  `slug` varchar(200) NOT NULL,
  `title` varchar(300) NOT NULL,
  `summary` text,
  `bodyMarkdown` longtext,
  `tags` json,
  `status` enum('draft','published') NOT NULL DEFAULT 'draft',
  `associatedTourId` int,
  `authorId` int,
  `viewCount` int NOT NULL DEFAULT 0,
  `helpfulCount` int NOT NULL DEFAULT 0,
  `notHelpfulCount` int NOT NULL DEFAULT 0,
  `pageKey` varchar(120),
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_ha_ws_slug` (`workspaceId`, `slug`),
  INDEX `ix_ha_ws` (`workspaceId`),
  INDEX `ix_ha_cat` (`categoryId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Help search log (for insights)
CREATE TABLE `help_search_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `query` varchar(500) NOT NULL,
  `resultsCount` int NOT NULL DEFAULT 0,
  `clickedResultId` int,
  `satisfied` tinyint(1),
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_hsl_ws` (`workspaceId`),
  INDEX `ix_hsl_user` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- AI help conversations
CREATE TABLE `ai_help_conversations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `startedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lastMessageAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_ahc_ws_user` (`workspaceId`, `userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- AI help messages
CREATE TABLE `ai_help_messages` (
  `id` int NOT NULL AUTO_INCREMENT,
  `conversationId` int NOT NULL,
  `role` enum('user','assistant') NOT NULL,
  `body` text NOT NULL,
  `citedArticleIds` json,
  `confidence` decimal(5,2),
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_ahm_conv` (`conversationId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tours
CREATE TABLE `tours` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `name` varchar(200) NOT NULL,
  `description` text,
  `type` enum('onboarding','feature','whats_new','custom') NOT NULL DEFAULT 'feature',
  `roleTags` json,
  `estimatedMinutes` int NOT NULL DEFAULT 3,
  `prerequisiteTourId` int,
  `status` enum('draft','published') NOT NULL DEFAULT 'draft',
  `createdBy` int,
  `pageKey` varchar(120),
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_tours_ws` (`workspaceId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tour steps
CREATE TABLE `tour_steps` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tourId` int NOT NULL,
  `sortOrder` int NOT NULL DEFAULT 0,
  `targetSelector` varchar(500),
  `targetDataTourId` varchar(200),
  `title` varchar(300) NOT NULL,
  `bodyMarkdown` text,
  `visualTreatment` enum('spotlight','pulse','arrow','coach') NOT NULL DEFAULT 'spotlight',
  `advanceCondition` enum('next_button','element_clicked','form_field_filled','route_changed','custom_event') NOT NULL DEFAULT 'next_button',
  `advanceConfig` json,
  `skipAllowed` tinyint(1) NOT NULL DEFAULT 1,
  `backAllowed` tinyint(1) NOT NULL DEFAULT 1,
  `branchingRules` json,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_ts_tour` (`tourId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User tour progress
CREATE TABLE `user_tour_progress` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `tourId` int NOT NULL,
  `status` enum('not_started','in_progress','completed','skipped') NOT NULL DEFAULT 'not_started',
  `currentStep` int NOT NULL DEFAULT 0,
  `startedAt` timestamp,
  `completedAt` timestamp,
  `lastResumedAt` timestamp,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_utp_user_tour` (`userId`, `tourId`),
  INDEX `ix_utp_ws` (`workspaceId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User learning preferences
CREATE TABLE `user_learning_preferences` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `showCoachMascot` tinyint(1) NOT NULL DEFAULT 1,
  `showProactiveHints` tinyint(1) NOT NULL DEFAULT 1,
  `completedOnboarding` tinyint(1) NOT NULL DEFAULT 0,
  `preferredTourSpeed` enum('slow','normal','fast') NOT NULL DEFAULT 'normal',
  `dontShowHints` tinyint(1) NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_ulp_ws_user` (`workspaceId`, `userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Article feedback
CREATE TABLE `help_article_feedback` (
  `id` int NOT NULL AUTO_INCREMENT,
  `articleId` int NOT NULL,
  `userId` int NOT NULL,
  `helpful` tinyint(1) NOT NULL,
  `comment` text,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_haf_article` (`articleId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tour completion achievements
CREATE TABLE `tour_achievements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `tourId` int NOT NULL,
  `badge` varchar(120),
  `earnedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `ix_ta_ws_user` (`workspaceId`, `userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
