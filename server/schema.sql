-- Money Manager — normalised backup / sync database (SQLite dialect)
-- Postgres notes: replace INTEGER PRIMARY KEY AUTOINCREMENT with GENERATED ALWAYS AS IDENTITY,
-- TEXT stays TEXT, and REAL becomes NUMERIC(18,2).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS user (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS currency (
  code        TEXT PRIMARY KEY,
  symbol      TEXT NOT NULL,
  name        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id     TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,            -- JSON blob of app preferences
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,          -- cash | bank | credit | debit | wallet | investment | fd | loan | property | vehicle | gold | other
  opening       REAL NOT NULL DEFAULT 0,
  currency_code TEXT NOT NULL DEFAULT 'INR' REFERENCES currency(code),
  colour        TEXT,
  icon          TEXT,
  credit_limit  REAL,
  due_day       INTEGER,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_account_user ON account(user_id);

CREATE TABLE IF NOT EXISTS category (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- expense | income
  icon        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_category_user ON category(user_id);

CREATE TABLE IF NOT EXISTS subcategory (
  id           TEXT PRIMARY KEY,
  category_id  TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_subcategory_category ON subcategory(category_id);

-- A transaction is the document; transaction_line holds its signed account movements,
-- so a transfer is one transaction with two lines that sum to zero.
CREATE TABLE IF NOT EXISTS txn (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  txn_date        TEXT NOT NULL,        -- YYYY-MM-DD
  kind            TEXT NOT NULL,        -- expense | income | transfer
  account_id      TEXT REFERENCES account(id) ON DELETE CASCADE,
  to_account_id   TEXT REFERENCES account(id) ON DELETE CASCADE,
  category_id     TEXT REFERENCES category(id) ON DELETE SET NULL,
  subcategory     TEXT,
  amount          REAL NOT NULL,
  contents        TEXT,
  details         TEXT,
  payment_method  TEXT,
  notes           TEXT,
  is_demo         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_txn_user_date ON txn(user_id, txn_date);
CREATE INDEX IF NOT EXISTS ix_txn_account ON txn(account_id);
CREATE INDEX IF NOT EXISTS ix_txn_category ON txn(category_id);

CREATE TABLE IF NOT EXISTS transaction_line (
  id          TEXT PRIMARY KEY,
  txn_id      TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  delta       REAL NOT NULL,            -- signed: negative leaves the account
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_line_txn ON transaction_line(txn_id);
CREATE INDEX IF NOT EXISTS ix_line_account ON transaction_line(account_id);

CREATE TABLE IF NOT EXISTS tag (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS transaction_tag (
  txn_id  TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  PRIMARY KEY (txn_id, tag_id)
);

CREATE TABLE IF NOT EXISTS budget (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  category_id  TEXT REFERENCES category(id) ON DELETE CASCADE,
  subcategory  TEXT,
  period       TEXT NOT NULL DEFAULT 'monthly',   -- weekly | monthly | annual
  amount       REAL NOT NULL,
  rollover     INTEGER NOT NULL DEFAULT 0,
  alert_pct    INTEGER NOT NULL DEFAULT 80,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_budget_user ON budget(user_id);

CREATE TABLE IF NOT EXISTS recurring_transaction (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  amount       REAL NOT NULL,
  account_id   TEXT REFERENCES account(id) ON DELETE CASCADE,
  category_id  TEXT REFERENCES category(id) ON DELETE SET NULL,
  subcategory  TEXT,
  frequency    TEXT NOT NULL,           -- daily | weekly | biweekly | monthly | quarterly | halfyearly | yearly
  start_date   TEXT NOT NULL,
  end_date     TEXT,
  next_date    TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_recurring_user ON recurring_transaction(user_id);

CREATE TABLE IF NOT EXISTS credit_card (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  credit_limit  REAL NOT NULL DEFAULT 0,
  billing_day   INTEGER,
  due_day       INTEGER,
  interest_rate REAL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loan (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  lender        TEXT,
  principal     REAL NOT NULL,
  interest_rate REAL NOT NULL,
  tenure_months INTEGER NOT NULL,
  start_date    TEXT NOT NULL,
  emis_paid     INTEGER NOT NULL DEFAULT 0,
  is_demo       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS savings_goal (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  target       REAL NOT NULL,
  saved        REAL NOT NULL DEFAULT 0,
  target_date  TEXT,
  account_id   TEXT REFERENCES account(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachment (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  txn_id       TEXT REFERENCES txn(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  mime_type    TEXT,
  byte_size    INTEGER,
  storage_key  TEXT,                    -- path/object key on the storage server
  checksum     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attachment_txn ON attachment(txn_id);

-- Every push also lands as an immutable snapshot, so restore-to-a-point-in-time works
-- even after a bad merge.
CREATE TABLE IF NOT EXISTS snapshot (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  label       TEXT,
  device      TEXT,
  byte_size   INTEGER NOT NULL,
  txn_count   INTEGER NOT NULL,
  checksum    TEXT NOT NULL,
  payload     TEXT NOT NULL,            -- full JSON export from the client
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_snapshot_user ON snapshot(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  direction   TEXT NOT NULL,            -- push | pull
  device      TEXT,
  txn_count   INTEGER,
  byte_size   INTEGER,
  outcome     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

INSERT OR IGNORE INTO currency (code, symbol, name, created_at, updated_at)
VALUES ('INR', '₹', 'Indian Rupee', datetime('now'), datetime('now'));
