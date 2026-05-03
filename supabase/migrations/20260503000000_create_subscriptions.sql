create table if not exists subscriptions (
  id               uuid        default gen_random_uuid() primary key,
  whatsapp_number  text        not null,
  criteria         jsonb       not null default '{}',
  active           boolean     default true,
  created_at       timestamptz default now(),
  last_notified_at timestamptz
);

create table if not exists seen_cruises (
  subscription_id uuid  references subscriptions(id) on delete cascade,
  cruise_id       text  not null,
  primary key (subscription_id, cruise_id)
);
