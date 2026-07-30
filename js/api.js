// ── FleetSync v2.1 · api.js ───────────────────────────────────
// Toda la comunicación con Supabase vive aquí.

const sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);

const LOCALIDADES = [
  'Usaquén','Chapinero','Santa Fe','San Cristóbal','Usme',
  'Tunjuelito','Bosa','Kennedy','Fontibón','Engativá',
  'Suba','Barrios Unidos','Teusaquillo','Los Mártires',
  'Antonio Nariño','Puente Aranda','La Candelaria',
  'Rafael Uribe Uribe','Ciudad Bolívar','Soacha'
];

// Centroides aproximados para el mapa de calor cuando no hay GPS
const LOC_COORDS = {
  'Usaquén':[4.6946,-74.0308],'Chapinero':[4.6486,-74.0628],'Santa Fe':[4.6080,-74.0760],
  'San Cristóbal':[4.5570,-74.0870],'Usme':[4.4790,-74.1260],'Tunjuelito':[4.5720,-74.1320],
  'Bosa':[4.6180,-74.1930],'Kennedy':[4.6280,-74.1560],'Fontibón':[4.6790,-74.1430],
  'Engativá':[4.7070,-74.1140],'Suba':[4.7410,-74.0830],'Barrios Unidos':[4.6670,-74.0840],
  'Teusaquillo':[4.6440,-74.0930],'Los Mártires':[4.6040,-74.0900],'Antonio Nariño':[4.5880,-74.0990],
  'Puente Aranda':[4.6160,-74.1140],'La Candelaria':[4.5970,-74.0730],
  'Rafael Uribe Uribe':[4.5560,-74.1060],'Ciudad Bolívar':[4.5330,-74.1600],'Soacha':[4.5790,-74.2170]
};

const ROLE_LABELS = {
  conductor:   'Conductor',
  analista:    'Analista',
  coordinador: 'Coordinador de operaciones',
  jefe:        'Jefe de operación',
  admin:       'Administrador'
};

const Api = {

  // Convierte errores de Postgres en mensajes claros para el usuario
  friendly(error){
    const m = error?.message || '';
    if (m.includes('excl_vehiculo_horario'))
      return '⛔ Ese vehículo ya tiene una disponibilidad que se cruza con ese horario (otro conductor u otro turno).';
    if (m.includes('excl_conductor_horario'))
      return '⛔ Ese conductor ya tiene una disponibilidad que se cruza con ese horario (en este u otro vehículo).';
    if (m.includes('no está vinculado'))
      return '⛔ El conductor no está vinculado a ese vehículo. El coordinador o el jefe deben crear el vínculo primero.';
    if (m.includes('duplicate key') && m.includes('conductor_vehiculo'))
      return 'Ese conductor ya está vinculado a este vehículo.';
    if (m.includes('duplicate key') && m.includes('documento'))
      return 'Ya existe un conductor con ese documento.';
    if (m.includes('duplicate key') && m.includes('placa'))
      return 'Ya existe un vehículo con esa placa.';
    return 'Error: ' + m;
  },

  // ── Autenticación ────────────────────────────────────────
  // La cuenta del conductor se identifica por su documento (una persona,
  // una cuenta, aunque opere varios vehículos).
  driverEmail(doc) {
    return 'c' + doc.trim().replace(/[^0-9a-z]/gi,'') + '@' + APP_CONFIG.DRIVER_EMAIL_DOMAIN;
  },

  // Conductor: placa (de un vehículo vinculado) + documento.
  async loginConductor(plate, doc) {
    const email = this.driverEmail(doc);
    const pass  = 'SC·' + doc.trim();

    let { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (!error) return { ok: true };

    // Primer ingreso: verificar el par placa+documento y registrarse
    const { data: match, error: e1 } = await sb.rpc('verificar_conductor', {
      p_placa: plate.trim(), p_documento: doc.trim()
    });
    if (e1) return { ok: false, error: e1.message };
    if (!match || !match.length) return { ok: false, error: 'Placa o documento no encontrado, o no estás vinculado a ese vehículo. Verifica con tu coordinador.' };
    if (match[0].ya_registrado) return { ok: false, error: 'Credenciales incorrectas.' };

    const { error: e2 } = await sb.auth.signUp({
      email, password: pass,
      options: { data: { role: 'conductor', conductor_id: match[0].conductor_id, full_name: match[0].nombre } }
    });
    if (e2) return { ok: false, error: e2.message };

    const { error: e3 } = await sb.auth.signInWithPassword({ email, password: pass });
    return e3 ? { ok: false, error: e3.message } : { ok: true };
  },

  async loginStaff(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    return error ? { ok: false, error: 'Email o contraseña incorrectos.' } : { ok: true };
  },

  async logout() { await sb.auth.signOut(); },

  async getSession() {
    const { data } = await sb.auth.getSession();
    return data.session;
  },

  async getMe() {
    const session = await this.getSession();
    if (!session) return null;
    const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
    if (!profile) return null;
    let conductor = null;
    if (profile.role === 'conductor') {
      const { data } = await sb.from('conductores').select('*').eq('profile_id', session.user.id).maybeSingle();
      conductor = data;
    }
    return { session, profile, conductor };
  },

  // ── Conductores (personas) ───────────────────────────────
  async listConductores() {
    const { data, error } = await sb.from('conductores').select('*').order('nombre');
    return error ? [] : data;
  },

  async saveConductor(c) {
    if (c.id) { const { id, ...rest } = c; return sb.from('conductores').update(rest).eq('id', id); }
    return sb.from('conductores').insert(c);
  },

  // Inserta y devuelve el conductor creado (para vincularlo enseguida)
  async saveConductorReturn(c) {
    const { data, error } = await sb.from('conductores').insert(c).select().single();
    return { data, error };
  },

  async updatePerfilConductor(id, campos) {
    return sb.from('conductores').update(campos).eq('id', id);
  },

  // ── Vehículos ────────────────────────────────────────────
  async listVehiculos() {
    const { data, error } = await sb.from('vehiculos').select('*').order('placa');
    return error ? [] : data;
  },

  async saveVehiculo(v) {
    if (v.id) { const { id, ...rest } = v; return sb.from('vehiculos').update(rest).eq('id', id); }
    return sb.from('vehiculos').insert(v);
  },

  // ── Vínculos conductor ⟷ vehículo ────────────────────────
  async listVinculos() {
    const { data, error } = await sb.from('v_vinculos').select('*');
    return error ? [] : data;
  },

  async vincular(conductorId, vehiculoId) {
    const me = await this.getSession();
    return sb.from('conductor_vehiculo').insert({
      conductor_id: conductorId, vehiculo_id: vehiculoId, asignado_por: me?.user?.id
    });
  },

  async desvincular(vinculoId) {
    return sb.from('conductor_vehiculo').delete().eq('id', vinculoId);
  },

  // Vehículos que puede operar un conductor
  async misVehiculos(conductorId) {
    const { data, error } = await sb.from('v_vinculos').select('*')
      .eq('conductor_id', conductorId).order('placa');
    return error ? [] : data;
  },

  // ── Disponibilidades ─────────────────────────────────────
  async misDisponibilidades(conductorId) {
    const { data, error } = await sb.from('v_disponibilidades')
      .select('*').eq('conductor_id', conductorId)
      .order('inicio', { ascending: false }).limit(200);
    return error ? [] : data;
  },

  async disponibilidadesRango(desdeISO, hastaISO) {
    const { data, error } = await sb.from('v_disponibilidades')
      .select('*')
      .gte('inicio', desdeISO).lt('inicio', hastaISO)
      .order('inicio');
    return error ? [] : data;
  },

  async crearDisponibilidades(rows) {
    const me = await this.getSession();
    return sb.from('disponibilidades').insert(
      rows.map(r => ({ ...r, creada_por: me?.user?.id }))
    );
  },

  async cancelarDisponibilidad(id, motivo) {
    return sb.from('disponibilidades')
      .update({ estado: 'cancelada', motivo_cancelacion: motivo || '' })
      .eq('id', id);
  },

  async cambiarEstadoDisponibilidad(id, estado) {
    const me = await this.getSession();
    const patch = { estado };
    if (estado === 'validada') {
      patch.validada_por = me?.user?.id;
      patch.validada_at  = new Date().toISOString();
    }
    return sb.from('disponibilidades').update(patch).eq('id', id);
  },

  // ── Asignaciones (coordinador) ───────────────────────────
  async asignar(disponibilidadId, servicio, zona, notas) {
    const me = await this.getSession();
    return sb.from('asignaciones').insert({
      disponibilidad_id: disponibilidadId,
      servicio, zona: zona || '', notas: notas || '',
      asignada_por: me?.user?.id
    });
  },

  async cancelarAsignacion(asignacionId) {
    return sb.from('asignaciones').update({ estado: 'cancelada' }).eq('id', asignacionId);
  },

  // ── Ubicaciones ──────────────────────────────────────────
  async reportarUbicacion(conductorId, vehiculoId, lat, lng, precision) {
    return sb.from('ubicaciones').insert({
      conductor_id: conductorId, vehiculo_id: vehiculoId,
      lat, lng, precision_m: precision || null
    });
  },

  async ultimasUbicaciones() {
    const { data, error } = await sb.from('v_ultima_ubicacion').select('*');
    return error ? [] : data;
  },

  async miUltimaUbicacion(conductorId) {
    const { data } = await sb.from('ubicaciones').select('*')
      .eq('conductor_id', conductorId)
      .order('reportada_at', { ascending: false }).limit(1).maybeSingle();
    return data;
  },

  // ── Equipo (solo jefe/admin) · vía Edge Function segura ──
  async gestionarEmpleados(action, extra = {}) {
    const session = await this.getSession();
    if (!session) return { error: 'Sesión expirada.' };
    try {
      const res = await fetch(`${APP_CONFIG.SUPABASE_URL}/functions/v1/gestionar-empleados`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': APP_CONFIG.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ action, ...extra })
      });
      const data = await res.json();
      if (!res.ok) return { error: data.error || 'Error del servidor.' };
      return data;
    } catch (e) {
      return { error: 'No se pudo contactar la función. ¿Está desplegada? ' + e.message };
    }
  },

  // ── Cargue diario de conductores/documentos (admin/jefe) ──
  async importarCargue(archivo, rows) {
    const { data, error } = await sb.rpc('importar_cargue', { p_archivo: archivo, p_rows: rows });
    if (error) return { error: error.message };
    return data;
  },

  async importarConductores(archivo, rows) {
    const { data, error } = await sb.rpc('importar_conductores', { p_archivo: archivo, p_rows: rows });
    if (error) return { error: error.message };
    return data;
  },

  async importarCartera(archivo, rows) {
    const { data, error } = await sb.rpc('importar_cartera', { p_archivo: archivo, p_rows: rows });
    if (error) return { error: error.message };
    return data;
  },

  async importarConsolidado(archivo, rows) {
    const { data, error } = await sb.rpc('importar_consolidado', { p_archivo: archivo, p_rows: rows });
    if (error) return { error: error.message };
    return data;
  },

  async listarCartera(soloMora) {
    let q = sb.from('cartera').select('*').order('periodos_vencidos', { ascending: false });
    if (soloMora) q = q.gt('periodos_vencidos', 0);
    const { data, error } = await q.limit(2000);
    return error ? [] : data;
  },

  async listarConsolidado() {
    const PAGE=1000; let from=0, all=[];
    while(true){
      const { data, error } = await sb.from('consolidado').select('*').order('placa').range(from, from+PAGE-1);
      if (error || !data || !data.length) break;
      all = all.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  },

  async ultimoCargue() {
    const { data } = await sb.from('cargues').select('*')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data;
  },

  async listarCargues() {
    const { data, error } = await sb.from('cargues').select('*')
      .order('created_at', { ascending: false }).limit(30);
    return error ? [] : data;
  },

  // Todos los documentos (para exportar el Excel)
  async todosLosDocumentos() {
    const PAGE = 1000; let from = 0, all = [];
    while (true) {
      const { data, error } = await sb.from('documentos').select('*')
        .order('placa').range(from, from + PAGE - 1);
      if (error || !data || !data.length) break;
      all = all.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  },

  async docsPorVehiculo() {
    const { data, error } = await sb.from('v_docs_vehiculo').select('*');
    return error ? [] : data;
  },

  // ── Configuración (recordatorio de cargue, etc.) ─────────
  async getConfig() {
    const { data, error } = await sb.from('config').select('*');
    if (error) return {};
    const o = {}; (data||[]).forEach(r=>o[r.clave]=r.valor); return o;
  },

  async setConfig(clave, valor) {
    const me = await this.getSession();
    return sb.from('config').upsert({ clave, valor, updated_by: me?.user?.id, updated_at: new Date().toISOString() });
  }
};
