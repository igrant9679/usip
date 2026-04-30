-- Migration 0053: add readingTimeMinutes and pageKeys to help_articles, add archived status
ALTER TABLE `help_articles`
  ADD COLUMN `readingTimeMinutes` int NULL AFTER `pageKey`,
  ADD COLUMN `pageKeys` json NULL AFTER `readingTimeMinutes`,
  MODIFY COLUMN `status` enum('draft','published','archived') NOT NULL DEFAULT 'draft';
