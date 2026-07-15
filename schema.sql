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
  sleep_quality TEXT,                      -- 'Good' | 'Average' | 'Poor' -- onboarding input for LifeScore baseline
  stress_level TEXT,                       -- 'Low' | 'Medium' | 'High' -- onboarding input for LifeScore baseline
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent add for the existing live table (CREATE TABLE IF NOT EXISTS above only
-- matters for a fresh install; this is what actually mutates the deployed DB).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sleep_quality TEXT,
  ADD COLUMN IF NOT EXISTS stress_level TEXT;

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

-- A recurring sequence of steps (Wake-Up/Wind-Down and any custom routine). Distinct
-- from goals/tasks -- these get lazily materialized into a day's tasks row (see
-- tasks.routine_id below) rather than being scheduled by the goal-generation system.
CREATE TABLE IF NOT EXISTS routines (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  category TEXT,                            -- General | Fitness | Diet | Finances | Relations | Personal | Work | Travel
  is_active BOOLEAN NOT NULL DEFAULT true,
  schedule_days TEXT[],                     -- e.g. ['Monday','Wednesday'] -- empty/null = every day
  schedule_time TIME,
  notes TEXT,
  steps JSONB NOT NULL DEFAULT '[]',        -- [{name, durationMinutes}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unifies simple/project/habit-logged tasks. goal_id is null for standalone quick-adds.
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  pillar_id INTEGER REFERENCES pillars(id),
  routine_id INTEGER REFERENCES routines(id) ON DELETE SET NULL, -- set when this task is a
                                                                   -- routine's materialized
                                                                   -- instance for its due_date
  parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, -- set on a Project's sub-tasks
                                                                   -- (null on the parent Project
                                                                   -- itself and all other kinds)
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'simple',     -- 'simple' | 'project' | 'habit'
  recurrence TEXT,                          -- null | 'daily' | 'weekly'
  phase_label TEXT,                         -- which goal phase this action belongs to, if any
  estimated_duration_minutes INTEGER,
  priority TEXT NOT NULL DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'Pending',  -- 'Pending' | 'Completed' | 'Skipped'
  due_date DATE,
  start_time TIME,                          -- nullable -- unscheduled tasks group under "Unscheduled"
  end_time TIME,
  session_started_at TIMESTAMPTZ,           -- Project Preview -> Active transition marker
  notes TEXT,                                -- Project notes (4.13's Notes section)
  xp_gained INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS end_time TIME,
  ADD COLUMN IF NOT EXISTS routine_id INTEGER REFERENCES routines(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT;

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
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, -- links a Logging Task's log entry
                                                             -- back to the scheduled task it
                                                             -- fulfilled; null for ad-hoc logs
  xp_gained INTEGER NOT NULL DEFAULT 0, -- the real amount actually awarded for this log --
                                        -- varies when task_id is set (duration-based formula)
                                        -- vs the flat ad-hoc rate, so history cards show the truth
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metric_logs_user_pillar ON metric_logs (user_id, pillar_id, logged_at);

ALTER TABLE metric_logs
  ADD COLUMN IF NOT EXISTS task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS xp_gained INTEGER NOT NULL DEFAULT 0;

-- Server-authoritative "this pillar is unlocked" record -- replaces the client-only
-- localStorage array. Presence of a row = the pillar is active for that user.
CREATE TABLE IF NOT EXISTS user_pillars (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id INTEGER NOT NULL REFERENCES pillars(id),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pillar_id)
);

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

-- One-time backfill for accounts that activated a pillar before user_pillars existed --
-- pillar_answers rows are created at questionnaire-submit time, a reasonable proxy.
INSERT INTO user_pillars (user_id, pillar_id, activated_at)
SELECT user_id, pillar_id, MIN(created_at) FROM pillar_answers
GROUP BY user_id, pillar_id
ON CONFLICT (user_id, pillar_id) DO NOTHING;

-- Take a Break's optional mood check-in -- feeds future wellness-trend views and the
-- Tired/Stressed + Mental Reset -> Shuffle Day prompt.
CREATE TABLE IF NOT EXISTS mood_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mood TEXT NOT NULL,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vision Board (4.3.5) -- user-uploaded motivational images, one per pillar per image.
CREATE TABLE IF NOT EXISTS vision_board_images (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id INTEGER REFERENCES pillars(id),
  image_url TEXT NOT NULL,
  blob_pathname TEXT NOT NULL, -- needed to delete the blob itself, not just the row
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- To-Do List (4.6) personalization -- a user-chosen icon/color accent per Simple Task,
-- independent of pillar tagging.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS icon TEXT,
  ADD COLUMN IF NOT EXISTS color TEXT;

-- Notifications (4.18.A) -- in-app history only, inserted at real event points
-- (task/project/side-quest completion). No push delivery yet.
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  icon_type TEXT NOT NULL,        -- 'trophy' | 'reminder' | 'ai_insight' | 'task'
  message TEXT NOT NULL,
  deep_link_target JSONB,         -- {page, params} or null
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Custom Side Quests (4.7.B) -- a "draft" row holds an AI-generated-but-not-yet-accepted
-- plan (draft_data); accepting it clears draft_data and materializes real linked tasks.
ALTER TABLE side_quests
  ADD COLUMN IF NOT EXISTS ai_strategy TEXT,
  ADD COLUMN IF NOT EXISTS end_date DATE,
  ADD COLUMN IF NOT EXISTS original_prompt TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active', -- 'draft' | 'active' | 'completed'
  ADD COLUMN IF NOT EXISTS draft_data JSONB,
  ADD COLUMN IF NOT EXISTS is_anti_goal BOOLEAN NOT NULL DEFAULT false;

-- A Side Quest's "Projects" are just Universal Project tasks tagged with quest_id.
-- Anti-Goals (4.15) instead materialize as a single recurring habit task carrying
-- baseline/target values for the nuanced daily feedback logic.
-- target_value is the CURRENT day's target, stepped down daily toward
-- final_target_value (the quest's ultimate goal) -- the deterministic reduction ramp.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS quest_id INTEGER REFERENCES side_quests(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS is_anti_goal BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS anti_goal_type TEXT,     -- 'binary' | 'progressive'
  ADD COLUMN IF NOT EXISTS baseline_value NUMERIC,
  ADD COLUMN IF NOT EXISTS target_value NUMERIC,
  ADD COLUMN IF NOT EXISTS final_target_value NUMERIC;

-- Pass 1 scheduling/skip fixes -- tool_hint lets a generated task deep-link into the
-- real tool that fulfills it (Journal, Log a Session, etc.) instead of a bare checkbox;
-- was_skipped marks a task that's already been bumped to the end-of-day bank once, so a
-- second Skip rolls it to tomorrow instead of bumping it later the same day forever.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS tool_hint TEXT,
  ADD COLUMN IF NOT EXISTS was_skipped BOOLEAN NOT NULL DEFAULT false;

-- Pass 2 Settings (4.19) -- one generic table serves the universal GET/PUT
-- /api/preferences/{scope} pattern for pillar preferences (scope = pillar name lowercase)
-- plus the two non-pillar preference pages (scope = 'units' | 'notifications').
CREATE TABLE IF NOT EXISTS preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, scope)
);

-- Pass 3 -- Routines become the general recurring-content materializer (not just
-- user-created ones): a goal-generated recurring action or daily_anchor is inserted as
-- a routine tagged with goal_id, reusing materializeRoutinesForDate()'s already-reliable
-- lazy day-by-day materialization instead of the old completion-gated regeneration that
-- silently stopped forever the first time a day was missed. end_date bounds a
-- project-linked recurring action to roughly the goal's own timeline; null (the default,
-- unaffected for existing user-created routines and habit/mindset goals) means indefinite.
ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS tool_hint TEXT,
  ADD COLUMN IF NOT EXISTS end_date DATE;

-- is_active lets retaking a pillar assessment deactivate the previous goal (and its
-- routines/pending tasks) instead of piling up duplicates forever. timeline_type drives
-- 2.9's Dynamic (default; Plan Shift pushes the sequence forward a day when a task is
-- missed) vs Strict (fixed deadline, AI feasibility-checked up front) behavior. end_date
-- is a real computed date (see lib/scheduling.js's parseTimelineDays), replacing the
-- free-text-only `timeline` column as the thing Plan Shift actually pushes forward.
ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS timeline_type TEXT NOT NULL DEFAULT 'dynamic',
  ADD COLUMN IF NOT EXISTS end_date DATE;

-- Real timestamp for "when was this Side Quest completed" -- is_completed alone couldn't
-- answer that (only created_at existed), which the Trophies page's Accomplishments tab
-- needs for a real date_completed rather than falling back to created_at (when it was
-- suggested, not when it was actually finished).
ALTER TABLE side_quests
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Google Sign-In: password_hash stays NOT NULL for every account (a Google-created user
-- gets an unguessable random hash, see api/auth.js's 'google' action) so no existing
-- query that assumes a password_hash needs special-casing. google_id links an account to
-- its verified Google identity; a password account can also gain one later if the same
-- email signs in with Google, rather than creating a duplicate account for one person.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;

-- Fixed Commitments (uploaded school/work/sports schedules) -- real external obligations
-- parsed from a PDF/DOCX, not something the user logs or earns XP for completing. Kept
-- as its own table rather than reusing `routines` since these aren't self-initiated
-- habits: they're busy blocks every auto-scheduling pass (goal generation, findOpenSlot)
-- must work around, never something to check off or delete via the Routines UI.
CREATE TABLE IF NOT EXISTS fixed_commitments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pillar_id INTEGER REFERENCES pillars(id),
  name TEXT NOT NULL,
  schedule_days TEXT[] NOT NULL DEFAULT '{}',  -- e.g. ['Monday','Wednesday','Friday']; empty = every day
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  source_filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
