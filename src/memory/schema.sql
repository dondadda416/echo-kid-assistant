-- Echo kid assistant — schema (spec §6).
-- Idempotent: every statement is IF NOT EXISTS. Applied by src/memory/migrate.ts.
-- Statements are separated by a line containing only `--;` so the migrator can
-- split them without needing a real SQL parser.

CREATE TABLE IF NOT EXISTS sessions (
  session_id  text PRIMARY KEY,
  user_id     text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  turn_count  integer NOT NULL DEFAULT 0,
  cap_hit     boolean NOT NULL DEFAULT false
)
--;

CREATE TABLE IF NOT EXISTS exchanges (
  id              serial PRIMARY KEY,
  session_id      text NOT NULL,
  user_id         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  utterance       text NOT NULL,
  spoken          text NOT NULL,
  canned_id       text,
  flag            text NOT NULL DEFAULT 'none',
  input_verdict   text,
  input_reason    text,
  input_raw       text,
  generation_text text,
  output_verdict  text,
  output_raw      text,
  contains_pii    boolean NOT NULL DEFAULT false,
  timings         jsonb,
  models          jsonb,
  error           text
)
--;

CREATE TABLE IF NOT EXISTS user_memory (
  id         serial PRIMARY KEY,
  user_id    text NOT NULL,
  line       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)
--;

CREATE INDEX IF NOT EXISTS exchanges_user_created_idx
  ON exchanges (user_id, created_at DESC)
--;

CREATE INDEX IF NOT EXISTS exchanges_flag_idx
  ON exchanges (flag)
  WHERE flag <> 'none'
--;

CREATE INDEX IF NOT EXISTS exchanges_session_idx
  ON exchanges (session_id, created_at)
--;

CREATE INDEX IF NOT EXISTS sessions_user_started_idx
  ON sessions (user_id, started_at DESC)
--;

CREATE INDEX IF NOT EXISTS user_memory_user_idx
  ON user_memory (user_id, created_at)
--;
