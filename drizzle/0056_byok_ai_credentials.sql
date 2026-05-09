-- 0056_byok_ai_credentials.sql
-- BYOK: per-workspace AI provider credentials. API keys are stored as
-- AES-256-GCM ciphertext (`iv:ciphertext:authTag` hex). See server/_core/crypto.ts.
ALTER TABLE `workspace_settings`
  ADD COLUMN `anthropicApiKeyEnc` text NULL,
  ADD COLUMN `openaiApiKeyEnc` text NULL,
  ADD COLUMN `geminiApiKeyEnc` text NULL,
  ADD COLUMN `anthropicModel` varchar(128) NULL,
  ADD COLUMN `openaiModel` varchar(128) NULL,
  ADD COLUMN `geminiModel` varchar(128) NULL,
  ADD COLUMN `aiDefaultProvider` varchar(32) NULL;
