-- ============================================================
--  PATCH: Historial de asignaciones + Roles actualizados
--  Ejecutar en SQL Editor → New query → Run
-- ============================================================

-- 1) Historial de asignaciones (auditoría completa de reasignaciones)
create table if not exists public.asignaciones_historial (
  id                uuid primary key default gen_random_uuid(),
  disponibilidad_id uuid not null references public.disponibilidades(id) on delete cascade,
  accion            text not null, -- 'asignada' | 'quitada' | 'reasignada'
  servicio          text,
  zona              text,
  notas             text,
  observacion       text,          -- razón de quitar/reasignar
  hecho_por         uuid references public.profiles(id),
  hecho_por_nombre  text,
  created_at        timestamptz not null default now()
);
create index if not exists idx_ah_disp on public.asignaciones_historial (disponibilidad_id, created_at desc);

-- Añadir campo observacion_baja a asignaciones (para la última vez que se quitó)
alter table public.asignaciones add column if not exists observacion_baja text default '';
alter table public.asignaciones add column if not exists bajada_por uuid references public.profiles(id);
alter table public.asignaciones add column if not exists bajada_at timestamptz;

-- 2) RLS historial
alter table public.asignaciones_historial enable row level security;

drop policy if exists "staff y dueño ven historial" on public.asignaciones_historial;
create policy "staff y dueño ven historial" on public.asignaciones_historial
  for select using (
    public.is_staff()
    or exists (select 1 from public.disponibilidades d
               where d.id = disponibilidad_id
                 and d.conductor_id = public.get_my_conductor_id())
  );

drop policy if exists "staff inserta historial" on public.asignaciones_historial;
create policy "staff inserta historial" on public.asignaciones_historial
  for insert with check (public.is_staff());

grant select, insert on public.asignaciones_historial to authenticated;

-- 3) Actualizar v_disponibilidades para incluir historial count
--    (la vista principal ya existía; solo nos aseguramos que tenga los nuevos campos de asignaciones)
create or replace view public.v_disponibilidades
with (security_invoker = true) as
select
  d.id, d.conductor_id, d.vehiculo_id, d.inicio, d.fin, d.localidad, d.notas,
  d.estado, d.motivo_cancelacion, d.created_at, d.validada_at,
  c.nombre  as conductor_nombre,
  c.documento, c.telefono,
  v.placa, v.tipo_vehiculo, v.numero_interno,
  a.id               as asignacion_id,
  a.servicio, a.zona,
  a.estado           as asignacion_estado,
  a.notas            as asignacion_notas,
  a.observacion_baja,
  coalesce(dv.criticos_pendientes,0) as docs_criticos_pendientes,
  coalesce(dv.criticos_vencidos,0)   as docs_criticos_vencidos,
  coalesce(dv.docs_vencidos,0)       as docs_vencidos,
  coalesce(dv.docs_sin_cargar,0)     as docs_sin_cargar,
  dv.detalle_criticos,
  coalesce(cv2.periodos_vencidos,0)  as cartera_periodos_vencidos,
  coalesce(cv2.valor_vencido,0)      as cartera_valor_vencido
from public.disponibilidades d
join public.conductores c on c.id = d.conductor_id
join public.vehiculos   v on v.id = d.vehiculo_id
left join public.asignaciones a
  on a.disponibilidad_id = d.id and a.estado <> 'cancelada'
left join public.v_docs_vehiculo dv on dv.vehiculo_id = v.id
left join public.v_cartera_vehiculo cv2 on cv2.placa = v.placa;

-- Permisos sobre la vista actualizada
grant select on public.v_disponibilidades to anon, authenticated;

-- 4) Ampliar permisos de asignaciones para jefe
--    (el jefe ahora puede crear, actualizar y eliminar asignaciones)
drop policy if exists "coordinador programa" on public.asignaciones;
create policy "staff asigna" on public.asignaciones
  for insert with check (public.get_my_role() in ('coordinador','jefe','analista','admin'));

drop policy if exists "coordinador actualiza asignacion" on public.asignaciones;
create policy "staff actualiza asignacion" on public.asignaciones
  for update using (public.get_my_role() in ('coordinador','jefe','analista','admin'));

drop policy if exists "coordinador elimina asignacion" on public.asignaciones;
create policy "staff elimina asignacion" on public.asignaciones
  for delete using (public.get_my_role() in ('coordinador','jefe','analista','admin'));

-- 5) Función que registra el historial automáticamente al asignar/quitar
create or replace function public.registrar_historial_asignacion(
  p_disponibilidad_id uuid,
  p_accion text,
  p_servicio text default null,
  p_zona text default null,
  p_notas text default null,
  p_observacion text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_nombre text;
begin
  select full_name into v_nombre from public.profiles where id = auth.uid();
  insert into public.asignaciones_historial
    (disponibilidad_id, accion, servicio, zona, notas, observacion, hecho_por, hecho_por_nombre)
  values
    (p_disponibilidad_id, p_accion, p_servicio, p_zona, p_notas, p_observacion, auth.uid(), coalesce(v_nombre,''));
end $$;

-- Verificar
select 'Patch aplicado OK' as resultado,
  (select count(*) from information_schema.columns
   where table_name='asignaciones' and column_name='observacion_baja') as col_obs,
  (select count(*) from information_schema.tables
   where table_name='asignaciones_historial') as tabla_hist;
