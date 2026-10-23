-- AI Usage Tracker: optional cloud sync schema for Supabase.
-- Run this once in the Supabase SQL editor (or as a migration).

create table if not exists public.aiusage_devices (
  id uuid primary key default gen_random_uuid(),
  owner_label text not null,
  ingest_token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
comment on table public.aiusage_devices is 'One row per person/browser sending usage readings. ingest_token is the secret the extension uses to write.';

create table if not exists public.aiusage_snapshots (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.aiusage_devices(id) on delete cascade,
  tool text not null default 'claude',
  plan text,
  read_at timestamptz not null,
  limits jsonb not null,
  created_at timestamptz not null default now(),
  unique (device_id, tool, read_at)
);
comment on table public.aiusage_snapshots is 'One row per usage reading. limits = {limit_key: {u: percent used 0-100, r: reset time epoch ms}}.';
create index if not exists aiusage_snapshots_device_time on public.aiusage_snapshots (device_id, read_at desc);

-- No direct table access from the public API. Writes go through aiusage_ingest only.
alter table public.aiusage_devices enable row level security;
alter table public.aiusage_snapshots enable row level security;
revoke all on public.aiusage_devices, public.aiusage_snapshots from anon, authenticated;

-- One row per limit per reading, for easy querying.
create or replace view public.aiusage_readings with (security_invoker = true) as
select s.device_id, d.owner_label, s.tool, s.plan, s.read_at,
       l.key as limit_key,
       (l.value->>'u')::numeric as used_pct,
       case when l.value->>'r' is null then null else to_timestamp((l.value->>'r')::bigint / 1000.0) end as resets_at
from public.aiusage_snapshots s
join public.aiusage_devices d on d.id = s.device_id
cross join lateral jsonb_each(s.limits) l;
revoke all on public.aiusage_readings from anon, authenticated;

-- Write path for the extension: checks the device token, inserts a batch, skips duplicates.
create or replace function public.aiusage_ingest(p_token uuid, p_snapshots jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device uuid;
  v_inserted int;
begin
  select id into v_device from aiusage_devices where ingest_token = p_token;
  if v_device is null then
    raise exception 'invalid ingest token' using errcode = '28000';
  end if;
  if jsonb_typeof(p_snapshots) <> 'array' or jsonb_array_length(p_snapshots) > 500 then
    raise exception 'p_snapshots must be an array of at most 500 readings';
  end if;
  insert into aiusage_snapshots (device_id, tool, plan, read_at, limits)
  select v_device,
         coalesce(e->>'tool', 'claude'),
         e->>'plan',
         to_timestamp((e->>'t')::bigint / 1000.0),
         e->'l'
  from jsonb_array_elements(p_snapshots) e
  where jsonb_typeof(e->'l') = 'object'
  on conflict (device_id, tool, read_at) do nothing;
  get diagnostics v_inserted = row_count;
  update aiusage_devices set last_seen_at = now() where id = v_device;
  return jsonb_build_object('inserted', v_inserted);
end;
$$;
revoke all on function public.aiusage_ingest(uuid, jsonb) from public, authenticated;
grant execute on function public.aiusage_ingest(uuid, jsonb) to anon;

-- Add a person/browser. Copy the ingest_token it returns; you need it for the sync code.
-- insert into public.aiusage_devices (owner_label) values ('your-name') returning ingest_token;
