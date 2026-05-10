-- 0057_unipile_bridge.sql
-- Phase 1 of Option-2 Unipile-everywhere: bridge Unipile-connected
-- accounts (LinkedIn-only today, Outlook/M365 mail + calendar via Phase 2/3)
-- into the same /mailbox and /calendar UIs by adding a foreign-key column
-- to the existing sending_accounts and calendar_accounts tables.
--
-- A bridged row is identifiable by `unipileAccountId IS NOT NULL`. When set,
-- IMAP/SMTP/CalDAV credential fields are NULL and the adapter factory
-- routes calls through the Unipile API instead. The provider enum value
-- on bridged rows is one of the existing values (e.g. 'outlook_oauth') —
-- the unipileAccountId column is the actual discriminator the adapter
-- factory reads, so the enum doesn't need to be widened. (An earlier
-- iteration of this migration tried to add a 'unipile_microsoft' enum
-- value via MODIFY COLUMN; that triggered MySQL strict-mode errno 1265
-- "Data truncated" on production, so the approach was changed.)
ALTER TABLE `sending_accounts`
  ADD COLUMN `unipileAccountId` varchar(64) NULL;

ALTER TABLE `calendar_accounts`
  ADD COLUMN `unipileAccountId` varchar(64) NULL;
