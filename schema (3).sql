-- =====================================================================
-- SPENTRA database schema for MySQL 8.0+
-- Run:  mysql -u root -p < schema.sql
-- Money is stored as DECIMAL(14,2). Times are stored in UTC.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS spentra
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE spentra;

-- ---------------------------------------------------------------------
-- users: Spentra supports a single account. The UNIQUE singleton column
-- makes the database itself reject a second user.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  singleton       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  name            VARCHAR(60)  NOT NULL,
  email           VARCHAR(120) NOT NULL,
  password_hash   VARCHAR(100) NOT NULL,            -- bcrypt hash, never the password
  monthly_income  DECIMAL(14,2) NOT NULL,
  currency        CHAR(3)      NOT NULL DEFAULT 'INR',
  cycle_start     DATE         NOT NULL,            -- first day of the first 30-day cycle
  carry_forward   TINYINT(1)   NOT NULL DEFAULT 0,
  warn_80         TINYINT(1)   NOT NULL DEFAULT 1,
  last_morning    DATE NULL,                        -- scheduler bookkeeping
  last_night      DATE NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_single (singleton),
  CONSTRAINT ck_users_singleton CHECK (singleton = 1),
  CONSTRAINT ck_users_income    CHECK (monthly_income > 0),
  CONSTRAINT ck_users_currency  CHECK (currency IN ('INR','USD','EUR'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- transactions
-- Self transfers are stored but excluded from spending in queries.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id           CHAR(36)     NOT NULL,               -- UUID from the API
  user_id      BIGINT UNSIGNED NOT NULL,
  merchant     VARCHAR(60)  NOT NULL,
  amount       DECIMAL(14,2) NOT NULL,
  type         ENUM('Expense','Income','Refund','Self transfer') NOT NULL DEFAULT 'Expense',
  category     ENUM('Food & Dining','Groceries','Shopping','Transportation','Entertainment',
                    'Subscriptions','Healthcare','Education','Bills & Utilities','Travel',
                    'Random UPI Transfers','Other Expenses','Uncategorized UPI Payment')
               NOT NULL DEFAULT 'Uncategorized UPI Payment',
  method       ENUM('UPI','Card','Net banking','Cash') NOT NULL DEFAULT 'UPI',
  status       ENUM('Completed','Failed') NOT NULL DEFAULT 'Completed',
  occurred_at  DATETIME(3)  NOT NULL,               -- UTC
  reference    VARCHAR(80)  NULL,                   -- bank/provider reference, prevents re-import
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tx_reference (user_id, reference),  -- multiple NULLs are allowed
  KEY ix_tx_user_time (user_id, occurred_at),
  KEY ix_tx_user_type_time (user_id, type, occurred_at),
  CONSTRAINT fk_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT ck_tx_amount CHECK (amount > 0)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- category_rules: remembers user corrections per merchant (lowercase)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_rules (
  user_id   BIGINT UNSIGNED NOT NULL,
  merchant  VARCHAR(60) NOT NULL,
  category  ENUM('Food & Dining','Groceries','Shopping','Transportation','Entertainment',
                 'Subscriptions','Healthcare','Education','Bills & Utilities','Travel',
                 'Random UPI Transfers','Other Expenses','Uncategorized UPI Payment') NOT NULL,
  PRIMARY KEY (user_id, merchant),
  CONSTRAINT fk_rules_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- savings_goals
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS savings_goals (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(40)   NOT NULL,
  target_amount DECIMAL(14,2) NOT NULL,
  saved_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_goals_user (user_id),
  CONSTRAINT fk_goals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT ck_goals_target CHECK (target_amount > 0),
  CONSTRAINT ck_goals_saved  CHECK (saved_amount >= 0)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  message     VARCHAR(255) NOT NULL,
  is_read     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_notes_user_time (user_id, created_at),
  CONSTRAINT fk_notes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- penny_messages: chat history for the Penny assistant (used as context)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS penny_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('user','assistant') NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_penny_user (user_id, id),
  CONSTRAINT fk_penny_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Views
-- Budget days use a fixed +05:30 offset (India). Change it to match the
-- backend's TZ_OFFSET_MIN. Fixed offsets need no timezone tables.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_totals AS
SELECT
  user_id,
  DATE(CONVERT_TZ(occurred_at, '+00:00', '+05:30')) AS spend_date,
  SUM(CASE WHEN type = 'Expense' THEN amount ELSE 0 END)                  AS spent,
  SUM(CASE WHEN type IN ('Income','Refund') THEN amount ELSE 0 END)       AS received
FROM transactions
WHERE status = 'Completed' AND type <> 'Self transfer'
GROUP BY user_id, spend_date;

CREATE OR REPLACE VIEW v_category_totals AS
SELECT
  user_id,
  CASE WHEN category = 'Uncategorized UPI Payment' THEN 'Random UPI Transfers'
       ELSE category END AS category,
  DATE(CONVERT_TZ(occurred_at, '+00:00', '+05:30')) AS spend_date,
  SUM(amount) AS spent
FROM transactions
WHERE status = 'Completed' AND type = 'Expense'
GROUP BY user_id, category, spend_date;

-- ---------------------------------------------------------------------
-- Housekeeping: delete notifications older than 90 days, daily.
-- Requires:  SET GLOBAL event_scheduler = ON;
-- ---------------------------------------------------------------------
DROP EVENT IF EXISTS ev_purge_old_notifications;
CREATE EVENT ev_purge_old_notifications
  ON SCHEDULE EVERY 1 DAY
  DO DELETE FROM notifications WHERE created_at < NOW() - INTERVAL 90 DAY;

-- ---------------------------------------------------------------------
-- Least-privilege application user. CHANGE THE PASSWORD before running.
-- The app never needs DROP, ALTER or GRANT rights.
-- ---------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'spentra_app'@'localhost' IDENTIFIED BY 'CHANGE_ME_TO_A_STRONG_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE ON spentra.* TO 'spentra_app'@'localhost';
FLUSH PRIVILEGES;

-- ---------------------------------------------------------------------
-- Example queries (current 30-day cycle starting 2026-11-01)
-- ---------------------------------------------------------------------
-- Spent in the cycle:
--   SELECT COALESCE(SUM(amount),0) FROM transactions
--   WHERE user_id = 1 AND status = 'Completed' AND type = 'Expense'
--     AND occurred_at >= '2026-11-01' AND occurred_at < '2026-12-01';
-- Daily budget:  SELECT monthly_income / 30 FROM users WHERE id = 1;
