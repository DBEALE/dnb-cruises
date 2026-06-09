create table if not exists site_visitors (
  visitor_id   uuid primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  visit_count   bigint      not null default 0
);

create table if not exists site_visit_totals (
  id           boolean primary key default true check (id),
  total_visits bigint      not null default 0,
  updated_at   timestamptz not null default now()
);

insert into site_visit_totals (id, total_visits)
values (true, 0)
on conflict (id) do nothing;

create or replace function record_site_visit(p_visitor_id uuid)
returns table(unique_visitors bigint, total_visits bigint)
language plpgsql
security definer
as $$
begin
  insert into site_visitors (visitor_id, visit_count)
  values (p_visitor_id, 1)
  on conflict (visitor_id) do update
    set visit_count = site_visitors.visit_count + 1,
        last_seen_at = now();

  insert into site_visit_totals (id, total_visits)
  values (true, 1)
  on conflict (id) do update
    set total_visits = site_visit_totals.total_visits + 1,
        updated_at = now();

  return query
    select
      (select count(*)::bigint from site_visitors),
      (select svt.total_visits from site_visit_totals svt where svt.id = true);
end;
$$;
