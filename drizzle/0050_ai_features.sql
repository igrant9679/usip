-- Migration 0050: AI capability gaps
-- 1. Renewals: churn-risk AI score on customers
ALTER TABLE customers
  ADD COLUMN churnRiskScore    INT           NULL COMMENT '0-100 AI churn risk score',
  ADD COLUMN churnRiskLabel    VARCHAR(16)   NULL COMMENT 'low|medium|high|critical',
  ADD COLUMN churnRiskRationale TEXT          NULL COMMENT 'One-sentence AI rationale',
  ADD COLUMN churnRiskScoredAt TIMESTAMP     NULL;

-- 2. Leads: AI next-action suggestion
ALTER TABLE leads
  ADD COLUMN aiNextAction      VARCHAR(40)   NULL COMMENT 'call|email|linkedin|wait',
  ADD COLUMN aiNextActionNote  TEXT          NULL COMMENT 'Brief rationale',
  ADD COLUMN aiNextActionAt    TIMESTAMP     NULL;

-- 3. Contacts: relationship strength
ALTER TABLE contacts
  ADD COLUMN relStrengthScore  INT           NULL COMMENT '0-100',
  ADD COLUMN relStrengthLabel  VARCHAR(16)   NULL COMMENT 'cold|warm|active|strong',
  ADD COLUMN relStrengthAt     TIMESTAMP     NULL;

-- 4. Quotes: AI pricing recommendation
ALTER TABLE quotes
  ADD COLUMN aiPriceMin        DECIMAL(14,2) NULL,
  ADD COLUMN aiPriceMax        DECIMAL(14,2) NULL,
  ADD COLUMN aiDiscountCeil    DECIMAL(5,2)  NULL COMMENT 'Max recommended discount %',
  ADD COLUMN aiPriceRationale  TEXT          NULL,
  ADD COLUMN aiPriceScoredAt   TIMESTAMP     NULL;

-- 5. Workspace settings: email auto-send toggle
ALTER TABLE workspace_settings
  ADD COLUMN aiAutoSendEnabled      BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Auto-approve+send AI pipeline drafts without human review',
  ADD COLUMN aiAutoSendScoreMin     INT     NOT NULL DEFAULT 70    COMMENT 'Min lead score to auto-send',
  ADD COLUMN aiAutoSendConfidenceMin INT    NOT NULL DEFAULT 75    COMMENT 'Min AI confidence to auto-send';

-- 6. AI workflow suggestions table
CREATE TABLE ai_workflow_suggestions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  workspaceId   INT          NOT NULL,
  title         VARCHAR(200) NOT NULL,
  description   TEXT         NOT NULL,
  triggerType   VARCHAR(60)  NOT NULL,
  triggerConfig JSON         NOT NULL,
  conditions    JSON         NOT NULL,
  actions       JSON         NOT NULL,
  dismissed     BOOLEAN      NOT NULL DEFAULT FALSE,
  appliedRuleId INT          NULL,
  generatedAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX ix_aiws_ws (workspaceId)
);

-- 7. Forecast AI commentary table
CREATE TABLE forecast_ai_commentary (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  workspaceId  INT       NOT NULL,
  periodLabel  VARCHAR(20) NOT NULL COMMENT 'e.g. 2026-05',
  commentary   TEXT      NOT NULL,
  highlights   JSON      NULL COMMENT '[{label, value, sentiment}]',
  generatedAt  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX ix_fac_ws (workspaceId, periodLabel)
);

-- 8. Mailbox AI triage labels (per thread/message, keyed by threadId+accountId)
CREATE TABLE mailbox_ai_triage (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  workspaceId  INT          NOT NULL,
  accountId    INT          NOT NULL,
  threadId     VARCHAR(255) NOT NULL,
  triageLabel  VARCHAR(20)  NOT NULL COMMENT 'urgent|follow_up|fyi|no_action',
  confidence   INT          NOT NULL DEFAULT 80,
  rationale    TEXT         NULL,
  labelledAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_triage (workspaceId, accountId, threadId),
  INDEX ix_triage_ws (workspaceId, accountId)
);
