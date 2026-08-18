-- ============================================================
-- Wheel of Procrastination – Web App Schema
-- Im Supabase SQL-Editor einmalig komplett ausführen.
-- ============================================================

-- ---------- Tabellen ----------

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null,
  is_routine boolean not null default false,
  is_work_location boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null,
  duration_minutes integer not null default 15,
  location text not null default '',
  kind text not null default 'oneOff',              -- 'oneOff' | 'recurring'
  recurrence text not null default 'daily',         -- 'daily' | 'weekly' | 'customDays'
  custom_recurrence_days integer not null default 2,
  is_priority boolean not null default false,
  due_date timestamptz,
  scheduled_date timestamptz,
  has_scheduled_time boolean not null default false,
  repeat_count integer not null default 1,
  completed_today_count integer not null default 0,
  last_completed_count_reset timestamptz,
  repeat_cooldown_minutes integer not null default 0,
  last_repeat_completed_at timestamptz,
  tags jsonb not null default '[]'::jsonb,
  subtasks jsonb not null default '[]'::jsonb,      -- [{id,title,done}]
  notes text not null default '',
  dependency_task_id uuid,
  start_date timestamptz,
  active_weekdays jsonb not null default '[]'::jsonb, -- [1..7], 1=Sonntag
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  last_done_at timestamptz,
  is_archived boolean not null default false
);

-- Log jeder Erledigung -> Basis für Statistik & Streaks
create table if not exists completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  task_id uuid,
  title text not null default '',
  minutes integer not null default 0,
  completed_at timestamptz not null default now()
);

-- Arbeitszeit (Stempeluhr + manuelle Einträge)
create table if not exists work_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  start_time timestamptz not null default now(),
  end_time timestamptz,                              -- null = Uhr läuft
  break_minutes integer not null default 0,
  break_started_at timestamptz,                      -- null = keine Pause aktiv
  notes text not null default ''
);

-- Einstellungen als Key/Value (Soll-Stunden etc.)
create table if not exists settings (
  user_id uuid not null default auth.uid(),
  key text not null,
  value jsonb not null,
  primary key (user_id, key)
);

-- ---------- Row Level Security (nur eigene Daten) ----------

alter table locations enable row level security;
alter table tasks enable row level security;
alter table completions enable row level security;
alter table work_entries enable row level security;
alter table settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['locations','tasks','completions','work_entries','settings'] loop
    execute format('drop policy if exists "own rows" on %I', t);
    execute format(
      'create policy "own rows" on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
      t
    );
  end loop;
end $$;

-- ---------- Realtime (Live-Sync zwischen Geräten) ----------

do $$
begin
  begin execute 'alter publication supabase_realtime add table tasks'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table locations'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table completions'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table work_entries'; exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table settings'; exception when duplicate_object then null; end;
end $$;

-- ---------- Standard-Orte beim ersten Login ----------
-- (Die App legt "Home", "Work", "To-Do" usw. selbst an, falls leer.)
