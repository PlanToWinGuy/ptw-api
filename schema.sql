CREATE TABLE IF NOT EXISTS pillars (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT
);

INSERT INTO pillars (id, name, description) VALUES
  (1, 'Fitness', 'Movement, training, energy, physical capability'),
  (2, 'Diet', 'Food, fuel, nutrition'),
  (3, 'Finances', 'Money, earning, saving, security'),
  (4, 'Relations', 'Family, friends, partner, community'),
  (5, 'Personal', 'Inner life, growth, identity, meaning'),
  (6, 'Work', 'Career, craft, ambition, contribution')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  username TEXT,
  dob DATE,
  gender TEXT,
  height NUMERIC,
  weight NUMERIC,
  fitness_level TEXT,
  diet TEXT,
  phase INTEGER NOT NULL DEFAULT 1,
  phase_start_date TIMESTAMPTZ,
  life_score NUMERIC NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  recommended_pillar TEXT,
  valueprint_data JSONB,
  wake_time TIME,
  wind_down_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A goal's "type" is what drives how it decomposes into tasks below:
-- habit/mindset -> one recurring task from daily_anchor
-- project/skill -> one-off tasks pulled from each phase's actions[], plus milestone checkpoints
CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id INTEGER REFERENCES pillars(id),
  type TEXT NOT NULL DEFAULT 'project',   -- 'habit' | 'project' | 'skill' | 'mindset'
  title TEXT NOT NULL,
  why TEXT,
  timeline TEXT,
  daily_anchor TEXT,
  phases JSONB,                            -- [{label, duration, focus, actions:[]}]
  milestones JSONB,                        -- [{label, marker}]
  alts JSONB,                              -- alternative titles/approaches, same destination
  difficulty INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unifies simple/project/habit-logged tasks. goal_id is null for standalone quick-adds.
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  pillar_id INTEGER REFERENCES pillars(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'simple',     -- 'simple' | 'project' | 'habit'
  recurrence TEXT,                          -- null | 'daily' | 'weekly'
  phase_label TEXT,                         -- which goal phase this action belongs to, if any
  estimated_duration_minutes INTEGER,
  priority TEXT NOT NULL DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'Pending',
  due_date DATE,
  xp_gained INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS side_quests (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id INTEGER REFERENCES pillars(id),
  suggestion TEXT,
  description TEXT,
  xp INTEGER NOT NULL DEFAULT 50,
  badge_name TEXT,
  duration_category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  is_completed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-pillar metric/data logging -- the "tool" layer (workout sets, meal scans, journal
-- entries, expenses, connections, focus sessions, Identity reflections). One flexible
-- table instead of six rigid ones, per the "AI is the engine, not a database" rule --
-- `data` holds whatever shape that log_type needs; `value`/`unit` are for quick charting.
CREATE TABLE IF NOT EXISTS metric_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id INTEGER REFERENCES pillars(id),
  log_type TEXT NOT NULL,                  -- 'workout' | 'meal' | 'meditation' | 'journal' |
                                            -- 'identity_reflection' | 'expense' | 'connection' |
                                            -- 'focus_session' | 'steps' | ...
  value NUMERIC,
  unit TEXT,
  data JSONB,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metric_logs_user_pillar ON metric_logs (user_id, pillar_id, logged_at);

-- Shared with map.plantowin.app (the Valueprint mapper) -- replaces its in-memory profile
-- store so a saved reading survives across serverless instances/deploys. user_id links it
-- to a ptw-api account once one exists (set at save time if ptw_token was present, or later
-- when the pre-signup funnel completes and the pending profile gets claimed).
CREATE TABLE IF NOT EXISTS mapper_profiles (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  nodes JSONB,
  reveal JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw answers from a pillar's activation questionnaire, feeding goal generation as context.
CREATE TABLE IF NOT EXISTS pillar_answers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id INTEGER REFERENCES pillars(id),
  answers JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
