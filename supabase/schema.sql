-- PurePaste · Supabase schema (runtime mirror of the D1 table)
--
-- Run this once in the Supabase dashboard: Project Settings → SQL Editor → New,
-- paste, Run. It is idempotent, so re-running it after a schema change is safe.
--
-- Why the grants look like this: the Worker talks to PostgREST over HTTPS, so the
-- database must be reachable with an API key. The publishable `anon` key ships to
-- browsers everywhere and is not a secret, therefore it gets nothing at all. Only
-- `service_role` — which you keep as a Worker *secret* — may read or write paste
-- bodies. A pastebin whose links are meant to be the only way in must not have a
-- table that any key in the dashboard can select from.

create table if not exists public.pastes (
	id                text primary key,
	kind              text not null,
	title             text,
	language          text,
	filename          text,
	content_type      text,
	size_bytes        bigint not null default 0,
	content           text,
	object_key        text,
	password_salt     text,
	password_verifier text,
	password_iterations integer,
	password_algo     text,
	manage_hash       text not null,
	burn_after_read   boolean not null default false,
	encrypted        boolean not null default false,
	markdown          boolean not null default false,
	redirect_url      text,
	created_at        bigint not null,
	expires_at        bigint not null,
	consumed_at       bigint,
	views             bigint not null default 0
);

-- What the sweep and the fallback read need; mirrors the D1 indexes.
create index if not exists pastes_expires_at_idx on public.pastes (expires_at);
create index if not exists pastes_consumed_at_idx on public.pastes (consumed_at);
create index if not exists pastes_object_key_idx on public.pastes (object_key);

alter table public.pastes enable row level security;

-- Belt and braces: even with RLS on, an explicit revoke means a future policy
-- mistake cannot expose the table.
revoke all on table public.pastes from anon, authenticated, public;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.pastes to service_role;

-- Hourly keep-alive. Supabase pauses a free project after a week with no traffic,
-- and a paused project answers a visitor with a cold start or an error, so the
-- Worker's cron calls this whether or not mirroring is switched on. It is a real
-- statement, which is what the inactivity timer counts.
create or replace function public.supabase_keepalive()
returns integer
language sql
stable
as $$
	select 1;
$$;

alter function public.supabase_keepalive() owner to postgres;

-- The one exception on the page: this function is granted to the publishable key.
-- It runs `select 1` and returns an integer, so there is nothing to learn from it —
-- and the cron needs something the anon key may call, because that is the key an
-- instance always has. Everything above it stays revoked for those roles.
grant execute on function public.supabase_keepalive() to anon, authenticated, service_role;

-- Batched view counting, called by the sweep rather than per read, exactly like the
-- D1 side does it. PostgREST cannot do `views = views + n`, so the arithmetic lives
-- here instead.
create or replace function public.apply_views(deltas jsonb)
returns void
language sql
as $$
	update public.pastes as p
	   set views = p.views + coalesce((d ->> 'delta')::bigint, 0)
	  from jsonb_array_elements(deltas) as d
	 where p.id = d ->> 'paste_id';
$$;

alter function public.apply_views(jsonb) owner to postgres;
revoke all on function public.apply_views(jsonb) from anon, authenticated, public;
grant execute on function public.apply_views(jsonb) to service_role;

-- Optional, and only worth doing if you plan to query this copy from outside the
-- Worker: keeps a readable count of what is live, the way /api/stats answers.
create or replace view public.live_pastes as
	select kind, count(*) as count, coalesce(sum(size_bytes), 0) as bytes
	  from public.pastes
	 where expires_at > (extract(epoch from now()) * 1000)::bigint
	   and consumed_at is null
	 group by kind;

grant select on public.live_pastes to service_role;
revoke all on public.live_pastes from anon, authenticated, public;
