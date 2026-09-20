begin;

create table if not exists werewolf_npc_cognitive_states (
  game_id text not null references werewolf_games(game_id) on delete cascade,
  player_id text not null,
  contract_version text not null,
  revision bigint not null check (revision >= 0),
  state_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id)
);

create index if not exists werewolf_npc_cognitive_states_game_idx
  on werewolf_npc_cognitive_states(game_id);

commit;
