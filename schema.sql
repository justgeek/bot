-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists voice_sessions (
  id               bigint generated always as identity primary key,
  user_id          text        not null,
  username         text        not null,
  channel_id       text        not null,
  channel_name     text,
  joined_at        timestamptz not null default now(),
  left_at          timestamptz,
  duration_seconds integer
);

create table if not exists presence_logs (
  id         bigint generated always as identity primary key,
  user_id    text        not null,
  username   text        not null,
  status     text        not null check (status in ('online', 'idle', 'dnd', 'offline')),
  changed_at timestamptz not null default now()
);

create index if not exists voice_sessions_open_idx   on voice_sessions (user_id) where left_at is null;
create index if not exists voice_sessions_joined_idx on voice_sessions (joined_at desc);
create index if not exists voice_sessions_left_idx   on voice_sessions (left_at desc) where left_at is not null;
create index if not exists presence_logs_changed_idx on presence_logs (changed_at desc);

-- The bot uses the service_role key, which bypasses RLS. Turning RLS on with no
-- policies means the public anon key cannot read or write these tables.
alter table voice_sessions enable row level security;
alter table presence_logs  enable row level security;

-- Closes any open session for a user, using the database clock:
-- duration_seconds = EXTRACT(EPOCH FROM (NOW() - joined_at))
create or replace function end_voice_session(p_user_id text)
returns void
language sql
as $$
  update voice_sessions
     set left_at = now(),
         duration_seconds = extract(epoch from (now() - joined_at))::integer
   where user_id = p_user_id
     and left_at is null;
$$;

-- Top voice users. p_days = null means all time. Open sessions count up to now(),
-- and sessions that straddle the window start are clipped to the window.
create or replace function voice_leaderboard(p_days integer default null, p_limit integer default 10)
returns table (uid text, uname text, secs bigint)
language sql
stable
as $$
  select s.user_id as uid,
         (array_agg(s.username order by s.joined_at desc))[1] as uname,
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
