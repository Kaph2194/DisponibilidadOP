/**
 * =====================================================================
 *  FLEETSYNC — CARGUE AUTOMÁTICO DESDE EL PORTAL SGT  (Google Apps Script)
 * ---------------------------------------------------------------------
 *  Proyecto PROPIO de FleetSync (independiente del módulo de Cartera).
 *  Se crea con la cuenta directortransporte@specialcar.com.co.
 *
 *  Tres veces al día entra al portal SGT, descarga los reportes y hace en
 *  FleetSync (Supabase) los mismos 4 cargues que hace el administrador:
 *
 *    Reporte del portal                                  -> Cargue en FleetSync
 *    Documentos Afiliados (Activos, Detallado, Todos)    -> Base de datos (importar_cargue)
 *    Conductores Gral (Activos)                          -> Conductores (importar_conductores)
 *    Parque Automotor, 6 empresas (solo activos)         -> Consolidado (importar_consolidado)
 *    Cartera de Rodamientos (Activos)                    -> Cartera (importar_cartera)
 *
 *  Credenciales (NUNCA en el código; el repositorio es público):
 *    Configuración del proyecto > Propiedades del script
 *      PORTAL_USUARIO / PORTAL_CLAVE  -> ingreso al portal SGT
 *      FLEET_USUARIO  / FLEET_CLAVE   -> usuario de FleetSync con rol admin o jefe
 *
 *  Instalación: ver apps-script/CARGUE_AUTOMATICO.md
 * =====================================================================
 */

const CONFIG = {
  ZONA: 'America/Bogota',
  HORAS: [6, 12, 17],                       // horas del día en que se hace el cargue
  CORREO_AVISOS: 'directortransporte@specialcar.com.co', // recibe un aviso si un cargue falla (máx. 1 por día)
  DIAS_GUARDAR_ARCHIVOS: 30,                // los Excel descargados se guardan en Drive este número de días

  // FleetSync (los mismos valores públicos de config.js)
  FLEET_SUPABASE_URL: 'https://yaeknutbljjeetukhefq.supabase.co',
  FLEET_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhZWtudXRibGpqZWV0dWtoZWZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNjU3NzUsImV4cCI6MjEwMDk0MTc3NX0.ghq4dafj5X1iEt-4_LAWSRaIuxABBorKmo49VXoRsg8',

  // Portal SGT
  PORTAL_BASE: 'https://portal2sgt.azurewebsites.net',
  PORTAL_REPORTE: '/Reportes/CarteraRodamiento',
  PORTAL_PARQUE: '/Reportes/ParqueAutomotor',
  PORTAL_CONDUCTORES: '/Reportes/ConductoresInfoGral',
  PORTAL_DOCUMENTOS: '/Reportes/RepDocuAfiliados',
  // Filtros que se eligen en cada reporte (por texto de la opción), igual que a mano
  PORTAL_FILTROS: {
    '/Reportes/CarteraRodamiento': { estado: 'Activos' },
    '/Reportes/RepDocuAfiliados': { estado: 'Activos' }
  },
  // Campos ocultos que la pagina llena con la opcion marcada (radio) al pulsar el boton
  PORTAL_OCULTOS_RADIO: {
    '/Reportes/RepDocuAfiliados': ['tipoInforme']   // "Tipo de Informe": Detallado (marcado por defecto)
  },
  // Nombre esperado del archivo de cada reporte (se descarta cualquier otro)
  ARCHIVOS_REPORTE: {
    '/Reportes/CarteraRodamiento': /cartera|rodamiento/i,
    '/Reportes/ParqueAutomotor': /parque/i,
    '/Reportes/ConductoresInfoGral': /conductor/i,
    '/Reportes/RepDocuAfiliados': /docu|afiliad/i
  }
};

// Orden de las tareas. Cada ejecucion hace UNA y programa la siguiente un minuto despues,
// asi cada descarga tiene sus 6 minutos completos (limite de Google por ejecucion).
const TAREAS = ['documentos', 'conductores', 'consolidado', 'cartera'];

// ===================== CARGUE =====================
/** Lo ejecuta el disparador horario: hace el cargue en las horas de CONFIG.HORAS (una vez por hora). */
function cargueAutomatico() {
  const hora = Number(Utilities.formatDate(new Date(), CONFIG.ZONA, 'H'));
  if (CONFIG.HORAS.indexOf(hora) < 0) return;
  ejecutarCargue_(hoyISO_() + '-' + hora);
}
/** Continuación automática cuando una tanda no alcanzó en 6 minutos. */
function continuarCargue() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'continuarCargue').forEach(t => ScriptApp.deleteTrigger(t));
  const tanda = PropertiesService.getScriptProperties().getProperty('TANDA');
  if (tanda) ejecutarCargue_(tanda, /^manual/.test(tanda));
}
/** Prueba manual desde el editor: hace los 4 cargues ya (uno por minuto; el resultado queda en el registro). */
function probarCargue() { ejecutarCargue_('manual-' + new Date().getTime(), true); }

function ejecutarCargue_(tanda, manual) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  const props = PropertiesService.getScriptProperties();
  try {
    faltanCredenciales_();
    if (props.getProperty('TANDA') !== tanda) props.setProperties({ TANDA: tanda, TANDA_HECHAS: '', TANDA_ERRORES: '' });
    const hechas = (props.getProperty('TANDA_HECHAS') || '').split(',').filter(String);
    const pendientes = TAREAS.filter(t => hechas.indexOf(t) < 0);
    if (!pendientes.length) return;
    const t = pendientes[0];
    try { const r = TAREA[t](loginFleet_()); console.log(t + ': ' + JSON.stringify(r)); }
    catch (e) { registrar_(t, 0, '', e.message); console.error(t, e); props.setProperty('TANDA_ERRORES', (props.getProperty('TANDA_ERRORES') || '') + t + ': ' + e.message + '\n'); }
    hechas.push(t); props.setProperty('TANDA_HECHAS', hechas.join(','));
    if (pendientes.length > 1) { ScriptApp.newTrigger('continuarCargue').timeBased().after(60 * 1000).create(); console.log('Sigue en 1 minuto con: ' + pendientes.slice(1).join(', ')); return; }
    // tanda completa
    const errores = (props.getProperty('TANDA_ERRORES') || '').split('\n').filter(String);
    props.setProperty('ULTIMO_CARGUE', new Date().toISOString());
    if (errores.length) avisarError_(errores, manual);
    limpiarArchivosViejos_();
  } catch (e) {
    console.error(e); registrar_('general', 0, '', e.message); avisarError_([e.message], manual);
  } finally { lock.releaseLock(); }
}

const TAREA = {
  documentos: token => {
    const d = descargar_(CONFIG.PORTAL_DOCUMENTOS, 'DocumentosAfiliados', false)[0];
    const filas = filasDocumentosFleet_(d.filas);
    if (!filas.length) throw new Error('el reporte de documentos llegó sin filas ' + resumenArchivo_(d));
    return enviar_(token, 'importar_cargue', 'Documentos afiliados', d.nombre, filas);
  },
  conductores: token => {
    const d = descargar_(CONFIG.PORTAL_CONDUCTORES, 'ConductoresInfoGral', false)[0];
    const filas = filasConductoresFleet_(d.filas);
    if (!filas.length) throw new Error('el reporte de conductores llegó sin filas ' + resumenArchivo_(d));
    return enviar_(token, 'importar_conductores', 'Conductores', d.nombre, filas);
  },
  consolidado: token => {
    // un archivo por empresa; se unen y se dejan solo los vehiculos activos
    const archivos = descargar_(CONFIG.PORTAL_PARQUE, 'ParqueAutomotor', true);
    const vistas = {}; let inactivos = 0;
    archivos.forEach(d => parsearParque_(d.filas).filas.forEach(f => { if (esActivoParque_(f)) vistas[f[0]] = f; else inactivos++; }));
    const filas = Object.keys(vistas).map(k => filaConsolidadoFleet_(vistas[k]));
    if (!filas.length) throw new Error('el parque automotor llegó sin vehículos activos');
    const r = enviar_(token, 'importar_consolidado', 'Consolidado', 'Consolidado_' + archivos.length + '_empresas_' + hoyISO_() + '.xlsx', filas);
    r.inactivosDescartados = inactivos; return r;
  },
  cartera: token => {
    const d = descargar_(CONFIG.PORTAL_REPORTE, 'CarteraRodamientos', false)[0];
    const filas = filasCarteraFleet_(d.filas);
    if (!filas.length) throw new Error('el reporte de cartera llegó sin filas ' + resumenArchivo_(d));
    return enviar_(token, 'importar_cartera', 'Cartera', d.nombre, filas);
  }
};

// Para el registro: cuantas filas trae el archivo y sus primeras lineas (sin datos personales)
function resumenArchivo_(d) {
  const f = d.filas || [];
  return '(' + d.nombre + ': ' + f.length + ' filas; primeras: ' + f.slice(0, 4).map(r => r.filter(c => String(c).trim()).slice(0, 8).join(' | ').slice(0, 160)).join(' // ') + ')';
}
function enviar_(token, funcion, tipo, nombreArchivo, filas) {
  const r = rpcFleet_(token, funcion, 'Automatico ' + nombreArchivo, filas);
  registrar_(tipo, filas.length, r, '');
  return r;
}

// ===================== FILAS PARA FLEETSYNC (mismos campos que la app) =====================
function filaConsolidadoFleet_(f) {
  const i = c => ENC_PARQUE.indexOf(c), t = c => txtF_(f[i(c)]), d = c => fechaF_(f[i(c)]);
  return { placa: t('Placa'), num_interno: t('No Interno'), nombre_propietario: t('Nombre Propietario'), documento: t('Documento'), telefono: t('Teléfono'), celular: t('Celular'),
    email: t('Email'), ciudad: t('Ciudad Vehiculo'), tar_operacion: t('Tar. Operacion #'), vence_operacion: d('Vence T. Operacion'), marca: t('Marca Vehículo'), clase: t('Clase Vehículo'),
    combustible: t('Tipo Combustible'), carroceria: t('Tipo Carrocería'), pasajeros: t('Pasajeros'), modelo: t('Modelo'), cilindraje: t('Cilindraje'), chasis: t('Chasis'), motor: t('Motor'),
    soat_num: t('No. SOAT'), soat_entidad: t('Entidad Soat'), soat_fecha: d('Fecha SOAT'), seguros_entidad: t('Entidad Seguros'), seguros_fecha: d('Fecha Seguros'),
    tecmecanica_fecha: d('Fecha TecMecanica'), preventiva_fecha: d('Fecha Preventiva'), tipo_convenio: t('Tipo Convenio'), empresa_convenio: t('Empresa Convenio'),
    estado: t('Estado'), estado_vehiculo: t('Estado Vehículo'), empresa: t('Empresa') };
}
function filasCarteraFleet_(filas) {
  return objetosDesdeFilas_(filas, ['Placa', 'Periodos Vencidos', 'Nombre Afiliado']).map(r => ({
    placa: txtF_(pick_(r, ['Placa', 'placa'])), num_interno: txtF_(pick_(r, ['Num. Interno', 'Num Interno'])), identificacion: txtF_(pick_(r, ['Identificacion', 'Identificación'])),
    nombre_afiliado: txtF_(pick_(r, ['Nombre Afiliado'])), celular: txtF_(pick_(r, ['Celular'])), correo: txtF_(pick_(r, ['Correo'])),
    empresa: txtF_(pick_(r, ['Empresa'])), clase_vehiculo: txtF_(pick_(r, ['Clase Vehiculo', 'Clase Vehículo'])), empresa_convenio: txtF_(pick_(r, ['Empresa Convenio'])),
    ultimo_periodo_pago: txtF_(pick_(r, ['Ultimo Periodo Pago', 'Último Periodo Pago'])), periodos_vencidos: txtF_(pick_(r, ['# Periodos Vencidos', 'Periodos Vencidos'])),
    valor_vencido: txtF_(pick_(r, ['$ Periodos Vencidos', 'Valor Vencido'])).replace(/[^0-9.-]/g, ''), estado: txtF_(pick_(r, ['Estado']))
  })).filter(x => x.placa);
}

// ===================== DRIVE, REGISTRO Y AVISOS =====================
function carpeta_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CARPETA_ID');
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  const f = DriveApp.createFolder('FleetSync - Reportes del portal');
  props.setProperty('CARPETA_ID', f.getId());
  return f;
}
// Descarga del portal, guarda en Drive y devuelve [{nombre, filas}]
function descargar_(ruta, base, porEmpresa) {
  const sello = Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyy-MM-dd_HHmm');
  return descargarReportes_(ruta, porEmpresa, [], base).map((b, i) => {
    const f = carpeta_().createFile(b).setName(base + (porEmpresa ? '_' + (i + 1) : '') + '_' + sello + '.xlsx');
    return { nombre: f.getName(), filas: leerFilasArchivo_(f) };
  });
}
// Excel -> filas: copia temporal convertida a Google Sheets (API de Drive), se lee y se borra
function leerFilasArchivo_(f) {
  const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + f.getId() + '/copy?supportsAllDrives=true', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ name: 'tmp_fleet_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS })
  });
  if (r.getResponseCode() !== 200) throw new Error('No se pudo convertir el Excel (' + r.getResponseCode() + ')');
  const tmpId = JSON.parse(r.getContentText()).id;
  try { return SpreadsheetApp.openById(tmpId).getSheets()[0].getDataRange().getValues(); }
  finally { try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) {} }
}
function limpiarArchivosViejos_() {
  try {
    const limite = Date.now() - CONFIG.DIAS_GUARDAR_ARCHIVOS * 86400000, it = carpeta_().getFiles();
    while (it.hasNext()) { const f = it.next(); if (f.getDateCreated().getTime() < limite) f.setTrashed(true); }
  } catch (e) { console.warn('Limpieza', e); }
}
function libro_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('HOJA_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const ss = SpreadsheetApp.create('FleetSync - Registro de cargues automáticos');
  props.setProperty('HOJA_ID', ss.getId());
  const h = ss.getSheets()[0].setName('Registro');
  h.getRange(1, 1, 1, 5).setValues([['Fecha', 'Cargue', 'Filas enviadas', 'Resultado de FleetSync', 'Error']]).setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
  h.setFrozenRows(1);
  try { DriveApp.getFileById(ss.getId()).moveTo(carpeta_()); } catch (e) {}
  return ss;
}
function registrar_(tipo, filas, resultado, error) {
  libro_().getSheetByName('Registro').appendRow([new Date(), tipo, filas, resultado ? JSON.stringify(resultado).slice(0, 500) : '', error || '']);
}
function avisarError_(errores, manual) {
  const props = PropertiesService.getScriptProperties();
  if (!manual && props.getProperty('AVISO_ERROR') === hoyISO_()) return; // maximo un aviso por dia
  props.setProperty('AVISO_ERROR', hoyISO_());
  try {
    MailApp.sendEmail(CONFIG.CORREO_AVISOS, '[FleetSync] Falló el cargue automático (' + errores.length + ')',
      'El cargue automático desde el portal SGT tuvo errores:\n\n- ' + errores.join('\n- ') +
      '\n\nRegistro: ' + libro_().getUrl() + '\nSi el error es del portal, en Apps Script ejecuta el diagnóstico del reporte (diagnosticarCartera, diagnosticarParque, diagnosticarConductores o diagnosticarDocumentos).');
  } catch (e) { console.warn('Aviso', e); }
}
function faltanCredenciales_() {
  const p = PropertiesService.getScriptProperties(), faltan = ['PORTAL_USUARIO', 'PORTAL_CLAVE', 'FLEET_USUARIO', 'FLEET_CLAVE'].filter(k => !p.getProperty(k));
  if (faltan.length) throw new Error('Faltan en Propiedades del script: ' + faltan.join(', '));
}

// ===================== INSTALACIÓN Y DIAGNÓSTICO =====================
/** EJECUTAR UNA VEZ desde el editor (con directortransporte@): pide permisos, programa el cargue y lo prueba. */
function configurarTodo() {
  verificarPermisos();
  ScriptApp.getProjectTriggers().filter(t => ['cargueAutomatico', 'continuarCargue'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cargueAutomatico').timeBased().everyHours(1).create();
  console.log('Cargue automático programado a las ' + CONFIG.HORAS.join(', ') + ' h (' + CONFIG.ZONA + ').');
  console.log('Carpeta de reportes: ' + carpeta_().getUrl());
  console.log('Registro de cargues: ' + libro_().getUrl());
  faltanCredenciales_();
  console.log('Probando el ingreso a FleetSync…'); loginFleet_(); console.log('Ingreso a FleetSync correcto.');
  console.log('Para cargar ya, ejecuta probarCargue (tarda unos minutos).');
}
function diagnosticarCartera() { diagnosticarPortal(CONFIG.PORTAL_REPORTE); }
function diagnosticarParque() { diagnosticarPortal(CONFIG.PORTAL_PARQUE); }
function diagnosticarConductores() { diagnosticarPortal(CONFIG.PORTAL_CONDUCTORES); }
function diagnosticarDocumentos() { diagnosticarPortal(CONFIG.PORTAL_DOCUMENTOS); }

// =====================================================================
//  MOTOR DEL PORTAL SGT Y DE FLEETSYNC (el mismo probado en el proyecto de Cartera)
// =====================================================================
function normalizar_(s) { return String(s || '').replace(/\uFEFF/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
function cookies_(jar, resp) {
  let sc = resp.getAllHeaders()['Set-Cookie'];
  if (!sc) return;
  (Array.isArray(sc) ? sc : [sc]).forEach(c => { const kv = String(c).split(';')[0]; const i = kv.indexOf('='); if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1); });
}
function cookieHeader_(jar) { return Object.keys(jar).map(k => k + '=' + jar[k]).join('; '); }
function absoluta_(url, base) { if (/^https?:/i.test(url)) return url; if (url.charAt(0) === '/') return CONFIG.PORTAL_BASE + url; return base.replace(/[^/]*$/, '') + url; }
function pedir_(jar, url, opciones) {
  for (let n = 0; n < 8; n++) {
    const o = Object.assign({ muteHttpExceptions: true, followRedirects: false }, opciones || {});
    o.headers = Object.assign({ Cookie: cookieHeader_(jar), 'User-Agent': 'Mozilla/5.0 (SpecialCar Cartera)' }, o.headers || {});
    const r = UrlFetchApp.fetch(url, o);
    cookies_(jar, r);
    const code = r.getResponseCode();
    if (code >= 300 && code < 400) { const h = r.getAllHeaders(); url = absoluta_(h.Location || h.location, url); opciones = { method: 'get' }; continue; }
    return { r: r, url: url, code: code };
  }
  throw new Error('Demasiadas redirecciones en el portal');
}
function atributo_(tag, nombre) { const m = tag.match(new RegExp(nombre + '\\s*=\\s*["\']([^"\']*)["\']', 'i')); return m ? m[1].replace(/&amp;/g, '&') : null; }
function formularios_(html) {
  const out = [], re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi; let m;
  while ((m = re.exec(html))) {
    const campos = [], ri = /<(input|select|textarea|button)\b[^>]*>/gi; let t;
    while ((t = ri.exec(m[2]))) campos.push({ tag: t[0], tipo: (atributo_(t[0], 'type') || t[1]).toLowerCase(), nombre: atributo_(t[0], 'name'), valor: atributo_(t[0], 'value') || '' });
    // opciones de cada <select> (p.ej. la lista de empresas del reporte)
    const rs = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi; let sm;
    while ((sm = rs.exec(m[2]))) {
      const nombre = atributo_('<s ' + sm[1] + '>', 'name'), opciones = [], ro = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi; let om;
      while ((om = ro.exec(sm[2]))) opciones.push({ valor: atributo_('<o ' + om[1] + '>', 'value') !== null ? atributo_('<o ' + om[1] + '>', 'value') : om[2].replace(/<[^>]+>/g, '').trim(), texto: om[2].replace(/<[^>]+>/g, '').trim(), sel: /\bselected\b/i.test(om[1]) });
      const c = campos.filter(x => x.tipo === 'select' && x.nombre === nombre)[0];
      if (c) { c.opciones = opciones; c.valor = (opciones.filter(o => o.sel)[0] || opciones[0] || { valor: '' }).valor; }
    }
    out.push({ action: atributo_('<f ' + m[1] + '>', 'action') || '', metodo: (atributo_('<f ' + m[1] + '>', 'method') || 'get').toLowerCase(), campos: campos, html: m[0] });
  }
  return out;
}
function esFormLogin_(f, urlPagina) {
  if (!f.campos.some(c => c.tipo === 'password')) return false;
  if (f.action) return /login|signin|ingres|iniciar/i.test(f.action);
  return /login|signin/i.test(urlPagina || '');
}
function iniciarSesionPortal_(jar, ruta) {
  ruta = ruta || CONFIG.PORTAL_REPORTE;
  const props = PropertiesService.getScriptProperties();
  const usuario = String(props.getProperty('PORTAL_USUARIO') || '').trim(), clave = String(props.getProperty('PORTAL_CLAVE') || '').replace(/^\s+|\s+$/g, '');
  if (!usuario || !clave) throw new Error('Faltan PORTAL_USUARIO / PORTAL_CLAVE en Propiedades del script');
  let p = pedir_(jar, CONFIG.PORTAL_BASE + ruta);
  const form = formularios_(p.r.getContentText()).filter(f => esFormLogin_(f, p.url))[0];
  if (!form) return p; // ya hay sesion
  const datos = {};
  form.campos.forEach(c => { if (c.nombre && c.tipo !== 'submit' && c.tipo !== 'button' && c.tipo !== 'checkbox') datos[c.nombre] = c.valor; });
  const campoClave = form.campos.filter(c => c.tipo === 'password')[0];
  const campoUsuario = form.campos.filter(c => c.nombre && (c.tipo === 'email' || /email|correo|user|usuario|login/i.test(c.nombre)) && c.tipo !== 'hidden' && c.tipo !== 'password')[0]
    || form.campos.filter(c => c.nombre && c.tipo === 'text')[0];
  if (!campoUsuario || !campoClave) throw new Error('No se reconocieron los campos de usuario/clave del portal');
  datos[campoUsuario.nombre] = usuario; datos[campoClave.nombre] = clave;
  const recordar = form.campos.filter(c => c.tipo === 'checkbox' && /remember|recordar/i.test(c.nombre || ''))[0];
  if (recordar) datos[recordar.nombre] = 'true';
  p = pedir_(jar, absoluta_(form.action || p.url, p.url), { method: 'post', payload: datos });
  if (formularios_(p.r.getContentText()).some(f => esFormLogin_(f, p.url))) {
    const msg = mensajesPortal_(p.r.getContentText());
    throw new Error('El portal rechazó el inicio de sesión' + (msg ? ': "' + msg + '"' : '') + ' (revisa PORTAL_USUARIO / PORTAL_CLAVE o ejecuta diagnosticarCartera)');
  }
  return pedir_(jar, CONFIG.PORTAL_BASE + ruta);
}
function entidades_(t) {
  const mapa = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', iexcl: '¡', iquest: '¿' };
  return String(t).replace(/&#(\d+);/g, (x, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (x, n) => String.fromCharCode(parseInt(n, 16))).replace(/&([a-zA-Z]+);/g, (x, n) => mapa[n] !== undefined ? mapa[n] : ' ');
}
function mensajesPortal_(html) {
  const out = [], re = /<(div|span|li|p|label)\b[^>]*class\s*=\s*["'][^"']*(validation-summary|field-validation-error|text-danger|alert|error|invalid-feedback)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi; let m;
  while ((m = re.exec(html))) { const t = entidades_(m[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); if (t && out.indexOf(t) < 0) out.push(t); }
  return out.join(' | ').slice(0, 300);
}
function esExcel_(r) {
  const h = r.getAllHeaders(), ct = String(h['Content-Type'] || h['content-type'] || ''), cd = String(h['Content-Disposition'] || h['content-disposition'] || '');
  return /spreadsheet|excel|octet-stream|csv/i.test(ct) || /\.(xlsx|xls|csv)/i.test(cd);
}
function nombreDescarga_(r, base) {
  const h = r.getAllHeaders(), cd = String(h['Content-Disposition'] || h['content-disposition'] || '');
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
  return m ? decodeURIComponent(m[1]) : (base || 'CarteraRodamientos') + '_' + hoyISO_() + '.xlsx';
}
const PALABRAS_DESCARGA_ = /excel|xls|export|descarg/i;
const FORM_PROHIBIDO_ = /logout|logoff|salir|cerrar|perfil|password|contrase|eliminar|borrar|delete/i;
function hoyCO_() { return Utilities.formatDate(new Date(), CONFIG.ZONA, 'dd/MM/yyyy'); }
function tokenReporte_(ruta) { return normalizar_(String(ruta).split('/').filter(String)[1] || ruta).replace(/[^a-z]/g, ''); }
function rutaDelReporte_(url, ruta) { return normalizar_(url).replace(/[^a-z\/]/g, '').indexOf(tokenReporte_(ruta)) >= 0; }
function intentosDescarga_(html, pagina, ruta, extra, sinRespaldo) {
  const intentos = []; let m;
  // 1) El formulario del reporte (filtros + "Ver Informe"/"Generar Informe"): SOLO formularios cuya accion es del reporte
  formularios_(html).forEach(f => {
    if (f.campos.some(c => c.tipo === 'password') || FORM_PROHIBIDO_.test(f.action)) return;
    const accion = absoluta_(f.action || pagina.url, pagina.url);
    if (!rutaDelReporte_(accion, ruta)) return;
    const datos = {};
    f.campos.forEach(c => {
      if (!c.nombre || /submit|button|checkbox|file|image/.test(c.tipo)) return;
      if (c.tipo === 'radio') { if (!(c.nombre in datos) || /\bchecked\b/i.test(c.tag)) datos[c.nombre] = c.valor; return; }
      datos[c.nombre] = c.valor;
      if (/fecha|corte/i.test(c.nombre) && !c.valor) datos[c.nombre] = hoyCO_();
    });
    // Estado del vehiculo (radios Activos/Inactivos/Todos): la opcion marcada por defecto es "Activos";
    // si el campo oculto del estado esta vacio, se llena con la opcion elegida (lo hace el JS del portal)
    const radioEstado = Object.keys(datos).filter(k => /estado/i.test(k) && f.campos.some(c => c.tipo === 'radio' && c.nombre === k))[0];
    if (radioEstado) f.campos.filter(c => c.tipo === 'hidden' && /estado/i.test(c.nombre || '') && !c.valor).forEach(c => datos[c.nombre] = datos[radioEstado]);
    // ocultos configurados (p.ej. tipoInforme de Documentos Afiliados) = opcion marcada del unico grupo de radios
    const radios = f.campos.filter(c => c.tipo === 'radio' && c.nombre);
    (CONFIG.PORTAL_OCULTOS_RADIO && CONFIG.PORTAL_OCULTOS_RADIO[ruta] || []).forEach(n => {
      if (datos[n]) return;
      const marcado = radios.filter(c => /\bchecked\b/i.test(c.tag))[0] || radios[0];
      if (marcado) datos[n] = marcado.valor;
    });
    const filtros = CONFIG.PORTAL_FILTROS[ruta] || {};
    Object.keys(filtros).forEach(k => f.campos.filter(c => c.tipo === 'select' && new RegExp(k, 'i').test(c.nombre || '')).forEach(c => {
      const o = (c.opciones || []).filter(o => normalizar_(o.texto) === normalizar_(filtros[k]))[0] || (c.opciones || []).filter(o => normalizar_(o.texto).indexOf(normalizar_(filtros[k]).slice(0, 5)) === 0)[0];
      if (o) datos[c.nombre] = o.valor;
    }));
    Object.assign(datos, extra || {});
    const submits = f.campos.filter(c => /submit|image/.test(c.tipo));
    const excel = submits.filter(c => PALABRAS_DESCARGA_.test(c.tag));
    (excel.length ? excel : (submits.length ? submits : [{ tag: '', nombre: null }])).forEach(b => {
      const d = Object.assign({}, datos); if (b.nombre) d[b.nombre] = b.valor;
      intentos.push({ url: absoluta_(atributo_(b.tag, 'formaction') || f.action || pagina.url, pagina.url), metodo: f.metodo, datos: d });
    });
  });
  // 2) Enlaces/rutas de Excel, pero solo si pertenecen a este reporte (nunca el menu: Contratos, etc.)
  const reA = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reA.exec(html))) {
    const u = absoluta_(entidades_(m[1]), pagina.url);
    if (PALABRAS_DESCARGA_.test(m[1] + ' ' + m[2]) && !/^javascript:/i.test(m[1]) && rutaDelReporte_(u, ruta)) intentos.push({ url: u, metodo: 'get', datos: extra || null });
  }
  const reJs = /["'](\/[A-Za-z0-9_\/-]*(?:Export|Excel|Descarg|Generar)[A-Za-z0-9_\/-]*)["']/gi;
  while ((m = reJs.exec(html))) if (rutaDelReporte_(m[1], ruta)) intentos.push({ url: absoluta_(m[1], pagina.url), metodo: 'get', datos: extra || null });
  if (!sinRespaldo) intentos.push({ url: CONFIG.PORTAL_BASE + ruta + '/Exportar', metodo: 'get', datos: extra || null });
  return intentos;
}
let _registroIntentos = null;
function probarIntentos_(jar, intentos, base, ruta, nivel) {
  const vistos = probarIntentos_._vistos || (probarIntentos_._vistos = {});
  for (let i = 0; i < intentos.length; i++) {
    const it = intentos[i], k = it.metodo + ' ' + it.url + JSON.stringify(it.datos || ''); if (vistos[k]) continue; vistos[k] = 1;
    const p = it.metodo === 'post' ? pedir_(jar, it.url, { method: 'post', payload: it.datos || {} }) : pedir_(jar, it.datos ? it.url + (it.url.indexOf('?') >= 0 ? '&' : '?') + Object.keys(it.datos).map(x => encodeURIComponent(x) + '=' + encodeURIComponent(it.datos[x])).join('&') : it.url);
    const h = p.r.getAllHeaders();
    if (_registroIntentos) _registroIntentos.push(it.metodo.toUpperCase() + ' ' + it.url + (it.datos ? ' ' + JSON.stringify(it.datos).slice(0, 200) : '') + ' → ' + p.code + ' ' + (h['Content-Type'] || h['content-type'] || '') + (h['Content-Disposition'] || h['content-disposition'] ? ' ' + (h['Content-Disposition'] || h['content-disposition']) : '') + ' (' + p.r.getContent().length + ' bytes)');
    if (p.code === 200 && esExcel_(p.r)) {
      const nombre = nombreDescarga_(p.r, base);
      // solo se acepta si el archivo es del reporte pedido (p.ej. no "Contratos_Total")
      const esperado = CONFIG.ARCHIVOS_REPORTE[ruta];
      const nombreOk = esperado ? esperado.test(nombre) : normalizar_(nombre).replace(/[^a-z]/g, '').indexOf(tokenReporte_(ruta)) >= 0;
      if (!/filename/i.test(String(h['Content-Disposition'] || h['content-disposition'] || '')) || nombreOk) return p.r.getBlob().setName(nombre);
      if (_registroIntentos) _registroIntentos.push('   ↳ descartado: ' + nombre + ' no es del reporte ' + ruta);
      continue;
    }
    // "Ver Informe" puede devolver una pagina con el informe y su propio boton de Excel
    if (p.code === 200 && !nivel && /text\/html/i.test(String(h['Content-Type'] || h['content-type'] || ''))) {
      const b = probarIntentos_(jar, intentosDescarga_(p.r.getContentText(), p, ruta, null, true).filter(x => PALABRAS_DESCARGA_.test(x.url + ' ' + JSON.stringify(x.datos || ''))), base, ruta, 1);
      if (b) return b;
    }
  }
  return null;
}
function descargarReportes_(ruta, porEmpresa, urlsFijas, base) {
  const jar = {};
  const pagina = iniciarSesionPortal_(jar, ruta);
  const html = pagina.r.getContentText();
  const blobs = [];
  (urlsFijas || []).filter(String).forEach(u => {
    const p = pedir_(jar, absoluta_(u, pagina.url));
    if (p.code === 200 && esExcel_(p.r)) blobs.push(p.r.getBlob().setName(nombreDescarga_(p.r, base + '_' + (blobs.length + 1))));
  });
  if (blobs.length) return blobs;
  if (porEmpresa) {
    formularios_(html).forEach(f => {
      const sel = f.campos.filter(c => c.tipo === 'select' && /empresa/i.test((c.nombre || '') + ' ' + c.tag) && (c.opciones || []).filter(o => o.valor).length > 1)[0];
      if (!sel || blobs.length) return;
      sel.opciones.filter(o => o.valor && !/seleccion|todas|todos/i.test(o.texto)).forEach(o => {
        const extra = {}; extra[sel.nombre] = o.valor;
        probarIntentos_._vistos = {};
        const b = probarIntentos_(jar, intentosDescarga_(html, pagina, ruta, extra), base + '_' + o.valor, ruta);
        if (b) blobs.push(b);
      });
    });
    if (blobs.length) return blobs;
  }
  probarIntentos_._vistos = {};
  const b = probarIntentos_(jar, intentosDescarga_(html, pagina, ruta), base, ruta);
  if (b) return [b];
  throw new Error('Inició sesión pero no encontró la descarga en Excel de ' + ruta + '. Ejecuta el diagnóstico y comparte el registro, o configura la URL de descarga');
}
function diagnosticarPortal(ruta) {
  ruta = typeof ruta === 'string' ? ruta : CONFIG.PORTAL_REPORTE;
  const jar = {};
  const p = iniciarSesionPortal_(jar, ruta);
  const html = p.r.getContentText();
  console.log('URL tras iniciar sesión: ' + p.url + ' · código ' + p.code + ' · cookies: ' + Object.keys(jar).join(', '));
  formularios_(html).forEach((f, i) => console.log('Formulario ' + i + ': ' + f.metodo.toUpperCase() + ' ' + f.action + ' · campos: ' + f.campos.map(c => c.tipo + ':' + (c.nombre || '') + (/submit|button/.test(c.tipo) ? '[' + c.tag.replace(/\s+/g, ' ').slice(0, 120) + ']' : '') + (c.opciones ? '{' + c.opciones.slice(0, 15).map(o => o.valor + '=' + o.texto).join(', ') + '}' : '') + (c.tipo === 'radio' || c.tipo === 'hidden' && c.nombre !== '__RequestVerificationToken' ? '=' + c.valor + (/\bchecked\b/i.test(c.tag) ? '(marcado)' : '') : '')).join(' | ')));
  const ocultos = []; formularios_(html).forEach(f => f.campos.filter(c => c.tipo === 'hidden' && c.nombre && c.nombre !== '__RequestVerificationToken').forEach(c => ocultos.push(c.nombre)));
  const js = (html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || []).join('\n').split('\n');
  console.log('JS que llena campos ocultos:\n' + js.filter(l => ocultos.some(o => l.indexOf(o) >= 0) || /radio-estado/.test(l)).map(l => l.trim().slice(0, 200)).slice(0, 25).join('\n'));
  const enlaces = html.match(/<(a|button)\b[^>]*>[\s\S]{0,80}?<\/(a|button)>/gi) || [];
  console.log('Botones/enlaces: \n' + enlaces.filter(x => /excel|xls|export|descarg|generar|consultar/i.test(x)).map(x => x.replace(/\s+/g, ' ')).join('\n'));
  console.log('Scripts: ' + (html.match(/<script[^>]*src=["'][^"']+["']/gi) || []).join(' '));
  console.log('Intentando la descarga…');
  _registroIntentos = [];
  try { const r = descargarReportes_(ruta, ruta === CONFIG.PORTAL_PARQUE, [], 'Diagnostico'); console.log('DESCARGA OK: ' + r.map(b => b.getName() + ' (' + b.getBytes().length + ' bytes)').join(', ')); }
  catch (e) { console.log('DESCARGA FALLÓ: ' + e.message); }
  console.log('Intentos:\n' + _registroIntentos.join('\n'));
  _registroIntentos = null;
  console.log('Rutas JS: ' + ((html.match(/["']\/[A-Za-z0-9_\/-]{3,}["']/g) || []).filter(x => /report|cartera|parque|export|excel/i.test(x)).join(' ')));
}
const ENC_PARQUE = ['Placa','No Interno','Nombre Propietario','Documento','Teléfono','Celular','Dirección de Residencia','Email','Fecha Nacimiento','Email Secundario','Ciudad propietario','Tar. Operacion #','Vence T. Operacion','Marca Vehículo','Clase Vehículo','Tipo Combustible','Tipo Carrocería','Pasajeros','Modelo','Cilindraje','Ciudad Vehiculo','Chasis','Motor','No. SOAT','Entidad Soat','Fecha SOAT','Entidad Seguros','Fecha Seguros','Fecha TecMecanica','Fecha Preventiva','Tipo Convenio','Empresa Convenio','Estado','Estado Vehículo','Fecha Creación','Usuario Creación','Empresa','Actualizado','Origen'];
const FECHAS_PARQUE = ['Vence T. Operacion','Fecha SOAT','Fecha Seguros','Fecha TecMecanica','Fecha Preventiva','Fecha Nacimiento'];
function isoCelda_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.ZONA, 'yyyy-MM-dd');
  const s = String(v === null || v === undefined ? '' : v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  return s;
}
function parsearParque_(filas) {
  let hIdx = -1, empresa = '';
  for (let i = 0; i < Math.min(filas.length, 10); i++) {
    const t = filas[i].map(normalizar_);
    if (t[0] && t[0].indexOf('empresa') === 0 && t[0].indexOf(':') > 0) empresa = String(filas[i].slice(1).filter(x => String(x).trim())[0] || '').trim();
    if (hIdx < 0 && t.indexOf('placa') >= 0 && (t.indexOf('vence t. operacion') >= 0 || t.indexOf('fecha soat') >= 0)) hIdx = i;
  }
  if (hIdx < 0) throw new Error('no se encontró el encabezado del parque automotor');
  // la columna sin titulo (entre "Empresa Convenio" y "Estado Vehículo") es el Estado
  const enc = filas[hIdx].map((h, j) => String(h || '').trim() || (normalizar_(filas[hIdx][j + 1]) === 'estado vehiculo' ? 'Estado' : ''));
  const idx = {}; enc.forEach((h, j) => { if (h && !(normalizar_(h) in idx)) idx[normalizar_(h)] = j; });
  const out = [];
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i]; const placa = String(f[idx['placa']] || '').trim().toUpperCase();
    if (!placa) continue;
    out.push(ENC_PARQUE.slice(0, 37).map(h => {
      if (h === 'Placa') return placa;
      if (h === 'Empresa') return String((idx['empresa'] !== undefined ? f[idx['empresa']] : '') || empresa || '').trim();
      const j = idx[normalizar_(h)]; const v = j === undefined ? '' : f[j];
      return FECHAS_PARQUE.indexOf(h) >= 0 ? isoCelda_(v) : (v instanceof Date ? Utilities.formatDate(v, CONFIG.ZONA, 'yyyy-MM-dd HH:mm') : (v === null || v === undefined ? '' : v));
    }));
  }
  return { empresa: empresa, filas: out };
}
function esActivoParque_(f) {
  const est = [f[ENC_PARQUE.indexOf('Estado')], f[ENC_PARQUE.indexOf('Estado Vehículo')]].map(normalizar_).filter(String);
  if (!est.length) return true;
  if (est.some(e => /^(inactiv|retir|desvinc|bloque|suspend)/.test(e))) return false;
  return est.some(e => e === 'activo' || e === 'activos');
}
function loginFleet_() {
  const p = PropertiesService.getScriptProperties();
  const r = UrlFetchApp.fetch(CONFIG.FLEET_SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: CONFIG.FLEET_ANON_KEY },
    payload: JSON.stringify({ email: String(p.getProperty('FLEET_USUARIO')).trim(), password: String(p.getProperty('FLEET_CLAVE')).replace(/^\s+|\s+$/g, '') })
  });
  const d = JSON.parse(r.getContentText() || '{}');
  if (r.getResponseCode() !== 200 || !d.access_token) throw new Error('FleetSync rechazó el inicio de sesión (' + (d.error_description || d.msg || d.error || r.getResponseCode()) + '). Revisa FLEET_USUARIO / FLEET_CLAVE');
  return d.access_token;
}
function rpcFleet_(token, funcion, archivo, filas) {
  const r = UrlFetchApp.fetch(CONFIG.FLEET_SUPABASE_URL + '/rest/v1/rpc/' + funcion, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: CONFIG.FLEET_ANON_KEY, Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ p_archivo: archivo, p_rows: filas })
  });
  const txt = r.getContentText();
  let d; try { d = JSON.parse(txt); } catch (e) { d = txt; }
  if (r.getResponseCode() >= 300) throw new Error(funcion + ': ' + ((d && (d.message || d.hint || d.details)) || txt).toString().slice(0, 300));
  return d;
}
function objetosDesdeFilas_(filas, palabras) {
  let h = 0;
  for (let i = 0; i < Math.min(10, filas.length); i++) {
    const linea = filas[i].map(c => String(c).toLowerCase()).join('|');
    if (palabras.some(k => linea.indexOf(k.toLowerCase()) >= 0)) { h = i; break; }
  }
  const enc = filas[h].map(c => String(c === null || c === undefined ? '' : c).trim());
  return filas.slice(h + 1).map(f => { const o = {}; enc.forEach((k, j) => { if (k && !(k in o)) o[k] = f[j]; }); return o; });
}
function pick_(o, claves) {
  for (let i = 0; i < claves.length; i++) { const v = o[claves[i]]; if (v !== null && v !== undefined && v !== '') return v; }
  // mismos titulos escritos distinto (PLACA, Placa , Identificación...)
  const n = k => normalizar_(k).replace(/\s+/g, ' ');
  if (!o.__norm) { Object.defineProperty(o, '__norm', { value: {}, enumerable: false }); Object.keys(o).forEach(k => { if (!(n(k) in o.__norm)) o.__norm[n(k)] = o[k]; }); }
  for (let i = 0; i < claves.length; i++) { const v = o.__norm[n(claves[i])]; if (v !== null && v !== undefined && v !== '') return v; }
  return '';
}
function txtF_(v) { return v instanceof Date ? Utilities.formatDate(v, CONFIG.ZONA, 'yyyy-MM-dd') : String(v === null || v === undefined ? '' : v).trim(); }
function fechaF_(v) { if (!v) return null; const s = isoCelda_(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; }
function tsF_(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s*m\.?)?)?/i);
  if (m) { let hh = Number(m[4] || 0); if (m[7] && /p/i.test(m[7]) && hh < 12) hh += 12; if (m[7] && /a/i.test(m[7]) && hh === 12) hh = 0;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), hh, Number(m[5] || 0), Number(m[6] || 0)).toISOString(); }
  const d = new Date(v); return isNaN(d) ? null : d.toISOString();
}
function filasDocumentosFleet_(filas) {
  return objetosDesdeFilas_(filas, ['Placa', 'Nombre Documento']).map(r => ({
    placa: txtF_(pick_(r, ['Placa', 'placa'])),
    documento_persona: txtF_(pick_(r, ['Nro Identificacion', 'Nro Identificación', 'Documento', 'documento_persona'])),
    nombre_persona: txtF_(pick_(r, ['Nombre', 'nombre_persona'])),
    tipo_titular: txtF_(pick_(r, ['Tipo', 'tipo_titular'])),
    nombre_documento: txtF_(pick_(r, ['Nombre Documento', 'nombre_documento'])),
    inicio_vigencia: fechaF_(pick_(r, ['Inicio Vigencia', 'inicio_vigencia'])),
    vigente_hasta: fechaF_(pick_(r, ['Vigente Hasta', 'vigente_hasta'])),
    estado: txtF_(pick_(r, ['Estado', 'estado'])),
    fecha_cargue: tsF_(pick_(r, ['Fecha - Hora Cargue', 'Fecha Hora Cargue', 'fecha_cargue'])),
    usuario_cargue: txtF_(pick_(r, ['Usuario', 'usuario_cargue'])),
    empresa: txtF_(pick_(r, ['Empresa', 'empresa']))
  })).filter(x => x.placa);
}
function filasConductoresFleet_(filas) {
  return objetosDesdeFilas_(filas, ['Documento', 'Nombres', 'Apellidos']).map(r => ({
    documento: txtF_(pick_(r, ['Documento', 'documento'])), nombres: txtF_(pick_(r, ['Nombres', 'nombres'])), apellidos: txtF_(pick_(r, ['Apellidos', 'apellidos'])),
    celular: txtF_(pick_(r, ['Celular', 'celular', 'Telefono'])), correo: txtF_(pick_(r, ['Correo Electronico', 'Correo Electrónico', 'Correo', 'correo'])),
    licencia_num: txtF_(pick_(r, ['Numero Licencia', 'Número Licencia'])), licencia_cat: txtF_(pick_(r, ['Categoria', 'Categoría'])),
    licencia_vence: fechaF_(pick_(r, ['Fecha Licencia'])), eps: txtF_(pick_(r, ['Nombre EPS', 'EPS'])), arl: txtF_(pick_(r, ['Entidad ARL', 'ARL'])),
    tipo_sangre: txtF_(pick_(r, ['Tipo Sangre'])), tel_emergencia: txtF_(pick_(r, ['Tel Emergencia'])), cod_interno: txtF_(pick_(r, ['Cod. Interno', 'Cod Interno'])),
    placa1: txtF_(pick_(r, ['Placa #1'])), placa2: txtF_(pick_(r, ['Placa #2'])), placa3: txtF_(pick_(r, ['Placa #3'])), placa4: txtF_(pick_(r, ['Placa #4'])), placa5: txtF_(pick_(r, ['Placa #5']))
  })).filter(x => x.documento);
}
function verificarPermisos() {
  const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
  if (info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED) {
    console.warn('Faltan permisos. Si no aparece la ventana, abre este enlace con juridico@ y marca "Seleccionar todo": ' + info.getAuthorizationUrl());
    ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  }
  console.log('Permisos completos: portal, Gmail, Drive, Calendar y envío de correo.');
}
function hoyISO_() { return Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyy-MM-dd'); }
function fmt_(iso) { if (!iso) return '—'; const p = String(iso).slice(0, 10).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso); }
