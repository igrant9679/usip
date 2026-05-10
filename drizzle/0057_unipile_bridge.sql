-- 0057_unipile_bridge.sql
-- Phase 1 of Option-2 Unipile-everywhere: bridge Unipile-connected accounts
-- (LinkedIn-only today, M365 Microsoft-mail/calendar coming) into the same
-- mailbox/calendar UI surfaces by adding a foreign-key column to the
-- existing sending_accounts and calendar_accounts tables.
--
-- A bridged row is identifiable by `unipileAccountId IS NOT NULL`. When set,
-- IMAP/SMTP/CalDAV credential fields are NULL and the adapter factory
-- routes calls through the Unipile API instead.
--
-- New provider enum values (`unipile_microsoft`) are added so type-narrowing
-- in the dispatcher works; legacy values are preserved untouched so existing
-- IMAP/SMTP/CalDAV accounts keep working in parallel.
ALTER TABLE `sending_accounts`
  ADD COLUMN `unipileAccountId` varchar(64) NULL;

ALTER TABLE `sending_accounts`
  MODIFY COLUMN `provider` enum(
    'outlook_oauth',
    'amazon_ses',
    'generic_smtp',
    'unipile_microsoft'
  ) NOT NULL;

ALTER TABLE `calendar_accounts`
  ADD COLUMN `unipileAccountId` varchar(64) NULL;

ALTER TABLE `calendar_accounts`
  MODIFY COLUMN `provider` enum(
    'outlook_oauth',
    'outlook_caldav',
    'apple_caldav',
    'generic_caldav',
    'unipile_microsoft'
  ) NOT NULL;
