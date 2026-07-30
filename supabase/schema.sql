-- ============================================================
--  SPECIAL CAR — FleetSync v2.1  |  Esquema Supabase
--  Ejecutar completo en: Supabase Dashboard → SQL Editor → Run
--
--  Modelo: conductores (personas) ⟷ vehículos es MUCHOS A MUCHOS.
--  · Un vehículo puede tener varios conductores, pero NO en el
--    mismo horario (garantizado por la base de datos).
--  · Un conductor puede estar en varios vehículos, pero NO en el
--    mismo horario (garantizado por la base de datos).
--  · Coordinador y Jefe de operación vinculan conductores a vehículos.
-- ============================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;   -- para las restricciones de solapamiento

-- ------------------------------------------------------------
-- 1. TIPOS
-- ------------------------------------------------------------
do $$ begin
  create type rol_usuario as enum ('conductor','analista','coordinador','jefe','admin');
exception when duplicate_object then null; end $$;

-- NOTA: si ya tenías el enum SIN 'admin' (versión anterior), NO ejecutes
-- este schema directamente sobre él. Usa primero supabase/actualizar_admin.sql,
-- que agrega el valor 'admin' en su propia transacción, y luego sí corre este.

do $$ begin
  create type estado_disponibilidad as enum ('pendiente','validada','rechazada','cancelada');
exception when duplicate_object then null; end $$;

do $$ begin
  create type estado_asignacion as enum ('programada','en_curso','completada','cancelada');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------
-- 2. TABLAS
-- ------------------------------------------------------------

-- Perfil de cada usuario autenticado (1:1 con auth.users)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        rol_usuario not null default 'conductor',
  full_name   text not null default '',
  phone       text default '',
  created_at  timestamptz not null default now()
);

-- Conductores = PERSONAS
create table if not exists public.conductores (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid unique references public.profiles(id) on delete set null,
  nombre      text not null,
  documento   text not null unique,          -- cédula = PIN de acceso
  telefono    text default '',
  localidad   text default '',
  empresa     text default '',               -- empresa afiliadora (del cargue)
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Vehículos = FLOTA
create table if not exists public.vehiculos (
  id             uuid primary key default gen_random_uuid(),
  placa          text not null unique,
  tipo_vehiculo  text default '',
  numero_interno text default '',
  localidad      text default '',
  empresa        text default '',
  activo         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Documentos de vigencia (SOAT, tecnomecánica, licencia, etc.) del cargue diario
create table if not exists public.documentos (
  id                uuid primary key default gen_random_uuid(),
  placa             text,
  documento_persona text,                     -- nro identificación del titular
  nombre_persona    text,
  tipo_titular      text,                      -- 'Afiliado' | 'Conductor'
  nombre_documento  text not null,             -- 'Copia SOAT', etc.
  inicio_vigencia   date,
  vigente_hasta     date,
  estado            text,                      -- 'Vigente' | 'Expiro' | 'Sin Cargar'
  fecha_cargue      timestamptz,
  usuario_cargue    text,
  empresa           text,
  importado_at      timestamptz not null default now()
);
create index if not exists idx_doc_placa on public.documentos (placa);
create index if not exists idx_doc_persona on public.documentos (documento_persona);
create index if not exists idx_doc_estado on public.documentos (estado);
create index if not exists idx_doc_vence on public.documentos (vigente_hasta);

-- Registro de cada cargue diario (auditoría)
create table if not exists public.cargues (
  id               uuid primary key default gen_random_uuid(),
  archivo          text,
  filas            integer default 0,
  conductores_new  integer default 0,
  vehiculos_new    integer default 0,
  vinculos_new     integer default 0,
  documentos       integer default 0,
  cargado_por      uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);

-- Vínculo conductor ⟷ vehículo (quién puede operar qué)
create table if not exists public.conductor_vehiculo (
  id            uuid primary key default gen_random_uuid(),
  conductor_id  uuid not null references public.conductores(id) on delete cascade,
  vehiculo_id   uuid not null references public.vehiculos(id) on delete cascade,
  asignado_por  uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  unique (conductor_id, vehiculo_id)
);
create index if not exists idx_cv_vehiculo on public.conductor_vehiculo (vehiculo_id);

-- Disponibilidades (turnos: conductor + vehículo + rango horario)
create table if not exists public.disponibilidades (
  id                 uuid primary key default gen_random_uuid(),
  conductor_id       uuid not null references public.conductores(id) on delete cascade,
  vehiculo_id        uuid not null references public.vehiculos(id) on delete cascade,
  inicio             timestamptz not null,
  fin                timestamptz not null,
  localidad          text not null default '',
  notas              text default '',
  estado             estado_disponibilidad not null default 'pendiente',
  motivo_cancelacion text default '',
  creada_por         uuid references public.profiles(id),
  validada_por       uuid references public.profiles(id),
  validada_at        timestamptz,
  created_at         timestamptz not null default now(),
  constraint chk_rango check (fin > inicio),

  -- ⛔ Un VEHÍCULO no puede tener dos turnos que se crucen en el tiempo
  constraint excl_vehiculo_horario exclude using gist (
    vehiculo_id with =,
    tstzrange(inicio, fin) with &&
  ) where (estado in ('pendiente','validada')),

  -- ⛔ Un CONDUCTOR no puede tener dos turnos que se crucen (aunque sean vehículos distintos)
  constraint excl_conductor_horario exclude using gist (
    conductor_id with =,
    tstzrange(inicio, fin) with &&
  ) where (estado in ('pendiente','validada'))
);
create index if not exists idx_disp_inicio on public.disponibilidades (inicio);
create index if not exists idx_disp_estado on public.disponibilidades (estado);

-- Asignaciones (programación del coordinador sobre una disponibilidad)
create table if not exists public.asignaciones (
  id                 uuid primary key default gen_random_uuid(),
  disponibilidad_id  uuid not null unique references public.disponibilidades(id) on delete cascade,
  servicio           text not null default '',
  zona               text default '',
  notas              text default '',
  estado             estado_asignacion not null default 'programada',
  asignada_por       uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Ubicaciones del vehículo (GPS reportado por el conductor)
create table if not exists public.ubicaciones (
  id            uuid primary key default gen_random_uuid(),
  conductor_id  uuid not null references public.conductores(id) on delete cascade,
  vehiculo_id   uuid not null references public.vehiculos(id) on delete cascade,
  lat           double precision not null,
  lng           double precision not null,
  precision_m   double precision,
  reportada_at  timestamptz not null default now()
);
create index if not exists idx_ubic_vehiculo on public.ubicaciones (vehiculo_id, reportada_at desc);

-- ------------------------------------------------------------
-- 3. FUNCIONES AUXILIARES
-- ------------------------------------------------------------

create or replace function public.get_my_role()
returns rol_usuario
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.get_my_conductor_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.conductores where profile_id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.get_my_role() in ('analista', 'coordinador', 'jefe', 'admin'), false);
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.get_my_role() = 'admin', false);
$$;

-- Importación masiva del cargue diario de documentos/afiliados.
-- Recibe un JSON con las filas del Excel ya normalizadas por el navegador.
-- Deriva conductores, vehículos, vínculos y documentos; NO borra disponibilidades.
-- Solo admin y jefe pueden ejecutarla.
create or replace function public.importar_cargue(p_archivo text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  v_rol rol_usuario := public.get_my_role();
  v_cond_new int := 0; v_veh_new int := 0; v_vin_new int := 0; v_doc int := 0;
  v_cid uuid; v_vid uuid; v_existed boolean;
  v_placa text; v_doc_pers text; v_nombre text; v_tipo text; v_empresa text;
begin
  if v_rol not in ('admin','jefe') then
    raise exception 'Solo admin o jefe pueden importar el cargue.';
  end if;

  -- Reemplazar el snapshot de documentos (es una foto diaria)
  truncate table public.documentos;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_placa    := upper(trim(coalesce(r->>'placa','')));
    v_doc_pers := trim(coalesce(r->>'documento_persona',''));
    v_nombre   := trim(coalesce(r->>'nombre_persona',''));
    v_tipo     := trim(coalesce(r->>'tipo_titular',''));
    v_empresa  := trim(coalesce(r->>'empresa',''));

    -- Vehículo (por placa)
    if v_placa <> '' then
      select id into v_vid from public.vehiculos where placa = v_placa;
      if v_vid is null then
        insert into public.vehiculos (placa, empresa) values (v_placa, v_empresa)
        returning id into v_vid;
        v_veh_new := v_veh_new + 1;
      elsif v_empresa <> '' then
        update public.vehiculos set empresa = v_empresa where id = v_vid and coalesce(empresa,'')='';
      end if;
    else
      v_vid := null;
    end if;

    -- Conductor (solo filas tipo 'Conductor', por documento)
    if v_tipo = 'Conductor' and v_doc_pers <> '' and v_nombre <> '' then
      select id into v_cid from public.conductores where documento = v_doc_pers;
      if v_cid is null then
        insert into public.conductores (nombre, documento, empresa)
        values (v_nombre, v_doc_pers, v_empresa)
        returning id into v_cid;
        v_cond_new := v_cond_new + 1;
      else
        update public.conductores set nombre = v_nombre
        where id = v_cid and (nombre is null or nombre = '');
      end if;

      -- Vínculo conductor ⟷ vehículo
      if v_vid is not null then
        select exists(select 1 from public.conductor_vehiculo
                      where conductor_id = v_cid and vehiculo_id = v_vid) into v_existed;
        if not v_existed then
          insert into public.conductor_vehiculo (conductor_id, vehiculo_id, asignado_por)
          values (v_cid, v_vid, auth.uid());
          v_vin_new := v_vin_new + 1;
        end if;
      end if;
    end if;

    -- Documento de vigencia
    insert into public.documentos (
      placa, documento_persona, nombre_persona, tipo_titular, nombre_documento,
      inicio_vigencia, vigente_hasta, estado, fecha_cargue, usuario_cargue, empresa
    ) values (
      nullif(v_placa,''), nullif(v_doc_pers,''), nullif(v_nombre,''), nullif(v_tipo,''),
      coalesce(nullif(trim(r->>'nombre_documento'),''),'(sin nombre)'),
      (nullif(r->>'inicio_vigencia',''))::date,
      (nullif(r->>'vigente_hasta',''))::date,
      nullif(trim(r->>'estado'),''),
      (nullif(r->>'fecha_cargue',''))::timestamptz,
      nullif(trim(r->>'usuario_cargue'),''),
      nullif(v_empresa,'')
    );
    v_doc := v_doc + 1;
  end loop;

  insert into public.cargues (archivo, filas, conductores_new, vehiculos_new, vinculos_new, documentos, cargado_por)
  values (p_archivo, jsonb_array_length(p_rows), v_cond_new, v_veh_new, v_vin_new, v_doc, auth.uid());

  return jsonb_build_object(
    'ok', true, 'filas', jsonb_array_length(p_rows),
    'conductores_nuevos', v_cond_new, 'vehiculos_nuevos', v_veh_new,
    'vinculos_nuevos', v_vin_new, 'documentos', v_doc
  );
end $$;

-- La disponibilidad solo es válida si el conductor está vinculado al vehículo
create or replace function public.check_vinculo_disponibilidad()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.conductor_vehiculo cv
    where cv.conductor_id = new.conductor_id
      and cv.vehiculo_id  = new.vehiculo_id
  ) then
    raise exception 'El conductor no está vinculado a ese vehículo. Pide al coordinador o jefe que cree el vínculo.';
  end if;
  return new;
end $$;

drop trigger if exists trg_disp_vinculo on public.disponibilidades;
create trigger trg_disp_vinculo
  before insert or update of conductor_id, vehiculo_id on public.disponibilidades
  for each row execute function public.check_vinculo_disponibilidad();

-- Verifica placa+documento ANTES de crear la cuenta (primer ingreso del conductor).
-- La pareja debe existir como vínculo activo. Security definer: funciona sin sesión.
create or replace function public.verificar_conductor(p_placa text, p_documento text)
returns table (conductor_id uuid, nombre text, ya_registrado boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  return query
  select c.id, c.nombre, (c.profile_id is not null)
  from public.conductores c
  join public.conductor_vehiculo cv on cv.conductor_id = c.id
  join public.vehiculos v on v.id = cv.vehiculo_id
  where trim(c.documento) = trim(p_documento)
    and upper(trim(v.placa)) = upper(trim(p_placa))
    and c.activo and v.activo
  limit 1;
end $$;

grant execute on function public.verificar_conductor(text, text) to anon, authenticated;

-- Al crearse un usuario en auth.users → crear su perfil y vincular conductor si aplica
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role      rol_usuario := coalesce((new.raw_user_meta_data->>'role')::rol_usuario, 'conductor');
  v_conductor uuid        := nullif(new.raw_user_meta_data->>'conductor_id','')::uuid;
  v_name      text        := coalesce(new.raw_user_meta_data->>'full_name','');
begin
  insert into public.profiles (id, role, full_name)
  values (new.id, v_role, v_name)
  on conflict (id) do nothing;

  if v_role = 'conductor' and v_conductor is not null then
    update public.conductores
       set profile_id = new.id
     where id = v_conductor and profile_id is null;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Promover usuarios de staff (ejecútalo desde el SQL Editor tras crearlos)
-- Ejemplo: select public.set_user_role('jefe@specialcar.co', 'jefe');
create or replace function public.set_user_role(p_email text, p_role rol_usuario)
returns text
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where email = lower(p_email);
  if v_id is null then return 'No existe usuario con ese email'; end if;
  insert into public.profiles (id, role) values (v_id, p_role)
  on conflict (id) do update set role = excluded.role;
  return 'OK: ' || p_email || ' → ' || p_role;
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_asig_touch on public.asignaciones;
create trigger trg_asig_touch before update on public.asignaciones
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 4. VISTAS (security_invoker: respetan RLS)
-- ------------------------------------------------------------
-- unaccent casero (evita depender de la extensión unaccent)
create or replace function public.unaccent_simple(t text)
returns text language sql immutable as $$
  select translate(coalesce(t,''),
    'áàäâãéèëêíìïîóòöôõúùüûñÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑ',
    'aaaaaeeeeiiiiooooouuuunAAAAAEEEEIIIIOOOOOUUUUN');
$$;

-- Documentos CRÍTICOS para circular/despachar (legal y operativo).
-- Si alguno está vencido o sin cargar, el vehículo NO debería despacharse.
create or replace function public.es_documento_critico(p_nombre text)
returns boolean
language sql immutable set search_path = public as $$
  select lower(unaccent_simple(coalesce(p_nombre,''))) similar to
    '%(soat|tecnico-mecanic|tecnicomecanic|tecnomecanic|revision preventiva|licencia de conduccion|'
    || 'seguro responsabilidad|tarjeta de operacion|examenes medicos|planilla seguridad social)%';
$$;

-- Estado de documentos por vehículo (para alertar antes de despachar)
create or replace view public.v_docs_vehiculo
with (security_invoker = true) as
select
  v.id as vehiculo_id, v.placa,
  count(*) filter (where d.estado = 'Expiro')      as docs_vencidos,
  count(*) filter (where d.estado = 'Sin Cargar')  as docs_sin_cargar,
  count(*) filter (where d.estado = 'Vigente')     as docs_vigentes,
  -- Críticos en mal estado (vencido o sin cargar)
  count(*) filter (where public.es_documento_critico(d.nombre_documento)
                     and d.estado in ('Expiro','Sin Cargar'))            as criticos_pendientes,
  count(*) filter (where public.es_documento_critico(d.nombre_documento)
                     and d.estado = 'Expiro')                            as criticos_vencidos,
  -- Lista de nombres de los documentos críticos en problema (para el mensaje)
  string_agg(distinct
     case when public.es_documento_critico(d.nombre_documento)
               and d.estado in ('Expiro','Sin Cargar')
          then d.nombre_documento || ' (' || d.estado || ')' end, ', ')  as detalle_criticos,
  min(d.vigente_hasta) filter (where d.estado = 'Vigente') as proximo_vencimiento
from public.vehiculos v
left join public.documentos d on upper(d.placa) = v.placa
group by v.id, v.placa;


create or replace view public.v_disponibilidades
with (security_invoker = true) as
select
  d.id, d.conductor_id, d.vehiculo_id, d.inicio, d.fin, d.localidad, d.notas,
  d.estado, d.motivo_cancelacion, d.created_at, d.validada_at,
  c.nombre  as conductor_nombre,
  c.documento, c.telefono,
  v.placa, v.tipo_vehiculo, v.numero_interno,
  a.id       as asignacion_id,
  a.servicio, a.zona,
  a.estado   as asignacion_estado,
  a.notas    as asignacion_notas,
  coalesce(dv.criticos_pendientes,0) as docs_criticos_pendientes,
  coalesce(dv.criticos_vencidos,0)   as docs_criticos_vencidos,
  coalesce(dv.docs_vencidos,0)       as docs_vencidos,
  coalesce(dv.docs_sin_cargar,0)     as docs_sin_cargar,
  dv.detalle_criticos
from public.disponibilidades d
join public.conductores c on c.id = d.conductor_id
join public.vehiculos   v on v.id = d.vehiculo_id
left join public.asignaciones a
  on a.disponibilidad_id = d.id and a.estado <> 'cancelada'
left join public.v_docs_vehiculo dv on dv.vehiculo_id = v.id;

-- Vínculos con nombres, para la UI
create or replace view public.v_vinculos
with (security_invoker = true) as
select cv.id, cv.conductor_id, cv.vehiculo_id, cv.created_at,
       c.nombre as conductor_nombre, c.documento, c.telefono,
       v.placa, v.tipo_vehiculo, v.numero_interno
from public.conductor_vehiculo cv
join public.conductores c on c.id = cv.conductor_id
join public.vehiculos   v on v.id = cv.vehiculo_id;

-- Última ubicación reportada por vehículo
create or replace view public.v_ultima_ubicacion
with (security_invoker = true) as
select distinct on (u.vehiculo_id)
  u.vehiculo_id, u.conductor_id, u.lat, u.lng, u.precision_m, u.reportada_at,
  v.placa, c.nombre, v.localidad
from public.ubicaciones u
join public.vehiculos   v on v.id = u.vehiculo_id
join public.conductores c on c.id = u.conductor_id
order by u.vehiculo_id, u.reportada_at desc;

-- ------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.conductores        enable row level security;
alter table public.vehiculos          enable row level security;
alter table public.conductor_vehiculo enable row level security;
alter table public.disponibilidades   enable row level security;
alter table public.asignaciones       enable row level security;
alter table public.ubicaciones        enable row level security;
alter table public.documentos         enable row level security;
alter table public.cargues            enable row level security;

-- documentos: staff lee, admin/jefe gestionan (el import va por RPC security definer)
drop policy if exists "staff lee documentos" on public.documentos;
create policy "staff lee documentos" on public.documentos
  for select using (public.is_staff());

drop policy if exists "admin gestiona documentos" on public.documentos;
create policy "admin gestiona documentos" on public.documentos
  for all using (public.get_my_role() in ('admin', 'jefe')) with check (public.get_my_role() in ('admin', 'jefe'));

-- cargues: staff lee, admin/jefe insertan
drop policy if exists "staff lee cargues" on public.cargues;
create policy "staff lee cargues" on public.cargues
  for select using (public.is_staff());

drop policy if exists "admin registra cargues" on public.cargues;
create policy "admin registra cargues" on public.cargues
  for insert with check (public.get_my_role() in ('admin', 'jefe'));

-- profiles
drop policy if exists "perfil propio o staff lee" on public.profiles;
create policy "perfil propio o staff lee" on public.profiles
  for select using (id = auth.uid() or public.is_staff());

drop policy if exists "perfil propio actualiza" on public.profiles;
create policy "perfil propio actualiza" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid() and role = public.get_my_role());

-- conductores (personas)
drop policy if exists "conductor ve lo suyo, staff todo" on public.conductores;
create policy "conductor ve lo suyo, staff todo" on public.conductores
  for select using (profile_id = auth.uid() or public.is_staff());

drop policy if exists "staff crea conductores" on public.conductores;
create policy "staff crea conductores" on public.conductores
  for insert with check (public.get_my_role() in ('coordinador', 'jefe', 'analista', 'admin'));

drop policy if exists "staff o dueño actualiza conductor" on public.conductores;
create policy "staff o dueño actualiza conductor" on public.conductores
  for update using (profile_id = auth.uid() or public.get_my_role() in ('coordinador', 'jefe', 'analista', 'admin'));

drop policy if exists "coordinador o jefe elimina conductor" on public.conductores;
create policy "coordinador o jefe elimina conductor" on public.conductores
  for delete using (public.get_my_role() in ('coordinador', 'jefe', 'admin'));

-- vehiculos
drop policy if exists "ve vehiculos: staff o conductor vinculado" on public.vehiculos;
create policy "ve vehiculos: staff o conductor vinculado" on public.vehiculos
  for select using (
    public.is_staff()
    or exists (select 1 from public.conductor_vehiculo cv
               where cv.vehiculo_id = id and cv.conductor_id = public.get_my_conductor_id())
  );

drop policy if exists "coordinador o jefe crea vehiculo" on public.vehiculos;
create policy "coordinador o jefe crea vehiculo" on public.vehiculos
  for insert with check (public.get_my_role() in ('coordinador', 'jefe', 'admin'));

drop policy if exists "coordinador o jefe edita vehiculo" on public.vehiculos;
create policy "coordinador o jefe edita vehiculo" on public.vehiculos
  for update using (public.get_my_role() in ('coordinador', 'jefe', 'admin'));

drop policy if exists "coordinador o jefe elimina vehiculo" on public.vehiculos;
create policy "coordinador o jefe elimina vehiculo" on public.vehiculos
  for delete using (public.get_my_role() in ('coordinador', 'jefe', 'admin'));

-- conductor_vehiculo (vínculos): SOLO coordinador y jefe los administran
drop policy if exists "ve vinculos: staff o propios" on public.conductor_vehiculo;
create policy "ve vinculos: staff o propios" on public.conductor_vehiculo
  for select using (public.is_staff() or conductor_id = public.get_my_conductor_id());

drop policy if exists "coordinador o jefe vincula" on public.conductor_vehiculo;
create policy "coordinador o jefe vincula" on public.conductor_vehiculo
  for insert with check (public.get_my_role() in ('coordinador', 'jefe', 'admin'));

drop policy if exists "coordinador o jefe desvincula" on public.conductor_vehiculo;
create policy "coordinador o jefe desvincula" on public.conductor_vehiculo
  for delete using (public.get_my_role() in ('coordinador', 'jefe', 'admin'));

-- disponibilidades
drop policy if exists "lee: dueño o staff" on public.disponibilidades;
create policy "lee: dueño o staff" on public.disponibilidades
  for select using (conductor_id = public.get_my_conductor_id() or public.is_staff());

drop policy if exists "crea: dueño o analista/coordinador" on public.disponibilidades;
create policy "crea: dueño o analista/coordinador" on public.disponibilidades
  for insert with check (
    conductor_id = public.get_my_conductor_id()
    or public.get_my_role() in ('analista', 'coordinador', 'admin')
  );

drop policy if exists "actualiza: dueño o staff" on public.disponibilidades;
create policy "actualiza: dueño o staff" on public.disponibilidades
  for update using (
    conductor_id = public.get_my_conductor_id()
    or public.get_my_role() in ('analista', 'coordinador', 'admin')
  );

-- asignaciones
drop policy if exists "staff y dueño leen asignaciones" on public.asignaciones;
create policy "staff y dueño leen asignaciones" on public.asignaciones
  for select using (
    public.is_staff()
    or exists (select 1 from public.disponibilidades d
               where d.id = disponibilidad_id
                 and d.conductor_id = public.get_my_conductor_id())
  );

drop policy if exists "coordinador programa" on public.asignaciones;
create policy "coordinador programa" on public.asignaciones
  for insert with check (public.get_my_role() in ('coordinador','admin'));

drop policy if exists "coordinador actualiza asignacion" on public.asignaciones;
create policy "coordinador actualiza asignacion" on public.asignaciones
  for update using (public.get_my_role() in ('coordinador','admin'));

drop policy if exists "coordinador elimina asignacion" on public.asignaciones;
create policy "coordinador elimina asignacion" on public.asignaciones
  for delete using (public.get_my_role() in ('coordinador','admin'));

-- ubicaciones
drop policy if exists "conductor reporta su ubicacion" on public.ubicaciones;
create policy "conductor reporta su ubicacion" on public.ubicaciones
  for insert with check (
    conductor_id = public.get_my_conductor_id()
    and exists (select 1 from public.conductor_vehiculo cv
                where cv.conductor_id = conductor_id and cv.vehiculo_id = vehiculo_id)
  );

drop policy if exists "lee ubicaciones: dueño o staff" on public.ubicaciones;
create policy "lee ubicaciones: dueño o staff" on public.ubicaciones
  for select using (conductor_id = public.get_my_conductor_id() or public.is_staff());

-- ------------------------------------------------------------
-- 6. DATOS DE EJEMPLO (opcional — borra esta sección en producción)
-- Nota: un vehículo con 2 conductores y un conductor con 2 vehículos,
-- para probar las reglas de solapamiento.
-- ------------------------------------------------------------
insert into public.vehiculos (placa, tipo_vehiculo, numero_interno, localidad) values
  ('ABC123','Van','SC-01','Suba'),
  ('DEF456','Camioneta','SC-02','Kennedy'),
  ('GHI789','Van','SC-03','Engativá')
on conflict (placa) do nothing;

insert into public.conductores (nombre, documento, telefono, localidad) values
  ('Carlos Pérez','1012345678','3001112233','Suba'),
  ('María Gómez','1023456789','3002223344','Kennedy'),
  ('Jorge Ramírez','1034567890','3003334455','Engativá')
on conflict (documento) do nothing;

insert into public.conductor_vehiculo (conductor_id, vehiculo_id)
select c.id, v.id from public.conductores c, public.vehiculos v
where (c.documento,v.placa) in (
  ('1012345678','ABC123'),   -- Carlos → ABC123
  ('1023456789','ABC123'),   -- María también puede operar ABC123 (otro horario)
  ('1023456789','DEF456'),   -- María → DEF456 (dos vehículos)
  ('1034567890','GHI789')    -- Jorge → GHI789
)
on conflict (conductor_id, vehiculo_id) do nothing;

-- ============================================================
--  DESPUÉS DE EJECUTAR ESTE SCRIPT:
--  1. Authentication → Providers → Email: desactiva "Confirm email"
--  2. Crea los usuarios de staff en Authentication → Users y asigna rol:
--       select public.set_user_role('coordinador@tuempresa.co', 'coordinador');
--       select public.set_user_role('analista@tuempresa.co',    'analista');
--       select public.set_user_role('jefe@tuempresa.co',        'jefe');
--  3. Los conductores NO se crean en Authentication: su cuenta se
--     crea sola en el primer ingreso con Placa + Documento
--     (la placa debe ser de un vehículo al que estén vinculados).
--
--  Si ya habías ejecutado la versión anterior (v2.0) del esquema,
--  usa supabase/migracion_v2_a_v2.1.sql en lugar de este archivo,
--  o restablece la base de datos y ejecuta este completo.
-- ============================================================
