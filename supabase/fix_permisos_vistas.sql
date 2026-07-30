-- ============================================================
--  FIX CRÍTICO · Permisos de vistas y visibilidad de vehículos
--
--  Soluciona:
--   · "permission denied for view v_disponibilidades / v_vinculos"
--   · Los botones "Actualizar" no traían datos / reportería en 0
--   · El conductor veía "Sin vehículos vinculados" pese a estarlo
--
--  Ejecutar en: SQL Editor → New query → Run
-- ============================================================

-- 1) GRANT sobre las vistas y tablas (las vistas con security_invoker
--    necesitan permiso explícito; la seguridad la dan las políticas RLS).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;

-- 2) Función security-definer para que el conductor pueda ver el vehículo
--    al que está vinculado, sin que la RLS anidada lo bloquee.
create or replace function public.conductor_ve_vehiculo(p_vehiculo uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conductor_vehiculo cv
    where cv.vehiculo_id = p_vehiculo
      and cv.conductor_id = public.get_my_conductor_id()
  );
$$;

-- 3) Reemplazar la política de vehículos para usar esa función.
drop policy if exists "ve vehiculos: staff o conductor vinculado" on public.vehiculos;
create policy "ve vehiculos: staff o conductor vinculado" on public.vehiculos
  for select using (
    public.is_staff()
    or public.conductor_ve_vehiculo(id)
  );

-- Verificación rápida (debe listar todas tus vistas sin error):
select count(*) as vehiculos from public.vehiculos;
