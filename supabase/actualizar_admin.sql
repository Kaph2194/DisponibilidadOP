-- ============================================================
--  ACTUALIZACIÓN → agrega el rol "admin" y las funciones de
--  cargue diario a un proyecto que YA tenía FleetSync instalado.
--
--  ⚠ IMPORTANTE — se ejecuta en DOS pasos separados, porque
--  Postgres no permite usar un valor de enum nuevo en la misma
--  transacción donde se creó.
-- ============================================================

-- ─────────────────────────────────────────────
--  PASO 1  ·  Ejecuta SOLO esta línea primero.
--  (Selecciónala, y dale Run. Espera el "Success".)
-- ─────────────────────────────────────────────

alter type rol_usuario add value if not exists 'admin';


-- ─────────────────────────────────────────────
--  PASO 2  ·  Después de que el paso 1 diga Success,
--  abre supabase/schema.sql y ejecútalo COMPLETO.
--  Los "create ... if not exists" no tocan tus datos;
--  solo agregan las tablas nuevas (documentos, cargues),
--  la función importar_cargue y las políticas del admin.
-- ─────────────────────────────────────────────

--  PASO 3  ·  Crea el usuario admin (o reutiliza crear_equipo.sql).
--  Si ya creaste el equipo antes y solo quieres agregar el admin:
--
--    -- 3a. créalo en Authentication → Users → Add user
--    --     (admin@specialcar.com.co + contraseña)
--    -- 3b. asígnale el rol:
--    select public.set_user_role('admin@specialcar.com.co', 'admin');
