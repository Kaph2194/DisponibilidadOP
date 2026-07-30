-- ============================================================
--  Migración v2.0 → v2.1
--  SOLO si ya ejecutaste el schema.sql anterior (donde la placa
--  vivía dentro de la tabla conductores) y tienes datos cargados.
--  Si tu proyecto está vacío, ignora este archivo y ejecuta
--  schema.sql directamente (puedes resetear la base en
--  Settings → Database → Reset database).
-- ============================================================

create extension if not exists btree_gist;

-- 1. Crear tabla de vehículos y poblarla desde conductores
create table if not exists public.vehiculos (
  id             uuid primary key default gen_random_uuid(),
  placa          text not null unique,
  tipo_vehiculo  text default '',
  numero_interno text default '',
  localidad      text default '',
  activo         boolean not null default true,
  created_at     timestamptz not null default now()
);

insert into public.vehiculos (placa, tipo_vehiculo, numero_interno, localidad)
select upper(trim(placa)), coalesce(tipo_vehiculo,''), coalesce(numero_interno,''), coalesce(localidad,'')
from public.conductores
where placa is not null and trim(placa) <> ''
on conflict (placa) do nothing;

-- 2. Tabla de vínculos y vínculo 1:1 heredado
create table if not exists public.conductor_vehiculo (
  id            uuid primary key default gen_random_uuid(),
  conductor_id  uuid not null references public.conductores(id) on delete cascade,
  vehiculo_id   uuid not null references public.vehiculos(id) on delete cascade,
  asignado_por  uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  unique (conductor_id, vehiculo_id)
);

insert into public.conductor_vehiculo (conductor_id, vehiculo_id)
select c.id, v.id
from public.conductores c
join public.vehiculos v on v.placa = upper(trim(c.placa))
on conflict (conductor_id, vehiculo_id) do nothing;

-- 3. Disponibilidades: agregar vehiculo_id y respaldar el dato
alter table public.disponibilidades add column if not exists vehiculo_id uuid references public.vehiculos(id);

update public.disponibilidades d
set vehiculo_id = v.id
from public.conductores c
join public.vehiculos v on v.placa = upper(trim(c.placa))
where d.conductor_id = c.id and d.vehiculo_id is null;

alter table public.disponibilidades alter column vehiculo_id set not null;

-- 4. Restricciones de NO solapamiento
alter table public.disponibilidades drop constraint if exists excl_vehiculo_horario;
alter table public.disponibilidades add constraint excl_vehiculo_horario
  exclude using gist (vehiculo_id with =, tstzrange(inicio,fin) with &&)
  where (estado in ('pendiente','validada'));

alter table public.disponibilidades drop constraint if exists excl_conductor_horario;
alter table public.disponibilidades add constraint excl_conductor_horario
  exclude using gist (conductor_id with =, tstzrange(inicio,fin) with &&)
  where (estado in ('pendiente','validada'));

-- 5. Ubicaciones: agregar vehiculo_id
alter table public.ubicaciones add column if not exists vehiculo_id uuid references public.vehiculos(id);
update public.ubicaciones u
set vehiculo_id = cv.vehiculo_id
from public.conductor_vehiculo cv
where cv.conductor_id = u.conductor_id and u.vehiculo_id is null;
delete from public.ubicaciones where vehiculo_id is null;
alter table public.ubicaciones alter column vehiculo_id set not null;

-- 6. Quitar columnas de vehículo de conductores
alter table public.conductores drop column if exists placa;
alter table public.conductores drop column if exists tipo_vehiculo;
alter table public.conductores drop column if exists numero_interno;

-- 7. Ahora ejecuta las secciones 3, 4 y 5 del schema.sql nuevo
--    (funciones, vistas y políticas RLS) para dejarlas actualizadas:
--    puedes pegar y correr el schema.sql COMPLETO sin problema —
--    los "create table if not exists" no tocarán tus datos.

-- ⚠ IMPORTANTE sobre cuentas de conductores ya registradas:
-- El email interno de los conductores cambió de placa@… a documento@…
-- Borra sus usuarios en Authentication → Users (solo los de conductores);
-- su cuenta se volverá a crear sola en el próximo ingreso.
update public.conductores set profile_id = null;
