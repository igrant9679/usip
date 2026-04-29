-- Migration 0049: Add suggestedStage and suggestedStageRationale to opportunity_intelligence
ALTER TABLE `opportunity_intelligence`
  ADD COLUMN `suggestedStage` VARCHAR(64) NULL,
  ADD COLUMN `suggestedStageRationale` TEXT NULL;
