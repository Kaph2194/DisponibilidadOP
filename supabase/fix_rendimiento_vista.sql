-- PASO 1: ejecuta solo estas dos líneas y espera Success
drop view if exists public.v_disponibilidades;
drop view if exists public.v_asignaciones_resumen;

-- PASO 2: ejecuta el resto después del Success del paso 1

create or replace view public.v_asignaciones_resumen
with (security_invoker = true) as
select
  a.disponibilidad_id,
  count(*) filter (where a.estado <> 'cancelada')                          as total_asignaciones,
  sum(extract(epoch from (a.fin - a.inicio))/3600)
    filter (where a.estado <> 'cancelada' and a.inicio is not null)        as horas_asignadas,
  (array_agg(a.id order by a.inicio nulls last)
     filter (where a.estado <> 'cancelada'))[1]                            as asignacion_id,
  json_agg(
    json_build_object(
      'id', a.id, 'servicio', a.servicio, 'zona', a.zona,
      'inicio', a.inicio, 'fin', a.fin, 'notas', a.notas,
      'estado', a.estado, 'observacion_baja', a.observacion_baja
    ) order by a.inicio nulls last
  ) filter (where a.estado <> 'cancelada')                                 as asignaciones_json
from public.asignaciones a
group by a.disponibilidad_id;

grant select on public.v_asignaciones_resumen to anon, authenticated;

create or replace view public.v_disponibilidades
with (security_invoker = true) as
select
  d.id, d.conductor_id, d.vehiculo_id, d.inicio, d.fin, d.localidad, d.notas,
  d.estado, d.motivo_cancelacion, d.created_at, d.validada_at,
  c.nombre  as conductor_nombre, c.documento, c.telefono,
  v.placa, v.tipo_vehiculo, v.numero_interno,
  ar.asignacion_id,
  a1.servicio        as servicio,
  a1.zona            as zona,
  a1.estado          as asignacion_estado,
  a1.notas           as asignacion_notas,
  a1.observacion_baja,
  coalesce(ar.total_asignaciones, 0)   as total_asignaciones,
  coalesce(ar.horas_asignadas, 0)      as horas_asignadas,
  ar.asignaciones_json,
  coalesce(dv.criticos_pendientes, 0)  as docs_criticos_pendientes,
  coalesce(dv.criticos_vencidos, 0)    as docs_criticos_vencidos,
  coalesce(dv.docs_vencidos, 0)        as docs_vencidos,
  coalesce(dv.docs_sin_cargar, 0)      as docs_sin_cargar,
  dv.detalle_criticos,
  coalesce(cv2.periodos_vencidos, 0)   as cartera_periodos_vencidos,
  coalesce(cv2.valor_vencido, 0)       as cartera_valor_vencido
from public.disponibilidades d
join public.conductores c  on c.id  = d.conductor_id
join public.vehiculos   v  on v.id  = d.vehiculo_id
left join public.v_asignaciones_resumen ar on ar.disponibilidad_id = d.id
left join public.asignaciones a1           on a1.id = ar.asignacion_id
left join public.v_docs_vehiculo    dv     on dv.vehiculo_id = v.id
left join public.v_cartera_vehiculo cv2    on cv2.placa = v.placa;

grant select on public.v_disponibilidades to anon, authenticated;

create index if not exists idx_disp_inicio_estado   on public.disponibilidades (inicio, estado);
create index if not exists idx_disp_conductor_inicio on public.disponibilidades (conductor_id, inicio desc);
create index if not exists idx_asig_disp_estado      on public.asignaciones (disponibilidad_id, estado);

select 'Vista optimizada creada OK' as resultado;
