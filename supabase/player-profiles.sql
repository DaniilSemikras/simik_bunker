-- Служебные строки bunker_config:
-- 1 — настройки игры, 2 — резервная история, 3 — профили, рамки и кейсы игроков.
alter table public.bunker_config
    drop constraint if exists bunker_config_id_check;

alter table public.bunker_config
    add constraint bunker_config_id_check check (id in (1, 2, 3));
