-- TypeForge Database Schema
-- Run once: psql $DATABASE_URL < db/schema.sql

-- ── SESSION ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar      NOT NULL COLLATE "default",
  "sess"   json         NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ── USERS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(30)  UNIQUE NOT NULL,
  password_hash TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  last_login    TIMESTAMPTZ  DEFAULT NOW()
);

-- ── PARAGRAPHS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paragraphs (
  id            SERIAL PRIMARY KEY,
  exam_id       VARCHAR(64) NOT NULL,
  text          TEXT        NOT NULL,
  source        VARCHAR(255),
  date_assigned DATE,
  word_count    INTEGER     GENERATED ALWAYS AS (
    array_length(regexp_split_to_array(trim(text), '\s+'), 1)
  ) STORED,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (exam_id, text)
);
CREATE INDEX IF NOT EXISTS idx_paragraphs_exam_date
  ON paragraphs (exam_id, date_assigned);

-- ── ATTEMPTS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attempts (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  exam_id        VARCHAR(64)    NOT NULL,
  exam_name      VARCHAR(255),
  passage_idx    INTEGER        DEFAULT 0,
  wpm            NUMERIC(8,2),
  net_wpm        NUMERIC(8,2),
  gross_wpm      NUMERIC(8,2),
  kdph           INTEGER,
  cpm            INTEGER,
  accuracy       NUMERIC(5,2),
  total_chars    INTEGER,
  correct_chars  INTEGER,
  wrong_chars    INTEGER,
  correct_words  INTEGER,
  wrong_words    INTEGER,
  total_words    INTEGER,
  keystrokes     INTEGER,
  backspaces     INTEGER,
  duration       NUMERIC(6,2),
  passed         BOOLEAN        DEFAULT FALSE,
  created_at     TIMESTAMPTZ    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attempts_user   ON attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_exam   ON attempts (exam_id);
