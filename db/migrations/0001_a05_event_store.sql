begin;

create table if not exists werewolf_games (
  game_id text primary key,
  current_sequence bigint not null default 0 check (current_sequence >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists werewolf_events (
  game_id text not null references werewolf_games(game_id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  event_id text not null unique,
  transaction_id text not null,
  command_id text not null,
  event_type text not null,
  event_version text not null,
  event_json jsonb not null,
  recorded_at timestamptz not null,
  primary key (game_id, sequence)
);

create index if not exists werewolf_events_command_idx on werewolf_events(command_id);
create index if not exists werewolf_events_transaction_idx on werewolf_events(game_id, transaction_id);

create table if not exists werewolf_command_receipts (
  command_id text primary key,
  game_id text not null references werewolf_games(game_id) on delete cascade,
  principal_key text not null,
  first_sequence bigint not null check (first_sequence > 0),
  last_sequence bigint not null check (last_sequence >= first_sequence),
  outcome_code text not null,
  receipt_json jsonb not null,
  created_at timestamptz not null default now(),
  unique (game_id, first_sequence, last_sequence)
);

create index if not exists werewolf_receipts_game_sequence_idx on werewolf_command_receipts(game_id, first_sequence);

create table if not exists werewolf_snapshots (
  game_id text not null references werewolf_games(game_id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  snapshot_format_version text not null,
  data_schema_version text not null,
  engine_contract_version text not null,
  engine_build_id text not null,
  state_hash_sha256 text not null check (state_hash_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_json jsonb not null,
  created_at timestamptz not null,
  primary key (game_id, sequence)
);

create index if not exists werewolf_snapshots_latest_idx on werewolf_snapshots(game_id, sequence desc);

commit;
