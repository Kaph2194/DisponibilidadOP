-- ============================================================
--  SPECIAL CAR — FleetSync  |  Crear el equipo de operaciones
--  Ejecutar UNA VEZ en: SQL Editor → New query → Run
--
--  Crea las 6 cuentas de staff con contraseña temporal y asigna
--  su rol. Después, el jefe (José) gestiona todo desde la app.
--
--  ⚠ Cambia las contraseñas temporales antes de ejecutar, o pide
--  a cada persona que la cambie en su primer ingreso.
-- ============================================================

-- Requiere la extensión de administración de auth (ya viene en Supabase)
-- Creamos cada usuario y fijamos su rol en el metadata; el trigger
-- handle_new_user() creará su fila en profiles con ese rol.

do $$
declare
  v_pass text := 'Special2026*';   -- ← contraseña temporal para TODOS (cámbiala)
  emp record;
begin
  for emp in
    select * from (values
      ('admin@specialcar.com.co',    'Administrador','admin'),
      ('jose@specialcar.com.co',     'José',     'jefe'),
      ('christian@specialcar.com.co','Christian','coordinador'),
      ('miguel@specialcar.com.co',   'Miguel',   'coordinador'),
      ('nataly@specialcar.com.co',   'Nataly',   'coordinador'),
      ('claudia@specialcar.com.co',  'Claudia',  'coordinador'),
      ('juan@specialcar.com.co',     'Juan',     'analista')
    ) as t(email, nombre, rol)
  loop
    -- Crear el usuario en auth solo si no existe
    if not exists (select 1 from auth.users where email = emp.email) then
      insert into auth.users (
        instance_id, id, aud, role, email,
        encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000',
        gen_random_uuid(), 'authenticated', 'authenticated', emp.email,
        crypt(v_pass, gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}',
        json_build_object('role', emp.rol, 'full_name', emp.nombre),
        now(), now()
      );
    end if;

    -- Asegurar el perfil con el rol correcto
    insert into public.profiles (id, role, full_name)
    select id, emp.rol::rol_usuario, emp.nombre
    from auth.users where email = emp.email
    on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
  end loop;
end $$;

-- Verifica el resultado:
select p.full_name, u.email, p.role
from public.profiles p
join auth.users u on u.id = p.id
where p.role in ('coordinador','analista','jefe')
order by p.role, p.full_name;

-- ============================================================
--  CONTRASEÑA TEMPORAL: Special2026*  (para las 6 cuentas)
--
--  Cuentas creadas:
--   Administrador admin@specialcar.com.co     → admin (configura TODO)
--   José       jose@specialcar.com.co        → jefe
--   Christian  christian@specialcar.com.co   → coordinador
--   Miguel     miguel@specialcar.com.co      → coordinador
--   Nataly     nataly@specialcar.com.co      → coordinador
--   Claudia    claudia@specialcar.com.co     → coordinador
--   Juan       juan@specialcar.com.co        → analista
--
--  El admin y José pueden gestionar el equipo (crear, eliminar,
--  cambiar roles). El admin además carga la base diaria de
--  conductores desde el Excel (menú "Base de datos").
-- ============================================================
