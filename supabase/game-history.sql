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
