-- ============================================================
--  PATCH: Asignaciones por rango horario parcial
--  Una disponibilidad puede tener múltiples asignaciones en
--  rangos que no se solapen dentro del turno del conductor.
--  Ejecutar en SQL Editor → New query → Run
-- ============================================================

-- 1) Quitar el UNIQUE constraint de disponibilidad_id
--    (ahora puede haber varias asignaciones por disponibilidad)
alter table public.asignaciones drop constraint if exists asignaciones_disponibilidad_id_key;

-- 2) Agregar campos de rango a asignaciones
alter table public.asignaciones add column if not exists inicio timestamptz;
alter table public.asignaciones add column if not exists fin    timestamptz;

-- 3) Restricción: los rangos asignados no pueden solaparse
--    dentro de la misma disponibilidad
alter table public.asignaciones drop constraint if exists excl_asig_rango;
alter table public.asignaciones add constraint excl_asig_rango
  exclude using gist (
    disponibilidad_id with =,
    tstzrange(inicio, fin) with &&
  ) where (estado <> 'cancelada' and inicio is not null and fin is not null);

-- 4) Función que valida que el rango esté dentro del turno del conductor
create or replace function public.validar_rango_asignacion()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_inicio timestamptz; v_fin timestamptz;
begin
  if new.inicio is null or new.fin is null then return new; end if;
  select d.inicio, d.fin into v_inicio, v_fin
  from public.disponibilidades d where d.id = new.disponibilidad_id;
  if new.inicio < v_inicio or new.fin > v_fin then
    raise exception 'El rango de asignación (% → %) está fuera del turno del conductor (% → %)',
      new.inicio, new.fin, v_inicio, v_fin;
  end if;
  if new.inicio >= new.fin then
    raise exception 'La hora de inicio debe ser anterior a la hora de fin';
  end if;
  return new;
end $$;

drop trigger if exists trg_validar_rango_asig on public.asignaciones;
create trigger trg_validar_rango_asig
  before insert or update on public.asignaciones
  for each row execute function public.validar_rango_asignacion();

-- 5) Vista actualizada: ahora una disponibilidad puede tener varias asignaciones
--    La vista muestra la disponibilidad + todas sus asignaciones activas como JSON
create or replace view public.v_disponibilidades
with (security_invoker = true) as
select
  d.id, d.conductor_id, d.vehiculo_id, d.inicio, d.fin, d.localidad, d.notas,
  d.estado, d.motivo_cancelacion, d.created_at, d.validada_at,
  c.nombre  as conductor_nombre, c.documento, c.telefono,
  v.placa, v.tipo_vehiculo, v.numero_interno,
  -- Para compatibilidad: primera asignación activa (si hay una sola)
  (select a.id from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada'
   order by a.inicio nulls last limit 1)            as asignacion_id,
  (select a.servicio from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada'
   order by a.inicio nulls last limit 1)            as servicio,
  (select a.zona from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada'
   order by a.inicio nulls last limit 1)            as zona,
  (select a.estado from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada'
   order by a.inicio nulls last limit 1)            as asignacion_estado,
  (select a.notas from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada'
   order by a.inicio nulls last limit 1)            as asignacion_notas,
  (select a.observacion_baja from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada'
   order by a.inicio nulls last limit 1)            as observacion_baja,
  -- Cantidad total de asignaciones activas (para saber si está parcialmente asignado)
  (select count(*) from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada') as total_asignaciones,
  -- Horas ya asignadas
  (select coalesce(sum(extract(epoch from (a.fin - a.inicio))/3600),0)
   from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada'
     and a.inicio is not null)                      as horas_asignadas,
  -- Todas las asignaciones activas como JSON (para mostrar rangos parciales)
  (select json_agg(json_build_object(
      'id', a.id, 'servicio', a.servicio, 'zona', a.zona,
      'inicio', a.inicio, 'fin', a.fin, 'notas', a.notas,
      'estado', a.estado, 'observacion_baja', a.observacion_baja
    ) order by a.inicio nulls last)
   from public.asignaciones a
   where a.disponibilidad_id = d.id and a.estado <> 'cancelada') as asignaciones_json,
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
left join public.v_docs_vehiculo dv on dv.vehiculo_id = v.id
left join public.v_cartera_vehiculo cv2 on cv2.placa = v.placa;

grant select on public.v_disponibilidades to anon, authenticated;

-- Verificar
select 'OK' as resultado,
  (select count(*) from information_schema.table_constraints
   where constraint_name='asignaciones_disponibilidad_id_key') as unique_eliminado_si_0,
  (select count(*) from information_schema.columns
   where table_name='asignaciones' and column_name='inicio') as col_inicio_si_1;
