-- ============================================================
--  Agregar el módulo de configuración de cargue automático
--  a una instalación existente.
--  Ejecutar en: SQL Editor → New query → Run
-- ============================================================

create table if not exists public.config (
  clave       text primary key,
  valor       text,
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);

insert into public.config (clave, valor) values
  ('recordatorio_cargue_hora', '07:00'),
  ('recordatorio_cargue_activo', 'true'),
  ('portal_url', '')
on conflict (clave) do nothing;

alter table public.config enable row level security;

drop policy if exists "staff lee config" on public.config;
create policy "staff lee config" on public.config
  for select using (public.is_staff());

drop policy if exists "admin gestiona config" on public.config;
create policy "admin gestiona config" on public.config
  for all using (public.get_my_role() in ('admin','jefe'))
  with check (public.get_my_role() in ('admin','jefe'));

-- Verificar:
select clave, valor from public.config order by clave;
