-- ============================================================
--  Agregar: datos enriquecidos de conductores + módulos
--  Cartera y Consolidado (con alerta de cartera en programación)
--  Ejecutar en: SQL Editor → New query → Run
-- ============================================================

-- 1) Columnas nuevas en conductores
alter table public.conductores add column if not exists apellidos      text default '';
alter table public.conductores add column if not exists correo         text default '';
alter table public.conductores add column if not exists licencia_num   text default '';
alter table public.conductores add column if not exists licencia_cat   text default '';
alter table public.conductores add column if not exists licencia_vence date;
alter table public.conductores add column if not exists eps            text default '';
alter table public.conductores add column if not exists arl            text default '';
alter table public.conductores add column if not exists tipo_sangre    text default '';
alter table public.conductores add column if not exists tel_emergencia text default '';
alter table public.conductores add column if not exists cod_interno    text default '';

-- 2) Tablas nuevas
create table if not exists public.cartera (
  id uuid primary key default gen_random_uuid(),
  placa text, num_interno text, identificacion text, nombre_afiliado text,
  celular text, correo text, empresa text, clase_vehiculo text, empresa_convenio text,
  ultimo_periodo_pago text, periodos_vencidos integer default 0, valor_vencido numeric default 0,
  estado text, importado_at timestamptz not null default now()
);
create index if not exists idx_cartera_placa on public.cartera (placa);

create table if not exists public.consolidado (
  id uuid primary key default gen_random_uuid(),
  placa text, num_interno text, nombre_propietario text, documento text, telefono text,
  celular text, email text, ciudad text, tar_operacion text, vence_operacion date,
  marca text, clase text, combustible text, carroceria text, pasajeros text, modelo text,
  cilindraje text, chasis text, motor text, soat_num text, soat_entidad text, soat_fecha date,
  seguros_entidad text, seguros_fecha date, tecmecanica_fecha date, preventiva_fecha date,
  tipo_convenio text, empresa_convenio text, estado text, estado_vehiculo text, empresa text,
  importado_at timestamptz not null default now()
);
create index if not exists idx_consolidado_placa on public.consolidado (placa);

-- 3) Funciones de importación
create or replace function public.importar_conductores(p_archivo text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_rol rol_usuario := public.get_my_role();
  v_new int := 0; v_upd int := 0; v_vin int := 0;
  v_cid uuid; v_vid uuid; v_doc text; v_placa text; v_existed boolean; v_i int;
begin
  if v_rol not in ('admin','jefe') then raise exception 'Solo admin o jefe pueden importar conductores.'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_doc := trim(coalesce(r->>'documento','')); if v_doc = '' then continue; end if;
    select id into v_cid from public.conductores where documento = v_doc;
    if v_cid is null then
      insert into public.conductores (nombre, documento, telefono, correo, apellidos,
        licencia_num, licencia_cat, licencia_vence, eps, arl, tipo_sangre, tel_emergencia, cod_interno)
      values (trim(coalesce(r->>'nombres','')||' '||coalesce(r->>'apellidos','')), v_doc,
        coalesce(r->>'celular',''), coalesce(r->>'correo',''), coalesce(r->>'apellidos',''),
        coalesce(r->>'licencia_num',''), coalesce(r->>'licencia_cat',''), (nullif(r->>'licencia_vence',''))::date,
        coalesce(r->>'eps',''), coalesce(r->>'arl',''), coalesce(r->>'tipo_sangre',''),
        coalesce(r->>'tel_emergencia',''), coalesce(r->>'cod_interno',''))
      returning id into v_cid; v_new := v_new + 1;
    else
      update public.conductores set
        nombre = coalesce(nullif(trim(coalesce(r->>'nombres','')||' '||coalesce(r->>'apellidos','')),''), nombre),
        telefono = coalesce(nullif(r->>'celular',''), telefono), correo = coalesce(nullif(r->>'correo',''), correo),
        apellidos = coalesce(nullif(r->>'apellidos',''), apellidos),
        licencia_num = coalesce(nullif(r->>'licencia_num',''), licencia_num),
        licencia_cat = coalesce(nullif(r->>'licencia_cat',''), licencia_cat),
        licencia_vence = coalesce((nullif(r->>'licencia_vence',''))::date, licencia_vence),
        eps = coalesce(nullif(r->>'eps',''), eps), arl = coalesce(nullif(r->>'arl',''), arl),
        tipo_sangre = coalesce(nullif(r->>'tipo_sangre',''), tipo_sangre),
        tel_emergencia = coalesce(nullif(r->>'tel_emergencia',''), tel_emergencia),
        cod_interno = coalesce(nullif(r->>'cod_interno',''), cod_interno)
      where id = v_cid; v_upd := v_upd + 1;
    end if;
    for v_i in 1..5 loop
      v_placa := upper(trim(coalesce(r->>('placa'||v_i), '')));
      if v_placa <> '' then
        select id into v_vid from public.vehiculos where placa = v_placa;
        if v_vid is null then insert into public.vehiculos (placa) values (v_placa) returning id into v_vid; end if;
        select exists(select 1 from public.conductor_vehiculo where conductor_id=v_cid and vehiculo_id=v_vid) into v_existed;
        if not v_existed then
          insert into public.conductor_vehiculo (conductor_id, vehiculo_id, asignado_por) values (v_cid, v_vid, auth.uid());
          v_vin := v_vin + 1;
        end if;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('ok',true,'nuevos',v_new,'actualizados',v_upd,'vinculos_nuevos',v_vin);
end $$;

create or replace function public.importar_cartera(p_archivo text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_rol rol_usuario := public.get_my_role(); v_n int := 0;
begin
  if v_rol not in ('admin','jefe') then raise exception 'Solo admin o jefe pueden importar cartera.'; end if;
  truncate table public.cartera;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.cartera (placa, num_interno, identificacion, nombre_afiliado, celular,
      correo, empresa, clase_vehiculo, empresa_convenio, ultimo_periodo_pago, periodos_vencidos, valor_vencido, estado)
    values (upper(trim(coalesce(r->>'placa',''))), r->>'num_interno', r->>'identificacion', r->>'nombre_afiliado',
      r->>'celular', r->>'correo', r->>'empresa', r->>'clase_vehiculo', r->>'empresa_convenio', r->>'ultimo_periodo_pago',
      coalesce((nullif(r->>'periodos_vencidos',''))::numeric::int,0), coalesce((nullif(r->>'valor_vencido',''))::numeric,0), r->>'estado');
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok',true,'filas',v_n);
end $$;

create or replace function public.importar_consolidado(p_archivo text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_rol rol_usuario := public.get_my_role(); v_n int := 0;
begin
  if v_rol not in ('admin','jefe') then raise exception 'Solo admin o jefe pueden importar el consolidado.'; end if;
  truncate table public.consolidado;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.consolidado (placa, num_interno, nombre_propietario, documento, telefono, celular, email,
      ciudad, tar_operacion, vence_operacion, marca, clase, combustible, carroceria, pasajeros, modelo, cilindraje,
      chasis, motor, soat_num, soat_entidad, soat_fecha, seguros_entidad, seguros_fecha, tecmecanica_fecha,
      preventiva_fecha, tipo_convenio, empresa_convenio, estado, estado_vehiculo, empresa)
    values (upper(trim(coalesce(r->>'placa',''))), r->>'num_interno', r->>'nombre_propietario', r->>'documento',
      r->>'telefono', r->>'celular', r->>'email', r->>'ciudad', r->>'tar_operacion', (nullif(r->>'vence_operacion',''))::date,
      r->>'marca', r->>'clase', r->>'combustible', r->>'carroceria', r->>'pasajeros', r->>'modelo', r->>'cilindraje',
      r->>'chasis', r->>'motor', r->>'soat_num', r->>'soat_entidad', (nullif(r->>'soat_fecha',''))::date,
      r->>'seguros_entidad', (nullif(r->>'seguros_fecha',''))::date, (nullif(r->>'tecmecanica_fecha',''))::date,
      (nullif(r->>'preventiva_fecha',''))::date, r->>'tipo_convenio', r->>'empresa_convenio', r->>'estado',
      r->>'estado_vehiculo', r->>'empresa');
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok',true,'filas',v_n);
end $$;

-- 4) Vista de cartera por vehículo + actualizar vista de disponibilidades
create or replace view public.v_cartera_vehiculo with (security_invoker = true) as
select upper(c.placa) as placa, max(c.periodos_vencidos) as periodos_vencidos,
       sum(c.valor_vencido) as valor_vencido, bool_or(c.periodos_vencidos > 0) as tiene_mora
from public.cartera c group by upper(c.placa);

create or replace view public.v_disponibilidades with (security_invoker = true) as
select d.id, d.conductor_id, d.vehiculo_id, d.inicio, d.fin, d.localidad, d.notas,
  d.estado, d.motivo_cancelacion, d.created_at, d.validada_at,
  c.nombre as conductor_nombre, c.documento, c.telefono,
  v.placa, v.tipo_vehiculo, v.numero_interno,
  a.id as asignacion_id, a.servicio, a.zona, a.estado as asignacion_estado, a.notas as asignacion_notas,
  coalesce(dv.criticos_pendientes,0) as docs_criticos_pendientes,
  coalesce(dv.criticos_vencidos,0) as docs_criticos_vencidos,
  coalesce(dv.docs_vencidos,0) as docs_vencidos, coalesce(dv.docs_sin_cargar,0) as docs_sin_cargar,
  dv.detalle_criticos,
  coalesce(cv.periodos_vencidos,0) as cartera_periodos_vencidos,
  coalesce(cv.valor_vencido,0) as cartera_valor_vencido
from public.disponibilidades d
join public.conductores c on c.id = d.conductor_id
join public.vehiculos v on v.id = d.vehiculo_id
left join public.asignaciones a on a.disponibilidad_id = d.id and a.estado <> 'cancelada'
left join public.v_docs_vehiculo dv on dv.vehiculo_id = v.id
left join public.v_cartera_vehiculo cv on cv.placa = v.placa;

-- 5) Permisos y RLS
grant select, insert, update, delete on public.cartera, public.consolidado to authenticated;
grant select on public.v_cartera_vehiculo, public.v_disponibilidades to anon, authenticated;

alter table public.cartera enable row level security;
alter table public.consolidado enable row level security;
drop policy if exists "staff lee cartera" on public.cartera;
create policy "staff lee cartera" on public.cartera for select using (public.is_staff());
drop policy if exists "admin gestiona cartera" on public.cartera;
create policy "admin gestiona cartera" on public.cartera for all
  using (public.get_my_role() in ('admin','jefe')) with check (public.get_my_role() in ('admin','jefe'));
drop policy if exists "staff lee consolidado" on public.consolidado;
create policy "staff lee consolidado" on public.consolidado for select using (public.is_staff());
drop policy if exists "admin gestiona consolidado" on public.consolidado;
create policy "admin gestiona consolidado" on public.consolidado for all
  using (public.get_my_role() in ('admin','jefe')) with check (public.get_my_role() in ('admin','jefe'));

-- Verificación
select 'Listo. Tablas creadas:' as msg,
  (select count(*) from information_schema.tables where table_name in ('cartera','consolidado')) as tablas;
