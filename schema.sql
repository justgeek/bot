-- Run in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again on top of the previous version: it only adds what is missing.

create table if not exists voice_sessions (
  id               bigint generated always as identity primary key,
  user_id          text        not null,
  username         text        not null,
  display_name     text,
  channel_id       text        not null,
  channel_name     text,
  joined_at        timestamptz not null default now(),
  left_at          timestamptz,
  duration_seconds integer
);

create table if not exists presence_logs (
  id           bigint generated always as identity primary key,
  user_id      text        not null,
  username     text        not null,
  display_name text,
  status       text        not null check (status in ('online', 'idle', 'dnd', 'offline')),
  changed_at   timestamptz not null default now()
);

-- Upgrade path for tables created by the first version
alter table voice_sessions add column if not exists display_name text;
alter table presence_logs  add column if not exists display_name text;
alter table presence_logs  add column if not exists devices text; -- "desktop", "mobile", "web" or a comma list; null for offline/older rows
alter table voice_sessions add column if not exists speaking_seconds integer not null default 0;
alter table voice_sessions add column if not exists devices text; -- Discord app(s) they joined voice from, e.g. "mobile" or "desktop,web"
alter table voice_sessions add column if not exists streaming_seconds integer not null default 0; -- screen share ("Go Live") time
alter table voice_sessions add column if not exists muted_seconds     integer not null default 0; -- mic muted, still listening
alter table voice_sessions add column if not exists deafened_seconds  integer not null default 0; -- deafened (always muted too)

-- "I'll be late" notices submitted from the dashboard (is_valid = sent before target_at)
create table if not exists late_notices (
  id            bigint generated always as identity primary key,
  user_id       text        not null,
  username      text        not null,
  display_name  text,
  target_date   date        not null,          -- target start on the submitter's clock
  target_time   text        not null,          -- "HH:mm"
  delay_minutes integer     not null,
  reason        text        not null,
  is_valid      boolean     not null default false,
  submitted_at  timestamptz not null default now()
);
create index if not exists late_notices_target_idx on late_notices (target_date desc);
alter table late_notices enable row level security;

create index if not exists voice_sessions_open_idx   on voice_sessions (user_id) where left_at is null;
create index if not exists voice_sessions_joined_idx on voice_sessions (joined_at desc);
create index if not exists voice_sessions_left_idx   on voice_sessions (left_at desc) where left_at is not null;
create index if not exists presence_logs_changed_idx on presence_logs (changed_at desc);

-- The bot uses the service_role key (bypasses RLS). RLS on + no policies means
-- the public anon key can't read or write these tables.
alter table voice_sessions enable row level security;
alter table presence_logs  enable row level security;

-- Closes any open session for a user using the database clock.
-- Signature changed (added p_speaking_seconds), so the old version must be dropped first.
drop function if exists end_voice_session(text);

create or replace function end_voice_session(p_user_id text, p_speaking_seconds integer default 0)
returns void
language sql
as $$
  update voice_sessions
     set left_at = now(),
         duration_seconds = extract(epoch from (now() - joined_at))::integer,
         speaking_seconds = greatest(coalesce(speaking_seconds, 0), coalesce(p_speaking_seconds, 0))
   where user_id = p_user_id
     and left_at is null;
$$;

-- Return type changed (added dname), so the old version must be dropped first.
drop function if exists voice_leaderboard(integer, integer);

create or replace function voice_leaderboard(p_days integer default null, p_limit integer default 10)
returns table (uid text, uname text, dname text, secs bigint)
language sql
stable
as $$
  select s.user_id as uid,
         (array_agg(s.username order by s.joined_at desc))[1] as uname,
         (array_agg(coalesce(s.display_name, s.username) order by s.joined_at desc))[1] as dname,
         sum(extract(epoch from (
           coalesce(s.left_at, now()) -
           case when p_days is null then s.joined_at
                else greatest(s.joined_at, now() - make_interval(days => p_days))
           end
         )))::bigint as secs
    from voice_sessions s
   where p_days is null
      or coalesce(s.left_at, now()) >= now() - make_interval(days => p_days)
   group by s.user_id
   order by secs desc
   limit p_limit;
$$;

create or replace function voice_total_seconds()
returns bigint
language sql
stable
as $$
  select coalesce(sum(extract(epoch from (coalesce(left_at, now()) - joined_at))), 0)::bigint
    from voice_sessions;
$$;
