create table if not exists public.bunker_game_history (
    id text primary key,
    room_code text not null,
    finished_at timestamptz not null default now(),
    payload jsonb not null
);

create index if not exists bunker_game_history_finished_at_idx
    on public.bunker_game_history (finished_at desc);

create index if not exists bunker_game_history_room_code_idx
    on public.bunker_game_history (room_code);

alter table public.bunker_game_history enable row level security;

-- Сервер обращается к таблице с secret/service-role ключом. Публичные политики не нужны.
revoke all on table public.bunker_game_history from anon, authenticated;
grant all on table public.bunker_game_history to service_role;

-- Однократно переносим игры из старого резервного хранилища, если оно использовалось.
insert into public.bunker_game_history (id, room_code, finished_at, payload)
select
    game->>'gameId',
    coalesce(nullif(game->>'roomCode', ''), 'UNKNOWN'),
    to_timestamp(coalesce(nullif(game->>'finishedAt', '')::numeric, extract(epoch from now()) * 1000) / 1000),
    game
from public.bunker_config config_row
cross join lateral jsonb_array_elements(
    case
        when jsonb_typeof(config_row.config->'games') = 'array' then config_row.config->'games'
        else '[]'::jsonb
    end
) game
where config_row.id = 2
  and nullif(game->>'gameId', '') is not null
on conflict (id) do update set
    room_code = excluded.room_code,
    finished_at = excluded.finished_at,
    payload = excluded.payload;
