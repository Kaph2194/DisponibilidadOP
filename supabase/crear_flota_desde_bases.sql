-- ============================================================
--  CREAR LA FLOTA DESDE LAS BASES DE DATOS Y EL CONSOLIDADO
--  Ejecutar en: Supabase → SQL Editor → New query → Run
--  (Es seguro correrlo varias veces: no duplica nada.)
--
--  Qué hace:
--   1. Cada cargue (Documentos, Conductores, Cartera y Consolidado)
--      crea en la FLOTA (tabla vehiculos) toda placa que no exista y
--      completa número interno, clase y empresa.
--   2. Consolidado y Cartera además registran al PROPIETARIO /
--      AFILIADO como conductor y lo vinculan a su placa, para que
--      pueda ingresar con Placa + Documento.
--   3. Normaliza placas ("abc-123" → ABC123) y documentos
--      ("1.023.456" → 1023456) para que el ingreso no falle por formato.
--   4. Al final SINCRONIZA lo que ya está cargado hoy (documentos,
--      cartera y consolidado) → crea los vehículos y vínculos que falten.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Normalizadores
-- ------------------------------------------------------------
create or replace function public.norm_placa(t text)
returns text language sql immutable as $$
  select regexp_replace(upper(coalesce(t,'')), '[^A-Z0-9]', '', 'g');
$$;

create or replace function public.norm_doc(t text)
returns text language sql immutable as $$
  -- quita ".0" que deja Excel en celdas numéricas, y puntos/espacios/guiones
  select regexp_replace(regexp_replace(trim(coalesce(t,'')), '\.0+$', ''), '[^0-9A-Za-z]', '', 'g');
$$;

-- ¿El nombre es de una empresa (SAS, LTDA…) y no de una persona?
create or replace function public.es_persona_juridica(t text)
returns boolean language sql immutable as $$
  select upper(coalesce(t,'')) ~ '(\mSAS\M|S\.\s?A\.\s?S|\mLTDA\M|\mS\.?\s?A\.?$|SOCIEDAD|COOPERATIVA|CORPORACI|FUNDACI|\mE\.?\s?U\.?$|\mLIMITADA\M|TRANSPORTES)';
$$;

create index if not exists idx_vehiculos_norm_placa on public.vehiculos (public.norm_placa(placa));
create index if not exists idx_conductores_norm_doc on public.conductores (public.norm_doc(documento));

-- ------------------------------------------------------------
-- 2. Núcleo interno: crea/actualiza vehículo y (opcional) vincula titular
--    Devuelve: {veh_new, cond_new, vin_new} como 0/1
-- ------------------------------------------------------------
create or replace function public._flota_registrar(
  p_placa text, p_num_interno text, p_tipo text, p_empresa text,
  p_doc text, p_nombre text, p_tel text, p_correo text)
returns int[]
language plpgsql security definer set search_path = public as $$
declare
  v_placa text := public.norm_placa(p_placa);
  v_doc   text := public.norm_doc(p_doc);
  v_nom   text := trim(coalesce(p_nombre,''));
  v_vid uuid; v_cid uuid;
  v_veh int := 0; v_cond int := 0; v_vin int := 0;
begin
  if length(v_placa) < 4 then return array[0,0,0]; end if;

  -- Vehículo
  select id into v_vid from public.vehiculos where public.norm_placa(placa) = v_placa limit 1;
  if v_vid is null then
    insert into public.vehiculos (placa, numero_interno, tipo_vehiculo, empresa)
    values (v_placa, coalesce(trim(p_num_interno),''), coalesce(trim(p_tipo),''), coalesce(trim(p_empresa),''))
    returning id into v_vid;
    v_veh := 1;
  else
    update public.vehiculos set
      numero_interno = case when coalesce(numero_interno,'')='' then coalesce(trim(p_num_interno),'') else numero_interno end,
      tipo_vehiculo  = case when coalesce(tipo_vehiculo,'')=''  then coalesce(trim(p_tipo),'')        else tipo_vehiculo  end,
      empresa        = case when coalesce(empresa,'')=''        then coalesce(trim(p_empresa),'')     else empresa        end
    where id = v_vid;
  end if;

  -- Titular (propietario/afiliado) como conductor vinculado
  if length(v_doc) >= 5 and v_nom <> '' and not public.es_persona_juridica(v_nom) then
    select id into v_cid from public.conductores where public.norm_doc(documento) = v_doc limit 1;
    if v_cid is null then
      insert into public.conductores (nombre, documento, telefono, correo, empresa)
      values (v_nom, v_doc, coalesce(trim(p_tel),''), coalesce(trim(p_correo),''), coalesce(trim(p_empresa),''))
      returning id into v_cid;
      v_cond := 1;
    else
      update public.conductores set
        telefono = case when coalesce(telefono,'')='' then coalesce(trim(p_tel),'')    else telefono end,
        correo   = case when coalesce(correo,'')=''   then coalesce(trim(p_correo),'') else correo   end,
        empresa  = case when coalesce(empresa,'')=''  then coalesce(trim(p_empresa),'') else empresa end
      where id = v_cid;
    end if;

    insert into public.conductor_vehiculo (conductor_id, vehiculo_id, asignado_por)
    values (v_cid, v_vid, auth.uid())
    on conflict (conductor_id, vehiculo_id) do nothing;
    if found then v_vin := 1; end if;
  end if;

  return array[v_veh, v_cond, v_vin];
end $$;

revoke execute on function public._flota_registrar(text,text,text,text,text,text,text,text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Importar CONSOLIDADO → foto + flota + propietario vinculado
-- ------------------------------------------------------------
create or replace function public.importar_consolidado(p_archivo text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_rol rol_usuario := public.get_my_role(); v_n int := 0;
  v_res int[]; v_veh int := 0; v_cond int := 0; v_vin int := 0;
begin
  if v_rol not in ('admin','jefe') then raise exception 'Solo admin o jefe pueden importar el consolidado.'; end if;
  truncate table public.consolidado;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.consolidado (placa, num_interno, nombre_propietario, documento, telefono,
      celular, email, ciudad, tar_operacion, vence_operacion, marca, clase, combustible, carroceria,
      pasajeros, modelo, cilindraje, chasis, motor, soat_num, soat_entidad, soat_fecha,
      seguros_entidad, seguros_fecha, tecmecanica_fecha, preventiva_fecha, tipo_convenio,
      empresa_convenio, estado, estado_vehiculo, empresa)
    values (public.norm_placa(r->>'placa'), r->>'num_interno', r->>'nombre_propietario',
      r->>'documento', r->>'telefono', r->>'celular', r->>'email', r->>'ciudad', r->>'tar_operacion',
      (nullif(r->>'vence_operacion',''))::date, r->>'marca', r->>'clase', r->>'combustible',
      r->>'carroceria', r->>'pasajeros', r->>'modelo', r->>'cilindraje', r->>'chasis', r->>'motor',
      r->>'soat_num', r->>'soat_entidad', (nullif(r->>'soat_fecha',''))::date,
      r->>'seguros_entidad', (nullif(r->>'seguros_fecha',''))::date,
      (nullif(r->>'tecmecanica_fecha',''))::date, (nullif(r->>'preventiva_fecha',''))::date,
      r->>'tipo_convenio', r->>'empresa_convenio', r->>'estado', r->>'estado_vehiculo', r->>'empresa');
    v_n := v_n + 1;

    v_res := public._flota_registrar(r->>'placa', r->>'num_interno', r->>'clase', r->>'empresa',
               r->>'documento', r->>'nombre_propietario',
               coalesce(nullif(trim(r->>'celular'),''), r->>'telefono'), r->>'email');
    v_veh := v_veh + v_res[1]; v_cond := v_cond + v_res[2]; v_vin := v_vin + v_res[3];
  end loop;
  return jsonb_build_object('ok',true,'filas',v_n,
    'vehiculos_nuevos',v_veh,'conductores_nuevos',v_cond,'vinculos_nuevos',v_vin);
end $$;

-- ------------------------------------------------------------
-- 4. Importar CARTERA → foto + flota + afiliado vinculado
-- ------------------------------------------------------------
create or replace function public.importar_cartera(p_archivo text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_rol rol_usuario := public.get_my_role(); v_n int := 0;
  v_res int[]; v_veh int := 0; v_cond int := 0; v_vin int := 0;
begin
  if v_rol not in ('admin','jefe') then raise exception 'Solo admin o jefe pueden importar cartera.'; end if;
  truncate table public.cartera;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.cartera (placa, num_interno, identificacion, nombre_afiliado, celular,
      correo, empresa, clase_vehiculo, empresa_convenio, ultimo_periodo_pago,
      periodos_vencidos, valor_vencido, estado)
    values (public.norm_placa(r->>'placa'), r->>'num_interno', r->>'identificacion',
      r->>'nombre_afiliado', r->>'celular', r->>'correo', r->>'empresa', r->>'clase_vehiculo',
      r->>'empresa_convenio', r->>'ultimo_periodo_pago',
      coalesce((nullif(r->>'periodos_vencidos',''))::numeric::int,0),
      coalesce((nullif(r->>'valor_vencido',''))::numeric,0), r->>'estado');
    v_n := v_n + 1;

    v_res := public._flota_registrar(r->>'placa', r->>'num_interno', r->>'clase_vehiculo', r->>'empresa',
               r->>'identificacion', r->>'nombre_afiliado', r->>'celular', r->>'correo');
    v_veh := v_veh + v_res[1]; v_cond := v_cond + v_res[2]; v_vin := v_vin + v_res[3];
  end loop;
  return jsonb_build_object('ok',true,'filas',v_n,
    'vehiculos_nuevos',v_veh,'conductores_nuevos',v_cond,'vinculos_nuevos',v_vin);
end $$;

-- ------------------------------------------------------------
-- 5. Importar CARGUE de documentos (base diaria) — placas normalizadas
-- ------------------------------------------------------------
create or replace function public.importar_cargue(p_archivo text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  v_rol rol_usuario := public.get_my_role();
  v_cond_new int := 0; v_veh_new int := 0; v_vin_new int := 0; v_doc int := 0;
  v_cid uuid; v_vid uuid;
  v_placa text; v_doc_pers text; v_nombre text; v_tipo text; v_empresa text;
begin
  if v_rol not in ('admin','jefe') then
    raise exception 'Solo admin o jefe pueden importar el cargue.';
  end if;

  truncate table public.documentos;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_placa    := public.norm_placa(r->>'placa');
    v_doc_pers := public.norm_doc(r->>'documento_persona');
    v_nombre   := trim(coalesce(r->>'nombre_persona',''));
    v_tipo     := trim(coalesce(r->>'tipo_titular',''));
    v_empresa  := trim(coalesce(r->>'empresa',''));
    v_vid := null; v_cid := null;

    if v_placa <> '' then
      select id into v_vid from public.vehiculos where public.norm_placa(placa) = v_placa limit 1;
      if v_vid is null then
        insert into public.vehiculos (placa, empresa) values (v_placa, v_empresa)
        returning id into v_vid;
        v_veh_new := v_veh_new + 1;
      elsif v_empresa <> '' then
        update public.vehiculos set empresa = v_empresa where id = v_vid and coalesce(empresa,'')='';
      end if;
    end if;

    if v_tipo = 'Conductor' and v_doc_pers <> '' and v_nombre <> '' then
      select id into v_cid from public.conductores where public.norm_doc(documento) = v_doc_pers limit 1;
      if v_cid is null then
        insert into public.conductores (nombre, documento, empresa)
        values (v_nombre, v_doc_pers, v_empresa)
        returning id into v_cid;
        v_cond_new := v_cond_new + 1;
      else
        update public.conductores set nombre = v_nombre
        where id = v_cid and (nombre is null or nombre = '');
      end if;

      if v_vid is not null then
        insert into public.conductor_vehiculo (conductor_id, vehiculo_id, asignado_por)
        values (v_cid, v_vid, auth.uid())
        on conflict (conductor_id, vehiculo_id) do nothing;
        if found then v_vin_new := v_vin_new + 1; end if;
      end if;
    end if;

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

-- ------------------------------------------------------------
-- 6. Importar base de CONDUCTORES (Inf. general) — normalizada
-- ------------------------------------------------------------
create or replace function public.importar_conductores(p_archivo text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_rol rol_usuario := public.get_my_role();
  v_new int := 0; v_upd int := 0; v_vin int := 0; v_veh int := 0;
  v_cid uuid; v_vid uuid; v_doc text; v_placa text; v_i int;
begin
  if v_rol not in ('admin','jefe') then
    raise exception 'Solo admin o jefe pueden importar conductores.';
  end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_doc := public.norm_doc(r->>'documento');
    if v_doc = '' then continue; end if;

    select id into v_cid from public.conductores where public.norm_doc(documento) = v_doc limit 1;
    if v_cid is null then
      insert into public.conductores (nombre, documento, telefono, correo, apellidos,
        licencia_num, licencia_cat, licencia_vence, eps, arl, tipo_sangre, tel_emergencia, cod_interno)
      values (
        trim(coalesce(r->>'nombres','')||' '||coalesce(r->>'apellidos','')), v_doc,
        coalesce(r->>'celular',''), coalesce(r->>'correo',''), coalesce(r->>'apellidos',''),
        coalesce(r->>'licencia_num',''), coalesce(r->>'licencia_cat',''),
        (nullif(r->>'licencia_vence',''))::date,
        coalesce(r->>'eps',''), coalesce(r->>'arl',''), coalesce(r->>'tipo_sangre',''),
        coalesce(r->>'tel_emergencia',''), coalesce(r->>'cod_interno',''))
      returning id into v_cid;
      v_new := v_new + 1;
    else
      update public.conductores set
        nombre = coalesce(nullif(trim(coalesce(r->>'nombres','')||' '||coalesce(r->>'apellidos','')),''), nombre),
        telefono = coalesce(nullif(r->>'celular',''), telefono),
        correo = coalesce(nullif(r->>'correo',''), correo),
        apellidos = coalesce(nullif(r->>'apellidos',''), apellidos),
        licencia_num = coalesce(nullif(r->>'licencia_num',''), licencia_num),
        licencia_cat = coalesce(nullif(r->>'licencia_cat',''), licencia_cat),
        licencia_vence = coalesce((nullif(r->>'licencia_vence',''))::date, licencia_vence),
        eps = coalesce(nullif(r->>'eps',''), eps),
        arl = coalesce(nullif(r->>'arl',''), arl),
        tipo_sangre = coalesce(nullif(r->>'tipo_sangre',''), tipo_sangre),
        tel_emergencia = coalesce(nullif(r->>'tel_emergencia',''), tel_emergencia),
        cod_interno = coalesce(nullif(r->>'cod_interno',''), cod_interno)
      where id = v_cid;
      v_upd := v_upd + 1;
    end if;

    for v_i in 1..5 loop
      v_placa := public.norm_placa(r->>('placa'||v_i));
      if length(v_placa) >= 4 then
        select id into v_vid from public.vehiculos where public.norm_placa(placa) = v_placa limit 1;
        if v_vid is null then
          insert into public.vehiculos (placa) values (v_placa) returning id into v_vid;
          v_veh := v_veh + 1;
        end if;
        insert into public.conductor_vehiculo (conductor_id, vehiculo_id, asignado_por)
        values (v_cid, v_vid, auth.uid())
        on conflict (conductor_id, vehiculo_id) do nothing;
        if found then v_vin := v_vin + 1; end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok',true,'nuevos',v_new,'actualizados',v_upd,
    'vinculos_nuevos',v_vin,'vehiculos_nuevos',v_veh);
end $$;

-- ------------------------------------------------------------
-- 7. SINCRONIZAR FLOTA con lo que ya está cargado
--    (consolidado + cartera + documentos de conductores)
-- ------------------------------------------------------------
create or replace function public._sincronizar_flota()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; v_res int[]; v_veh int := 0; v_cond int := 0; v_vin int := 0;
begin
  -- Consolidado: ficha del vehículo + propietario
  for r in select * from public.consolidado where coalesce(placa,'') <> '' loop
    v_res := public._flota_registrar(r.placa, r.num_interno, r.clase, r.empresa,
               r.documento, r.nombre_propietario, coalesce(nullif(trim(r.celular),''), r.telefono), r.email);
    v_veh := v_veh + v_res[1]; v_cond := v_cond + v_res[2]; v_vin := v_vin + v_res[3];
  end loop;

  -- Cartera: placa + afiliado
  for r in select * from public.cartera where coalesce(placa,'') <> '' loop
    v_res := public._flota_registrar(r.placa, r.num_interno, r.clase_vehiculo, r.empresa,
               r.identificacion, r.nombre_afiliado, r.celular, r.correo);
    v_veh := v_veh + v_res[1]; v_cond := v_cond + v_res[2]; v_vin := v_vin + v_res[3];
  end loop;

  -- Base de documentos: placas sin titular + conductores (tipo 'Conductor')
  for r in select distinct placa, empresa from public.documentos where coalesce(placa,'') <> '' loop
    v_res := public._flota_registrar(r.placa, null, null, r.empresa, null, null, null, null);
    v_veh := v_veh + v_res[1];
  end loop;
  for r in select distinct on (public.norm_placa(placa), public.norm_doc(documento_persona))
             placa, documento_persona, nombre_persona, empresa
           from public.documentos
           where tipo_titular = 'Conductor' and coalesce(placa,'') <> ''
             and coalesce(documento_persona,'') <> '' and coalesce(nombre_persona,'') <> '' loop
    v_res := public._flota_registrar(r.placa, null, null, r.empresa,
               r.documento_persona, r.nombre_persona, null, null);
    v_veh := v_veh + v_res[1]; v_cond := v_cond + v_res[2]; v_vin := v_vin + v_res[3];
  end loop;

  return jsonb_build_object('ok',true,'vehiculos_nuevos',v_veh,
    'conductores_nuevos',v_cond,'vinculos_nuevos',v_vin,
    'total_vehiculos',(select count(*) from public.vehiculos),
    'total_vinculos',(select count(*) from public.conductor_vehiculo));
end $$;
revoke execute on function public._sincronizar_flota() from public, anon, authenticated;

-- Versión que se llama desde la app (botón "Crear vehículos en flota")
create or replace function public.sincronizar_flota()
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if public.get_my_role() not in ('admin','jefe') then
    raise exception 'Solo admin o jefe pueden sincronizar la flota.';
  end if;
  return public._sincronizar_flota();
end $$;
revoke execute on function public.sincronizar_flota() from public, anon;
grant execute on function public.sincronizar_flota() to authenticated;

-- ------------------------------------------------------------
-- 8. Ingreso del conductor tolerante al formato (ABC-123, 1.023.456)
-- ------------------------------------------------------------
create or replace function public.verificar_conductor(p_placa text, p_documento text)
returns table (conductor_id uuid, nombre text, ya_registrado boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  return query
  select c.id, c.nombre, (c.profile_id is not null)
  from public.conductores c
  join public.conductor_vehiculo cv on cv.conductor_id = c.id
  join public.vehiculos v on v.id = cv.vehiculo_id
  where public.norm_doc(c.documento) = public.norm_doc(p_documento)
    and public.norm_placa(v.placa)   = public.norm_placa(p_placa)
    and c.activo and v.activo
  limit 1;
end $$;
grant execute on function public.verificar_conductor(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 9. Ejecutar la sincronización con los datos que ya están cargados
-- ------------------------------------------------------------
select public._sincronizar_flota() as resultado;
