// Special CAR -- FleetSync | app.js v6.1

// Leer configuración desde SHEETS_CONFIG (definido antes en el HTML)
// Usando var para hoisting -- funciona aunque SHEETS_CONFIG se declare en otro script
var SCRIPT_URL = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.SCRIPT_URL)
  ? SHEETS_CONFIG.SCRIPT_URL : '';
var ADMIN_PIN = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.ADMIN_PIN)
  ? SHEETS_CONFIG.ADMIN_PIN : 'admin123';


const LOCALIDADES = [
  'Usaquén','Chapinero','Santa Fe','San Cristóbal','Usme',
  'Tunjuelito','Bosa','Kennedy','Fontibón','Engativá',
  'Suba','Barrios Unidos','Teusaquillo','Los Mártires',
  'Antonio Nariño','Puente Aranda','La Candelaria',
  'Rafael Uribe Uribe','Ciudad Bolívar','Sumapaz'
];

const HOURS = Array.from({length:24},(_,i)=>`${String(i).padStart(2,'0')}:00`);

// -- State ------------------------------------------
let currentDriver  = null;
let allTurnos      = [];
let driverCache    = [];
let lastSync       = null;
let viewMonth      = new Date(); viewMonth.setDate(1);

let selStartHour   = null;
let selEndHour     = null;
let selOvernight   = false;   // turno que cruza medianoche
let editRowIndex   = -1;
let editStartH     = null;
let editEndH       = null;
let editOvernight  = false;

// -- Date/Hour helpers (FIXED for "2026-03-23 7:00" format) ------------

// Extrae la fecha "YYYY-MM-DD" de un valor como "2026-03-23 7:00"
// parseDate: extrae "YYYY-MM-DD" de cualquier formato que venga del Sheet
// Formatos posibles: "2026-03-23 07:00", "2026-03-23T07:00:00Z",
// "Sat Mar 21 2026 07:00:00 GMT-0500 (Colombia Standard Time)"
function parseDate(v) {
  if (!v) return '';
  var s = String(v).trim();
  // Formato YYYY-MM-DD al inicio — mas comun
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Formato largo tipo "Sat Mar 21 2026 07:00:00 GMT-0500..."
  // Extraer el ano y construir desde ahi
  var mLong = s.match(/(\w+)\s+(\w+)\s+(\d+)\s+(\d{4})/);
  if (mLong) {
    var months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                  Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
    var mo = months[mLong[2]] || '01';
    var dd = String(parseInt(mLong[3])).padStart(2,'0');
    return mLong[4]+'-'+mo+'-'+dd;
  }
  // Fallback: intentar con Date nativo
  try {
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      return d.getUTCFullYear()+'-'+
        String(d.getUTCMonth()+1).padStart(2,'0')+'-'+
        String(d.getUTCDate()).padStart(2,'0');
    }
  } catch(e) {}
  return s.slice(0,10);
}

// parseHour: extrae "HH:MM" de cualquier formato del Sheet
// Formatos posibles: "2026-03-23 07:00", "07:00",
// "Sat Mar 21 2026 07:00:00 GMT-0500 (Colombia Standard Time)"
function parseHour(v) {
  if (!v) return '00:00';
  var s = String(v).trim();
  // Formato ISO con T: "2026-03-23T07:00:00.000Z" — hora en UTC
  if (s.includes('T')) {
    var tp = (s.split('T')[1]||'').replace('Z','').split('.')[0].split(':');
    var hh = parseInt(tp[0]), mm = parseInt(tp[1]||0);
    if (!isNaN(hh) && hh >= 0 && hh <= 23)
      return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  }
  // Formato "YYYY-MM-DD HH:MM" — tomar la parte despues del espacio
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) {
    var tp = s.split(' ')[1].split(':');
    var hh = parseInt(tp[0]), mm = parseInt(tp[1]||0);
    if (!isNaN(hh) && hh >= 0 && hh <= 23)
      return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  }
  // Formato largo "Sat Mar 21 2026 07:00:00 GMT-0500..."
  // Extraer la parte "07:00:00"
  var mTime = s.match(/(\d{1,2}):(\d{2}):\d{2}\s+GMT/);
  if (mTime) {
    var hh = parseInt(mTime[1]), mm = parseInt(mTime[2]);
    if (!isNaN(hh) && hh >= 0 && hh <= 23)
      return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  }
  // Solo "HH:MM"
  var tp = s.split(':');
  var hh = parseInt(tp[0]), mm = parseInt(tp[1]||0);
  if (!isNaN(hh) && hh >= 0 && hh <= 23)
    return String(hh).padStart(2,'0')+':'+String(mm).padStart(2,'0');
  return '00:00';
}

// Extrae la hora "HH:MM" — maneja todos los formatos posibles del Sheet
// Formatos posibles: "2026-03-23 7:00", "07:00", "Mon Mar 23 2026 07:00:00 GMT..."
// El Sheet puede devolver Date objects serializados o strings
function parseHour(v) {
  if (!v) return '00:00';
  var s = String(v).trim();
  // Si tiene formato ISO con T: "2026-03-23T07:00:00.000Z"
  if (s.includes('T')) {
    var tParts = s.split('T');
    var timePart = (tParts[1]||'').split('.')[0].split('Z')[0];
    var tp = timePart.split(':');
    return String(parseInt(tp[0])||0).padStart(2,'0') + ':' + (tp[1]||'00').padStart(2,'0');
  }
  // Si tiene formato "YYYY-MM-DD HH:MM": tomar la parte de hora
  var parts = s.split(' ');
  var raw = parts.length >= 2 ? parts[parts.length-1] : parts[0];
  // Si raw tiene mas de 5 chars (ej: "07:00:00") cortar
  var timePart = raw.split(':').slice(0,2).join(':');
  var tp = timePart.split(':');
  var hh = parseInt(tp[0]);
  var mm = parseInt(tp[1]||'0');
  // Validacion: si hh > 23 probablemente es un ano (2026) — dato corrupto
  if (isNaN(hh) || hh > 23 || hh < 0) return '00:00';
  return String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0');
}

// Normaliza cualquier hora suelta "7:00" -> "07:00"
function normH(h) {
  if (!h) return '00:00';
  const [hh, mm='00'] = String(h).split(':');
  return `${String(parseInt(hh)||0).padStart(2,'0')}:${mm.padStart(2,'0')}`;
}

// Formatea fecha+hora para guardar en Sheet: "2026-03-23 07:00"
function fmtDT(dateStr, hourStr) {
  const [hh, mm='00'] = String(hourStr||'00:00').split(':');
  return `${dateStr} ${String(parseInt(hh)||0).padStart(2,'0')}:${mm.padStart(2,'0')}`;
}

// Calcula horas entre dos celdas. Soporta turnos nocturnos (fin < inicio)
function calcHours(ini, fin) {
  try {
    var sh = parseInt(parseHour(ini));
    var eh = parseInt(parseHour(fin));
    var sd = parseDate(ini);
    var ed = parseDate(fin);
    // Turno de exactamente 24h: misma hora inicio=fin pero diferente dia
    if (sh === eh && sd !== ed) return 24;
    // Turno nocturno: fin < inicio (cruza medianoche)
    if (eh < sh) return (24 - sh) + eh;
    // Misma hora mismo dia = 0, pero si fin==inicio asumir 24h (turno completo)
    if (sh === eh) return 24;
    return eh - sh;
  } catch(e) { return 0; }
}

// Dado un turno, devuelve la "fecha de inicio" siempre en formato limpio
function turnoStartDate(r) { return parseDate(r.inicio); }

// Para turnos nocturnos, el fin puede ser el día siguiente
function turnoEndDate(r) {
  const sd = parseDate(r.inicio);
  const sh = parseInt(parseHour(r.inicio));
  const eh = parseInt(parseHour(r.fin));
  if (eh <= sh && sh > 0) {
    // cruce de medianoche: sumar 1 día
    const d = new Date(sd + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    return ds(d);
  }
  return sd;
}

function ds(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDateHuman(v) {
  try { return new Date(parseDate(v) + 'T12:00:00').toLocaleDateString('es-CO', {weekday:'long',year:'numeric',month:'long',day:'numeric'}); }
  catch(e) { return v; }
}
function fmtDateShort(v) {
  try { return new Date(parseDate(v) + 'T12:00:00').toLocaleDateString('es-CO', {day:'numeric',month:'short'}); }
  catch(e) { return v; }
}

// canAdd: el turno solo debe estar en el futuro (>= ahora)
// No requiere 12h — se puede agregar un turno para dentro de 1 hora
function canAdd(dateStr, startHour) {
  const h  = startHour ? normH(startHour) : null;
  const dt = h ? new Date(dateStr + 'T' + h + ':00') : new Date(dateStr + 'T23:59:59');
  return dt > new Date();
}

// canModify: para EDITAR o CANCELAR, requiere >= 12h de anticipacion
function canModify(dateStr, startHour) {
  const h  = startHour ? normH(startHour) : null;
  const dt = h ? new Date(dateStr + 'T' + h + ':00') : new Date(dateStr + 'T23:59:59');
  return (dt - new Date()) > 12 * 60 * 60 * 1000;
}
function canEditRow(r) {
  // Solo se puede modificar si esta 'active' (no asignado) y con >= 12h
  return r.estado === 'active' && canModify(turnoStartDate(r), parseHour(r.inicio));
}

function myActive() { return allTurnos.filter(r => r.doc===currentDriver.doc && r.plate===currentDriver.plate && (r.estado==='active'||r.estado==='asignado')); }
function myAll()    { return allTurnos.filter(r => r.doc===currentDriver.doc && r.plate===currentDriver.plate); }

// -- JSONP API -- con diagnóstico detallado ----------
let _cbN = 0;

function apiJsonp(params) {
  return new Promise((resolve, reject) => {
    if (!SCRIPT_URL || SCRIPT_URL.startsWith('PEGA')) {
      return reject(new Error('[Config] Config incompleta: pega la URL del Apps Script en config.js'));
    }
    if (!SCRIPT_URL.includes('script.google.com')) {
      return reject(new Error('[Aviso] La URL no parece ser de Google Apps Script. Debe contener "script.google.com"'));
    }

    const cbName = '__sc_' + (++_cbN);
    const TIMEOUT_MS = 20000;

    const tid = setTimeout(() => {
      cleanup();
      reject(new Error(
        '[Timeout] Tiempo de espera agotado (20s).\n' +
        'Posibles causas:\n' +
        '- El script no está desplegado como Web App\n' +
        '- El acceso no es "Cualquier persona"\n' +
        '- La URL es de una implementación antigua -- crea una NUEVA implementación'
      ));
    }, TIMEOUT_MS);

    function cleanup() {
      delete window[cbName];
      const el = document.getElementById(cbName);
      if (el) el.remove();
      clearTimeout(tid);
    }

    window[cbName] = function(data) {
      cleanup();
      if (!data) return reject(new Error('El script respondió vacío'));
      if (!data.ok) return reject(new Error(data.error || 'El script respondió con error desconocido'));
      resolve(data);
    };

    const allParams = { ...params, callback: cbName };
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(allParams).map(([k,v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
      )
    ).toString();

    const script = document.createElement('script');
    script.id    = cbName;
    script.src   = `${SCRIPT_URL}?${qs}`;

    script.onerror = function() {
      cleanup();
      // Intenta dar una causa más específica
      if (SCRIPT_URL.endsWith('/exec')) {
        reject(new Error(
          '[Error] El script rechazó la conexión.\n' +
          'Pasos para resolver:\n' +
          '1. Abre tu Apps Script\n' +
          '2. Implementar -> Nueva implementación\n' +
          '3. Tipo: Aplicación web\n' +
          '4. Ejecutar como: Yo\n' +
          '5. Acceso: Cualquier persona\n' +
          '6. Copia la NUEVA URL y actualiza config.js'
        ));
      } else {
        reject(new Error('[Error] URL inválida. La URL debe terminar en "/exec"'));
      }
    };

    document.head.appendChild(script);
  });
}

async function api(p) { return apiJsonp(p); }

// -- Test de conexión manual (para diagnóstico) ----─
async function testConnection() {
  const urlInput = document.getElementById('diagUrl');
  const statusEl = document.getElementById('diagStatus');
  const url = urlInput ? urlInput.value.trim() : SCRIPT_URL;

  if (!url || url.startsWith('PEGA')) {
    showDiagStatus('error', '[Aviso] Ingresa la URL del script primero.');
    return;
  }

  showDiagStatus('loading', '[Sync] Probando conexión con el script...');

  const cbName = '__sc_test_' + Date.now();
  const timeout = setTimeout(() => {
    delete window[cbName];
    const s = document.getElementById(cbName); if(s) s.remove();
    showDiagStatus('error', '[Timeout] Sin respuesta en 15 segundos. El script no está activo o la URL es incorrecta.');
  }, 15000);

  window[cbName] = function(data) {
    clearTimeout(timeout);
    delete window[cbName];
    const s = document.getElementById(cbName); if(s) s.remove();
    if (data && data.ok) {
      showDiagStatus('ok', `[OK] Conexión exitosa. El script responde correctamente.\n\nAcción probada: "ping"\nRespuesta: ${JSON.stringify(data)}`);
    } else {
      showDiagStatus('error', `[Aviso] El script respondió pero con error: ${data?.error || JSON.stringify(data)}`);
    }
  };

  const script = document.createElement('script');
  script.id  = cbName;
  script.src = `${url}?action=ping&callback=${cbName}`;
  script.onerror = function() {
    clearTimeout(timeout);
    delete window[cbName];
    script.remove();
    showDiagStatus('error', '[Error] No se pudo cargar el script. Verifica:\n- La URL es correcta\n- El despliegue existe y es público\n- El script no tiene errores de sintaxis');
  };
  document.head.appendChild(script);
}

function showDiagStatus(type, msg) {
  const el = document.getElementById('diagStatus');
  if (!el) return;
  el.style.display = 'block';
  el.className = `diag-status diag-${type}`;
  el.innerHTML = msg.replace(/\n/g, '<br>');
}

// -- Init ------------------------------------------─
window.addEventListener('load', () => {
  if (!SCRIPT_URL || SCRIPT_URL.startsWith('PEGA')) { hideSplash(); showToast('[Aviso] Edita config.js con la URL del Apps Script.','warning'); return; }
  setTimeout(hideSplash, 900);
});
function hideSplash() {
  const s = document.getElementById('splashScreen'); s.classList.add('fade');
  setTimeout(() => { s.style.display='none'; document.getElementById('loginScreen').style.display='block'; }, 380);
}

// -- Auth ------------------------------------------─
async function doLogin() {
  const plate = document.getElementById('loginPlate').value.trim().toUpperCase();
  const pin   = document.getElementById('loginPin').value.trim();
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginLoading').classList.add('show');
  document.getElementById('loginBtn').disabled = true;
  try {
    const data = await api({action:'login', plate, doc:pin});
    currentDriver = {...data.driver, rowIndex:data.rowIndex};
    finishLogin();
  } catch(e) { showLoginError(e.message); }
}
function showLoginError(msg) {
  document.getElementById('loginLoading').classList.remove('show');
  document.getElementById('loginBtn').disabled = false;
  const el = document.getElementById('loginError'); el.textContent = msg; el.style.display = 'block';
}
function openAdminLogin() { document.getElementById('loginPlate').value='ADMIN'; document.getElementById('loginPin').value=''; document.getElementById('loginPin').focus(); }
function finishLogin() {
  document.getElementById('loginLoading').classList.remove('show');
  document.getElementById('loginBtn').disabled = false;
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
  document.getElementById('sidebarName').textContent    = currentDriver.name;
  document.getElementById('sidebarPlate').textContent   = currentDriver.plate;
  document.getElementById('sidebarInitial').textContent = currentDriver.name.charAt(0).toUpperCase();
  document.getElementById('dashName').textContent       = currentDriver.name.split(' ')[0];

  if (currentDriver.isAdmin) {
    document.getElementById('adminNav').style.display        = 'block';
    document.getElementById('navMisTurnos').style.display    = 'none';
    document.getElementById('navAgregarTurno').style.display = 'none';
    // Vista mensual: admin la ve (con placas), conductor la ve (con sus turnos)
    document.getElementById('navMiPerfil').style.display     = 'none';
  } else {
    document.getElementById('navMisTurnos').style.display    = '';
    document.getElementById('navAgregarTurno').style.display = '';
    document.getElementById('navVistaMensual').style.display = '';
    document.getElementById('navMiPerfil').style.display     = '';
  }

  document.getElementById('addDate').value = ds(new Date());
  fillLocalities(); loadDashboard(); loadProfileData();
  if (currentDriver.isAdmin) {
    setTimeout(function(){ showPage('admin', document.querySelector('#adminNav .nav-item')); }, 150);
  }
}
function fillLocalities() {
  ['addLocSelect','editLocSelect','weekLocSelect','monthLocSelect','pLocality'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = '<option value="">[Loc] Selecciona la localidad...</option>' + LOCALIDADES.map(l=>`<option value="${l}">${l}</option>`).join('');
    if (id==='pLocality' && currentDriver.locality) el.value = currentDriver.locality;
  });
}
function doLogout() {
  currentDriver=null; lastSync=null; allTurnos=[];
  document.getElementById('appScreen').style.display='none';
  document.getElementById('loginScreen').style.display='block';
  document.getElementById('loginPlate').value=''; document.getElementById('loginPin').value='';
  document.getElementById('adminNav').style.display='none';
  showPage('dashboard', document.querySelector('.nav-item'));
}

// -- Load data --------------------------------------
async function loadMyTurnos() {
  const data = await api({action:'getHorarios', doc:currentDriver.doc, plate:currentDriver.plate});
  allTurnos = data.turnos || [];
}

// -- Navigation ------------------------------------─
function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  if (el) el.classList.add('active');
  if (name==='schedule')     loadSchedulePage('upcoming');
  if (name==='monthly-view') loadMonthlyPage();
  if (name==='dashboard')    loadDashboard();
  if (name==='profile')      loadProfileData();
  if (name==='add-schedule') initAddPage();
  if (name==='admin')        loadAdminPage();
}
function switchSchedTab(tab, btn) {
  document.querySelectorAll('#page-schedule .tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); renderSchedList(tab);
}

// -- Hour picker ------------------------------------
function initAddPage() {
  selStartHour=null; selEndHour=null; selOvernight=false;
  renderStartPicker();
}

function getUsedRanges(dateStr) {
  return myActive().filter(r => turnoStartDate(r)===dateStr)
    .map(r => ({s:normH(parseHour(r.inicio)), e:normH(parseHour(r.fin)), overnight: calcHours(r.inicio,r.fin) > (parseInt(parseHour(r.fin)) - parseInt(parseHour(r.inicio)))}));
}

function isHourUsed(h, ranges) { return (ranges||[]).some(r => !r.overnight && h>=r.s && h<r.e); }
function isRangeUsed(s, e, ranges, overnight) {
  if (overnight) return false; // simplification: overnight ranges don't block same-day slots
  return (ranges||[]).some(r => s<r.e && e>r.s);
}

function renderStartPicker(dateOverride) {
  const startWrap = document.getElementById('startHourPicker');
  if (!startWrap) return;
  const dateVal   = dateOverride || document.getElementById('addDate').value;
  const used      = getUsedRanges(dateVal);
  startWrap.innerHTML = HOURS.map(h => {
    const u = isHourUsed(h, used), sel = h===selStartHour;
    return `<button type="button" class="hbtn${sel?' sel':''}${u?' used':''}" ${u?'disabled':''} onclick="pickDayStart('${h}')">${h}</button>`;
  }).join('');
  renderEndPicker(used);
}

function renderEndPicker(usedRanges) {
  const endWrap = document.getElementById('endHourPicker');
  const sec     = document.getElementById('endPickerSection');
  if (!selStartHour) { if(sec) sec.style.display='none'; if(endWrap) endWrap.innerHTML=''; return; }
  if (sec) sec.style.display = 'block';
  // Show ALL 24 hours after start (enable overnight: hours before start are "next day")
  const allHoursAfter = HOURS.filter(h => h !== selStartHour);
  endWrap.innerHTML = allHoursAfter.map(h => {
    const isNextDay = h <= selStartHour;
    const sel = h===selEndHour;
    return `<button type="button" class="hbtn${sel?' sel':''}${isNextDay?' next-day':''}" onclick="pickDayEnd('${h}')" title="${isNextDay?'Día siguiente':''}">
      ${h}${isNextDay?'<span class="nd-tag">+1</span>':''}
    </button>`;
  }).join('');
  updateAddSummary();
}

window.pickDayStart = function(h) {
  selStartHour=h; selEndHour=null; selOvernight=false;
  document.getElementById('startHourPicker').querySelectorAll('.hbtn').forEach(b=>b.classList.toggle('sel', b.dataset.h===h || b.textContent.trim()===h));
  renderEndPicker(getUsedRanges(document.getElementById('addDate').value));
};
window.pickDayEnd = function(h) {
  selEndHour   = h;
  selOvernight = h <= selStartHour;
  document.getElementById('endHourPicker').querySelectorAll('.hbtn').forEach(b=>{
    const bh = b.textContent.replace('+1','').trim();
    b.classList.toggle('sel', bh===h);
  });
  updateAddSummary();
};

function updateAddSummary() {
  const el = document.getElementById('addSummary'); if (!el) return;
  if (selStartHour && selEndHour) {
    const diff = calcHoursFromStr(selStartHour, selEndHour, selOvernight);
    const tag  = selOvernight ? ' <span class="overnight-tag">[Noche] Turno nocturno (cruza medianoche)</span>' : '';
    el.innerHTML = `<strong>[OK] ${selStartHour} -> ${selEndHour}${selOvernight?' (+1 día)':''}</strong> &nbsp;(${diff}h)${tag}`;
    el.className = 'add-summary ok';
  } else if (selStartHour) {
    el.innerHTML = `Inicio: <strong>${selStartHour}</strong> -- selecciona la hora de fin. Las horas marcadas <span class="nd-tag">+1</span> son del día siguiente.`;
    el.className = 'add-summary partial';
  } else {
    el.textContent = 'Selecciona la hora de inicio del turno';
    el.className = 'add-summary empty';
  }
}

function calcHoursFromStr(startH, endH, overnight) {
  const s = parseInt(startH), e = parseInt(endH);
  if (overnight || e <= s) return (24 - s) + e;
  return e - s;
}

// Week/month pickers (no overnight support for bulk -- single shift per day)
function initWeekPicker() {
  selStartHour=null; selEndHour=null; selOvernight=false;
  document.getElementById('weekStartPicker').innerHTML =
    HOURS.map(h=>`<button type="button" class="hbtn" onclick="pickBulkStart('${h}','week')">${h}</button>`).join('');
  document.getElementById('weekEndSection').style.display='none';
  updateBulkSummary('week');
}
function initMonthPicker() {
  selStartHour=null; selEndHour=null; selOvernight=false;
  document.getElementById('monthStartPicker').innerHTML =
    HOURS.map(h=>`<button type="button" class="hbtn" onclick="pickBulkStart('${h}','month')">${h}</button>`).join('');
  document.getElementById('monthEndSection').style.display='none';
  updateBulkSummary('month');
}

window.pickBulkStart = function(h, mode) {
  selStartHour=h; selEndHour=null; selOvernight=false;
  document.getElementById(mode+'StartPicker').querySelectorAll('.hbtn').forEach(b=>b.classList.toggle('sel',b.textContent.trim()===h));
  const sec = document.getElementById(mode+'EndSection'); if(sec) sec.style.display='block';
  document.getElementById(mode+'EndPicker').innerHTML =
    HOURS.filter(x=>x!==h).map(x=>{
      const isND = x<=h;
      return `<button type="button" class="hbtn${isND?' next-day':''}" onclick="pickBulkEnd('${x}','${mode}')">${x}${isND?'<span class="nd-tag">+1</span>':''}</button>`;
    }).join('');
  updateBulkSummary(mode);
};
window.pickBulkEnd = function(h, mode) {
  selEndHour=h; selOvernight=h<=selStartHour;
  document.getElementById(mode+'EndPicker').querySelectorAll('.hbtn').forEach(b=>b.classList.toggle('sel',b.textContent.replace('+1','').trim()===h));
  updateBulkSummary(mode);
};
function updateBulkSummary(mode) {
  const el = document.getElementById(mode+'Summary'); if(!el) return;
  if (selStartHour && selEndHour) {
    const diff = calcHoursFromStr(selStartHour, selEndHour, selOvernight);
    const tag  = selOvernight ? ' [Noche]' : '';
    el.innerHTML = `<strong>[OK] ${selStartHour} -> ${selEndHour}${selOvernight?' (+1)':''}${tag}</strong> (${diff}h)`;
    el.className = 'add-summary ok';
  } else if (selStartHour) {
    el.textContent = `Inicio: ${selStartHour} -- selecciona fin`;
    el.className = 'add-summary partial';
  } else {
    el.textContent = 'Selecciona hora de inicio';
    el.className = 'add-summary empty';
  }
}

function switchAddTab(tab, btn) {
  document.querySelectorAll('#page-add-schedule .tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  ['day','week','month'].forEach(t=>{document.getElementById('addTab-'+t).style.display=t===tab?'block':'none';});
  selStartHour=null; selEndHour=null; selOvernight=false;
  if (tab==='day')   initAddPage();
  if (tab==='week')  initWeekPicker();
  if (tab==='month') initMonthPicker();
}

// -- Save turnos ------------------------------------
async function saveNewTurno() {
  const dateVal  = document.getElementById('addDate').value;
  const locality = document.getElementById('addLocSelect').value;
  const notes    = document.getElementById('addNotes').value.trim();
  if (!dateVal)      { showToast('Selecciona una fecha.','warning'); return; }
  if (!locality)     { showToast('Selecciona la localidad.','warning'); return; }
  if (!selStartHour) { showToast('Selecciona la hora de inicio.','warning'); return; }
  if (!selEndHour)   { showToast('Selecciona la hora de fin.','warning'); return; }
  if (!canAdd(dateVal, selStartHour)) { showToast('[Aviso] El turno debe ser en una hora futura.','warning'); return; }

  const inicio = fmtDT(dateVal, selStartHour);
  // Si el turno cruza medianoche, el fin es en el día siguiente
  const finDate = selOvernight ? ds((() => { const d=new Date(dateVal+'T12:00:00'); d.setDate(d.getDate()+1); return d; })()) : dateVal;
  const fin    = fmtDT(finDate, selEndHour);

  showLoading('Guardando en Google Sheets...');
  try {
    await api({action:'addTurno', doc:currentDriver.doc, plate:currentDriver.plate, inicio, fin, locality, notes});
    await loadMyTurnos();
    selStartHour=null; selEndHour=null; selOvernight=false;
    initAddPage();
    loadDashboard();
    showToast(`[OK] Turno ${inicio} -> ${fin} guardado.`, 'success');
  } catch(e) { showToast('[Error] '+e.message,'error'); }
  hideLoading();
}

async function saveWeekTurnos() {
  const dateVal  = document.getElementById('weekStartDate').value;
  const locality = document.getElementById('weekLocSelect').value;
  if (!dateVal||!locality) { showToast('Completa fecha y localidad.','warning'); return; }
  if (!selStartHour||!selEndHour) { showToast('Selecciona hora de inicio y fin.','warning'); return; }
  const checked = [...document.querySelectorAll('.week-day-cb:checked')].map(cb=>parseInt(cb.value));
  if (!checked.length) { showToast('Selecciona al menos un día.','warning'); return; }

  const base = new Date(dateVal+'T12:00:00');
  const dow  = base.getDay();
  const mon  = new Date(base); mon.setDate(base.getDate()-(dow===0?6:dow-1));

  showLoading('Guardando semana...');
  let n=0, skipped=0;
  for (let i=0; i<7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate()+i);
    if (!checked.includes(d.getDay())) continue;
    const date = ds(d);
    if (!canAdd(date, selStartHour)) { skipped++; continue; }
    const finDate = selOvernight ? ds((() => { const fd=new Date(d); fd.setDate(fd.getDate()+1); return fd; })()) : date;
    try {
      await api({action:'addTurno', doc:currentDriver.doc, plate:currentDriver.plate,
        inicio:fmtDT(date,selStartHour), fin:fmtDT(finDate,selEndHour), locality, notes:''});
      n++;
    } catch(e) { console.warn('Error', date, e.message); }
  }
  await loadMyTurnos(); loadDashboard();
  if (n>0) showToast(`[OK] ${n} turno(s) guardados${skipped?` (${skipped} omitidos <12h)`:''}`, 'success');
  else if (skipped>0) showToast(`[Aviso] Todos los días tienen <12h de anticipación.`, 'warning');
  else showToast(`[Aviso] No se guardó ningún turno.`, 'warning');
  hideLoading();
}

async function saveMonthTurnos() {
  const mVal    = document.getElementById('monthMonthDate').value;
  const locality= document.getElementById('monthLocSelect').value;
  if (!mVal||!locality) { showToast('Completa mes y localidad.','warning'); return; }
  if (!selStartHour||!selEndHour) { showToast('Selecciona horario.','warning'); return; }
  const checked = [...document.querySelectorAll('.month-day-cb:checked')].map(cb=>parseInt(cb.value));
  if (!checked.length) { showToast('Selecciona al menos un día.','warning'); return; }

  const [y,m] = mVal.split('-').map(Number);
  const dim   = new Date(y,m,0).getDate();
  showLoading('Guardando mes...');
  let n=0, skipped=0;
  for (let d=1; d<=dim; d++) {
    const dt = new Date(y,m-1,d);
    if (!checked.includes(dt.getDay())) continue;
    const date = ds(dt);
    if (!canAdd(date, selStartHour)) { skipped++; continue; }
    const finDt  = selOvernight ? new Date(dt.getTime()+86400000) : dt;
    const finDate= ds(finDt);
    try {
      await api({action:'addTurno', doc:currentDriver.doc, plate:currentDriver.plate,
        inicio:fmtDT(date,selStartHour), fin:fmtDT(finDate,selEndHour), locality, notes:''});
      n++;
    } catch(e) { console.warn('Error',date,e.message); }
  }
  await loadMyTurnos(); loadDashboard();
  if (n>0) showToast(`[OK] ${n} turno(s) del mes guardados${skipped?` (${skipped} omitidos)`:''}`, 'success');
  else showToast(`[Aviso] ${skipped} días omitidos por <12h de anticipación.`, 'warning');
  hideLoading();
}

// -- Schedule list ----------------------------------
async function loadSchedulePage(tab) {
  if (currentDriver && currentDriver.isAdmin) { renderSchedList(tab); return; }
  showLoading('Cargando turnos...');
  try { await loadMyTurnos(); } catch(e) { showToast('[Error] '+e.message,'error'); }
  hideLoading();
  renderSchedList(tab);
}

function parseTurnoEnd(r) {
  try {
    var d  = parseDate(r.fin);
    var hm = parseHour(r.fin).split(':');
    if (!d || d.length < 10) return new Date(0);
    var dt = new Date(d + 'T00:00:00');
    dt.setHours(parseInt(hm[0])||0, parseInt(hm[1])||0, 0, 0);
    return dt;
  } catch(e) { return new Date(0); }
}

function renderSchedList(tab) {
  const el = document.getElementById('schedList');
  if (currentDriver && currentDriver.isAdmin) {
    el.innerHTML='<div class="empty-state">El administrador no tiene turnos personales.</div>';
    return;
  }
  const now = new Date();
  let rows = tab==='upcoming'
    ? myActive().filter(r=>parseTurnoEnd(r)>=now).sort((a,b)=>a.inicio.localeCompare(b.inicio))
    : myAll().filter(r=>r.estado==='cancelled'||parseTurnoEnd(r)<now).sort((a,b)=>b.inicio.localeCompare(a.inicio));

  if (!rows.length) { el.innerHTML='<div class="empty-state">Sin turnos en esta categoria.</div>'; return; }

  el.innerHTML = rows.map(r => {
    const locked    = !canEditRow(r);
    const cancelled = r.estado==='cancelled';
    const asignado  = r.estado==='asignado';
    const diff      = calcHours(r.inicio, r.fin);
    const overnight = parseDate(r.fin) !== parseDate(r.inicio);
    const timeLabel = parseHour(r.inicio)+' -> '+parseHour(r.fin)+(overnight?' [+1 dia]':'');
    const estadoLabel = r.estado==='active'?'Activo':r.estado==='asignado'?'Confirmado':'Cancelado';
    return '<div class="sched-item'+(cancelled?' cancelled':asignado?' asignado':'')+'">'+
      '<div class="sched-item-id">'+r.id+'</div>'+
      '<div class="sched-item-main">'+
        '<div class="sched-row"><span class="sched-date">'+fmtDateHuman(r.inicio)+'</span></div>'+
        '<div class="sched-row" style="margin-top:3px">'+
          '<span class="sched-time">'+timeLabel+'</span>'+
          '<span class="sched-dur">'+diff+'h</span>'+
          '<span class="estado-badge estado-'+r.estado+'">'+estadoLabel+'</span>'+
        '</div>'+
        '<div class="sched-meta-row">'+
          (r.locality?'<span class="loc-tag">[Loc] '+r.locality+'</span>':'')+
          (r.notes?'<span class="notes-tag">'+r.notes+'</span>':'')+
          (cancelled&&r.motivoCan?'<span class="cancel-reason">Motivo: '+r.motivoCan+'</span>':'')+
        '</div>'+
      '</div>'+
      '<div class="sched-actions">'+
        (!cancelled&&!asignado?
          '<button class="btn-edit-sm'+(locked?' locked':'')+'" onclick="'+(locked?'showToast(\'No se puede modificar: menos de 12 horas.\',\'error\')':'openEditModal('+r.sheetRow+')')+'">Ed</button>'+
          '<button class="btn-cancel-sm'+(locked?' locked':'')+'" onclick="'+(locked?'showToast(\'No se puede modificar: menos de 12 horas.\',\'error\')':'openCancelModal('+r.sheetRow+')')+'">x</button>'
        :asignado?'<span style="font-size:11px;color:var(--success);font-weight:600">Despachado</span>':'')+
      '</div>'+
    '</div>';
  }).join('');
}


// -- Edit modal ------------------------------------─
function openEditModal(sheetRow) {
  const r = allTurnos.find(x=>x.sheetRow===sheetRow);
  if (!r||!canEditRow(r)) { showToast('[Error] No se puede editar.','error'); return; }
  editRowIndex = sheetRow;
  editStartH   = normH(parseHour(r.inicio));
  editEndH     = normH(parseHour(r.fin));
  editOvernight= parseDate(r.fin) !== parseDate(r.inicio);
  document.getElementById('editDate').value     = parseDate(r.inicio);
  document.getElementById('editLocSelect').value= r.locality||'';
  document.getElementById('editNotes2').value   = r.notes||'';
  renderEditPicker();
  document.getElementById('editModal').classList.add('open');
}
function renderEditPicker() {
  const dateVal   = document.getElementById('editDate').value;
  const otherRanges = allTurnos.filter(r=>r.doc===currentDriver.doc&&r.plate===currentDriver.plate&&r.estado==='active'&&turnoStartDate(r)===dateVal&&r.sheetRow!==editRowIndex)
    .map(r=>({s:normH(parseHour(r.inicio)),e:normH(parseHour(r.fin))}));

  document.getElementById('editStartPicker').innerHTML = HOURS.map(h=>{
    const u=isHourUsed(h,otherRanges),sel=h===editStartH;
    return `<button type="button" class="hbtn${sel?' sel':''}${u?' used':''}" ${u?'disabled':''} onclick="ePickStart('${h}')">${h}</button>`;
  }).join('');
  renderEditEnd(otherRanges);
}
function renderEditEnd(usedRanges) {
  const sec = document.getElementById('editEndPickerSection');
  if (!editStartH) { sec.style.display='none'; return; }
  sec.style.display='block';
  document.getElementById('editEndPicker').innerHTML = HOURS.filter(h=>h!==editStartH).map(h=>{
    const isND = h<=editStartH, sel=h===editEndH;
    return `<button type="button" class="hbtn${sel?' sel':''}${isND?' next-day':''}" onclick="ePickEnd('${h}')">${h}${isND?'<span class="nd-tag">+1</span>':''}</button>`;
  }).join('');
  updateEditSum();
}
window.ePickStart = h => { editStartH=h; editEndH=null; editOvernight=false; renderEditPicker(); };
window.ePickEnd   = h => { editEndH=h; editOvernight=h<=editStartH; document.getElementById('editEndPicker').querySelectorAll('.hbtn').forEach(b=>b.classList.toggle('sel',b.textContent.replace('+1','').trim()===h)); updateEditSum(); };
function updateEditSum() {
  const el=document.getElementById('editSummary'); if(!el) return;
  if (editStartH&&editEndH) {
    const diff=calcHoursFromStr(editStartH,editEndH,editOvernight);
    el.innerHTML=`<strong>[OK] ${editStartH} -> ${editEndH}${editOvernight?' (+1)':''}</strong> (${diff}h)${editOvernight?' [Noche]':''}`;
    el.className='add-summary ok';
  } else if (editStartH) { el.textContent=`Inicio: ${editStartH}`; el.className='add-summary partial'; }
  else { el.textContent='Selecciona el horario'; el.className='add-summary empty'; }
}
async function saveEditTurno() {
  const dateVal  = document.getElementById('editDate').value;
  const locality = document.getElementById('editLocSelect').value;
  const notes    = document.getElementById('editNotes2').value.trim();
  if (!locality)           { showToast('Selecciona localidad.','warning'); return; }
  if (!editStartH||!editEndH) { showToast('Selecciona horario completo.','warning'); return; }
  if (!canModify(dateVal, editStartH)) { showToast('[Error] Menos de 12 horas para modificar este turno.','error'); return; }
  const finDate = editOvernight ? ds((() => { const d=new Date(dateVal+'T12:00:00'); d.setDate(d.getDate()+1); return d; })()) : dateVal;
  showLoading('Actualizando...');
  try {
    await api({action:'updateTurno', sheetRow:editRowIndex, inicio:fmtDT(dateVal,editStartH), fin:fmtDT(finDate,editEndH), locality, notes});
    await loadMyTurnos(); closeModal('editModal'); renderSchedList('upcoming'); loadDashboard();
    showToast('[OK] Turno actualizado.','success');
  } catch(e) { showToast('[Error] '+e.message,'error'); }
  hideLoading();
}

// -- Cancel modal ----------------------------------─
function openCancelModal(sheetRow) {
  const r = allTurnos.find(x=>x.sheetRow===sheetRow);
  if (!r||!canEditRow(r)) { showToast('[Error] No se puede cancelar.','error'); return; }
  editRowIndex = sheetRow;
  document.getElementById('cancelReason').value = '';
  document.getElementById('cancelInfo').textContent = `${r.inicio} -> ${r.fin}`;
  document.getElementById('cancelModal').classList.add('open');
}
async function confirmCancel() {
  const motivo = document.getElementById('cancelReason').value.trim();
  showLoading('Cancelando...');
  try {
    await api({action:'cancelTurno', sheetRow:editRowIndex, motivo});
    await loadMyTurnos(); closeModal('cancelModal'); renderSchedList('upcoming'); loadDashboard();
    showToast('Turno cancelado.','warning');
  } catch(e) { showToast('[Error] '+e.message,'error'); }
  hideLoading();
}

// -- CALENDAR (FIXED) ------------------------------─
async function loadMonthlyPage() {
  showLoading('Cargando...');
  try {
    if (currentDriver && currentDriver.isAdmin) {
      var data = await api({action:'getAllTurnos'});
      allTurnos = data.turnos || [];
    } else {
      await loadMyTurnos();
    }
  } catch(e) { showToast('[Error] '+e.message, 'error'); }
  hideLoading();
  renderCalendar();
  renderWeekSummary();
}

function buildDayMap() {
  var sm = {};
  var rows = (currentDriver && currentDriver.isAdmin)
    ? allTurnos.filter(function(r){ return r.estado==='active' || r.estado==='asignado'; })
    : myActive();
  rows.forEach(function(r) {
    var d = turnoStartDate(r);
    if (!sm[d]) sm[d] = [];
    sm[d].push(r);
  });
  return sm;
}

function renderCalendar() {
  var sm    = buildDayMap();
  var isAdm = currentDriver && currentDriver.isAdmin;
  var y=viewMonth.getFullYear(), m=viewMonth.getMonth();
  var MN=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  document.getElementById('monthTitle').textContent   = MN[m]+' '+y;
  document.getElementById('weekSumTitle').textContent = MN[m]+' '+y;
  var grid=document.getElementById('calGrid'), today=ds(new Date());
  grid.innerHTML='';
  var dow=new Date(y,m,1).getDay(); dow=dow===0?6:dow-1;
  for (var i=0;i<dow;i++){ var x=document.createElement('div');x.className='cal-day other';grid.appendChild(x); }
  var dim=new Date(y,m+1,0).getDate();
  for (var d=1;d<=dim;d++) {
    var date=y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    var rows=sm[date]||[];
    var el=document.createElement('div');
    el.className='cal-day'+(date===today?' today':'')+(rows.length?' has-s clickable':'');
    // Click: admin opens consolidado for that day; conductor shows schedule
    (function(dt, hasRows) {
      if (hasRows) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', function() {
          if (isAdm) {
            // Switch to consolidado tab filtered by date
            var tab = document.querySelector('#page-admin .tabs .tab-btn:nth-child(2)');
            switchAdminTab('consolidado', tab);
            var df = document.getElementById('filterConsolidadoDate');
            if (df) { df.value = dt; filterConsolidado(); }
            showPage('admin', document.querySelector('#adminNav .nav-item'));
          }
        });
      }
    })(date, rows.length > 0);

    var num=document.createElement('div'); num.className='cal-day-num'; num.textContent=d; el.appendChild(num);
    if (isAdm) {
      rows.slice(0,4).forEach(function(r){
        var b=document.createElement('div');
        b.className='cal-plate-row'+(r.estado==='asignado'?' cal-plate-desp':'');
        b.textContent=r.plate+(r.estado==='asignado'?' [D]':'');
        el.appendChild(b);
      });
      if (rows.length>4){ var mo=document.createElement('div'); mo.className='cal-more'; mo.textContent='+'+(rows.length-4)+' mas'; el.appendChild(mo); }
      if (rows.length>0){
        var desp=rows.filter(function(r){return r.estado==='asignado';}).length;
        var ct=document.createElement('div'); ct.className='cal-count';
        ct.textContent=rows.length+'t'+(desp?' '+desp+'D':''); el.appendChild(ct);
      }
    } else {
      rows.slice(0,2).forEach(function(r){
        var b=document.createElement('div'); b.className='cal-shift-row';
        var overnight=parseDate(r.fin)!==parseDate(r.inicio);
        b.textContent=parseHour(r.inicio)+'-'+parseHour(r.fin)+(overnight?' +1':'');
        el.appendChild(b);
      });
      if (rows.length>2){ var mo=document.createElement('div'); mo.className='cal-more'; mo.textContent='+'+(rows.length-2); el.appendChild(mo); }
    }
    grid.appendChild(el);
  }
  renderWeekSummary();
}

function changeMonth(dir) { viewMonth.setMonth(viewMonth.getMonth()+dir); loadMonthlyPage(); }

function renderWeekSummary() {
  const sm    = buildDayMap();
  const isAdm = currentDriver && currentDriver.isAdmin;
  const y=viewMonth.getFullYear(), m=viewMonth.getMonth();
  const dim=new Date(y,m+1,0).getDate();
  let dow=new Date(y,m,1).getDay(); dow=dow===0?6:dow-1;
  const weeks=[]; let wk=[];
  for (let p=0;p<dow;p++) wk.push(null);
  for (let d=1;d<=dim;d++) {
    const date=y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    wk.push({d,date,rows:sm[date]||[]});
    if (wk.length===7){weeks.push(wk);wk=[];}
  }
  if (wk.length){while(wk.length<7)wk.push(null);weeks.push(wk);}
  const DN=['Lun','Mar','Mie','Jue','Vie','Sab','Dom'];
  const el = document.getElementById('weekSumGrid');

  if (isAdm) {
    el.innerHTML =
      '<div class="week-band hdr"><div class="band-lbl"></div>'+
      DN.map(function(n){return '<div class="band-dh">'+n+'</div>';}).join('')+
      '</div>'+
      weeks.map(function(wk,wi){
        return '<div class="week-band">'+
          '<div class="band-lbl">Sem '+(wi+1)+'</div>'+
          wk.map(function(day){
            if (!day) return '<div class="band-cell phantom"></div>';
            var rows=day.rows, n=rows.length;
            var desp=rows.filter(function(r){return r.estado==='asignado';}).length;
            var pend=n-desp;
            if (!n) return '<div class="band-cell"></div>';
            return '<div class="band-cell adm-cell" title="'+day.date+'">'+
              '<span class="bc-total">'+n+'</span>'+
              (pend?'<span class="bc-pend">'+pend+'P</span>':'')+
              (desp?'<span class="bc-desp">'+desp+'D</span>':'')+
            '</div>';
          }).join('')+
        '</div>';
      }).join('');
  } else {
    el.innerHTML =
      '<div class="week-band hdr"><div class="band-lbl"></div>'+
      DN.map(function(n){return '<div class="band-dh">'+n+'</div>';}).join('')+
      '</div>'+
      weeks.map(function(wk,wi){
        return '<div class="week-band">'+
          '<div class="band-lbl">Sem '+(wi+1)+'</div>'+
          wk.map(function(day){
            if (!day) return '<div class="band-cell phantom"></div>';
            var n=day.rows.length;
            var totalH=day.rows.reduce(function(a,r){return a+calcHours(r.inicio,r.fin);},0);
            return '<div class="band-cell'+(n?' has-data':'')+'" title="'+day.date+'">'+
              (n?'<span class="bc-n">'+totalH+'h</span><span class="bc-s">'+n+'t</span>':'')+
            '</div>';
          }).join('')+
        '</div>';
      }).join('');
  }
}

// -- Dashboard --------------------------------------
async function loadDashboard() {
  if (!currentDriver) return;
  showLoading('Cargando...');
  try {
    if (currentDriver.isAdmin) {
      var data = await api({action:'getAllTurnos'});
      allTurnos = data.turnos || [];
    } else {
      await loadMyTurnos();
    }
  } catch(e) {}
  hideLoading();

  var now = new Date();
  var mp  = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');

  if (currentDriver.isAdmin) {
    // Dashboard del admin: stats globales del mes
    var active = allTurnos.filter(function(r){ return r.estado==='active'||r.estado==='asignado'; });
    var ms     = active.filter(function(r){ return turnoStartDate(r).startsWith(mp); });
    var totalH = ms.reduce(function(a,r){ return a+calcHours(r.inicio,r.fin); }, 0);
    var desp   = ms.filter(function(r){ return r.estado==='asignado'; }).length;
    document.getElementById('statMonth').textContent = ms.length;
    document.getElementById('statHours').textContent = totalH;
    document.getElementById('statNext').textContent  = desp;
    document.getElementById('statNextDate').textContent = 'despachados este mes';
    // Mini calendario semanal con todas las placas
    var sm = buildDayMap();
    var days = []; for(var i=0;i<7;i++){var d=new Date(now);d.setDate(now.getDate()+i);days.push(d);}
    var html7 = '<div class="week7">';
    days.forEach(function(d){
      var date  = ds(d), rows = sm[date]||[], isT = date===ds(now);
      var totalH2 = rows.reduce(function(a,r){return a+calcHours(r.inicio,r.fin);},0);
      html7 += '<div class="w7-col'+(isT?' today':'')+'">'
        +'<div class="w7-dow">'+d.toLocaleDateString('es-CO',{weekday:'short'}).toUpperCase()+'</div>'
        +'<div class="w7-num">'+d.getDate()+'</div>'
        +'<div class="w7-cell'+(rows.length?' filled':'')+'">'+
        (rows.length?'<strong>'+rows.length+'</strong><small>t</small>':'·')+
        '</div>'
        +(rows[0]?'<div class="w7-loc">'+rows[0].plate+'</div>':'')
        +'</div>';
    });
    html7 += '</div>';
    document.getElementById('dashWeek').innerHTML = html7;
  } else {
    // Dashboard del conductor: sus propios turnos
    var active = myActive();
    var ms     = active.filter(function(r){ return turnoStartDate(r).startsWith(mp); });
    var totalH = ms.reduce(function(a,r){ return a+calcHours(r.inicio,r.fin); }, 0);
    document.getElementById('statMonth').textContent = ms.length;
    document.getElementById('statHours').textContent = totalH;
    var upcoming = active.filter(function(r){ return parseTurnoEnd(r) >= now; })
      .sort(function(a,b){ return a.inicio.localeCompare(b.inicio); });
    if (upcoming.length) {
      document.getElementById('statNext').textContent     = parseHour(upcoming[0].inicio);
      document.getElementById('statNextDate').textContent = fmtDateShort(upcoming[0].inicio)+(upcoming[0].locality?' · '+upcoming[0].locality:'');
    } else {
      document.getElementById('statNext').textContent     = '--';
      document.getElementById('statNextDate').textContent = 'sin programar';
    }
    var sm   = buildDayMap();
    var days = []; for(var i=0;i<7;i++){var d=new Date(now);d.setDate(now.getDate()+i);days.push(d);}
    var html7 = '<div class="week7">';
    days.forEach(function(d){
      var date  = ds(d), rows = sm[date]||[], isT = date===ds(now);
      var totalH2 = rows.reduce(function(a,r){return a+calcHours(r.inicio,r.fin);},0);
      html7 += '<div class="w7-col'+(isT?' today':'')+'">'
        +'<div class="w7-dow">'+d.toLocaleDateString('es-CO',{weekday:'short'}).toUpperCase()+'</div>'
        +'<div class="w7-num">'+d.getDate()+'</div>'
        +'<div class="w7-cell'+(rows.length?' filled':'')+'">'+
        (rows.length?'<strong>'+totalH2+'h</strong><small>'+rows.length+'t</small>':'·')+
        '</div>'
        +(rows[0]?'<div class="w7-loc">'+(rows[0].locality||'').split(' ')[0]+'</div>':'')
        +'</div>';
    });
    html7 += '</div>';
    document.getElementById('dashWeek').innerHTML = html7;
  }
  updateSyncUI();
}

// -- Profile ----------------------------------------
function loadProfileData() {
  if (!currentDriver) return;
  document.getElementById('pName').value =currentDriver.name||'';
  document.getElementById('pPhone').value=currentDriver.phone||'';
  document.getElementById('pDoc').value  =currentDriver.doc||'';
  document.getElementById('pPlate').value=currentDriver.plate||'';
  document.getElementById('pVType').value=currentDriver.vehicleType||'';
  document.getElementById('pVNum').value =currentDriver.vehicleNum||'';
  const pl=document.getElementById('pLocality'); if(pl) pl.value=currentDriver.locality||'';
  const now=new Date(), mp=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const active=myActive(), ms=active.filter(r=>turnoStartDate(r).startsWith(mp));
  const totalH=ms.reduce((a,r)=>a+calcHours(r.inicio,r.fin),0);
  document.getElementById('profileStats').innerHTML=`
    <div class="stat-list">
      <div class="stat-row"><span>Turnos activos totales</span><strong>${active.length}</strong></div>
      <div class="stat-row"><span>Turnos este mes</span><strong>${ms.length}</strong></div>
      <div class="stat-row"><span>Horas este mes</span><strong style="color:var(--blue)">${totalH}h</strong></div>
      <div class="stat-row"><span>Localidad habitual</span><strong>${currentDriver.locality||'--'}</strong></div>
    </div>`;
}
async function saveProfile() {
  if (currentDriver.isAdmin) { showToast('Admin no tiene perfil editable.','warning'); return; }
  showLoading('Guardando...');
  try {
    const upd={action:'saveProfile', rowIndex:currentDriver.rowIndex,
      name:     document.getElementById('pName').value.trim()||currentDriver.name,
      phone:    document.getElementById('pPhone').value.trim(),
      vehicleType:document.getElementById('pVType').value,
      vehicleNum: document.getElementById('pVNum').value.trim(),
      locality:   document.getElementById('pLocality').value};
    await api(upd);
    Object.assign(currentDriver,{name:upd.name,phone:upd.phone,vehicleType:upd.vehicleType,vehicleNum:upd.vehicleNum,locality:upd.locality});
    document.getElementById('sidebarName').textContent    =currentDriver.name;
    document.getElementById('sidebarInitial').textContent =currentDriver.name.charAt(0).toUpperCase();
    document.getElementById('dashName').textContent       =currentDriver.name.split(' ')[0];
    showToast('[OK] Perfil guardado.','success');
  } catch(e) { showToast('[Error] '+e.message,'error'); }
  hideLoading();
}

// -- ADMIN -- vista consolidada por día --------------
async function loadAdminPage() {
  showLoading('Cargando desde Sheets...');
  try {
    const [dRes,tRes] = await Promise.all([api({action:'getAllDrivers'}), api({action:'getAllTurnos'})]);
    driverCache = dRes.drivers||[];
    allTurnos   = tRes.turnos||[];
    renderAdminTable(driverCache);
    showToast(`[OK] ${driverCache.length} conductores, ${allTurnos.filter(r=>r.estado==='active').length} turnos activos.`,'success');
  } catch(e) { showToast('[Error] '+e.message,'error'); }
  hideLoading();
}
function filterDrivers() {
  const q=document.getElementById('searchDriver').value.toLowerCase();
  renderAdminTable(driverCache.filter(d=>d.name.toLowerCase().includes(q)||d.plate.toLowerCase().includes(q)||(d.locality||'').toLowerCase().includes(q)));
}
function renderAdminTable(drivers) {
  var now=new Date(), mp=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  var VN={bus:'Bus',buselec:'Bus Elec.',micro:'Microbus',van:'Van',camion:'Camion',taxi:'Taxi',otro:'Otro','':'--'};
  var tbody = document.getElementById('adminTableBody');
  if (!drivers.length) { tbody.innerHTML='<tr><td colspan="6" class="empty-td">Sin resultados.</td></tr>'; return; }
  tbody.innerHTML = drivers.map(function(d){
    var ms=allTurnos.filter(function(r){return r.doc===d.doc&&r.plate===d.plate&&(r.estado==='active'||r.estado==='asignado')&&turnoStartDate(r).startsWith(mp);});
    var totalH=ms.reduce(function(a,r){return a+calcHours(r.inicio,r.fin);},0);
    var safeDoc   = (d.doc||'').replace(/'/g,"\\'");
    var safePlate = (d.plate||'').replace(/'/g,"\\'");
    var safeName  = (d.name||'').replace(/'/g,"\\'");
    return '<tr class="driver-row" onclick="openDriverTurnos(\'' + safeDoc + '\',\'' + safePlate + '\',\'' + safeName + '\')" style="cursor:pointer" title="Ver turnos">'
      +'<td class="td-name">'+d.name+'</td>'
      +'<td class="mono">'+d.doc+'</td>'
      +'<td><span class="plate-badge">'+d.plate+'</span></td>'
      +'<td>'+(d.locality?'<span class="loc-tag">[Loc] '+d.locality+'</span>':'--')+'</td>'
      +'<td>'+(VN[d.vehicleType]||'--')+(d.vehicleNum?' #'+d.vehicleNum:'')+'</td>'
      +'<td><strong>'+ms.length+'</strong> turnos / <strong style="color:var(--blue)">'+totalH+'h</strong></td>'
      +'</tr>';
  }).join('');
}

// Muestra modal con turnos del conductor seleccionado
function openDriverTurnos(doc, plate, name) {
  var turnos = allTurnos.filter(function(r){ return r.doc===doc && r.plate===plate; })
    .sort(function(a,b){ return b.inicio.localeCompare(a.inicio); });
  var modal = document.getElementById('driverTurnosModal');
  document.getElementById('driverTurnosTitle').textContent = name+' ('+plate+')';
  var now = new Date();
  document.getElementById('driverTurnosList').innerHTML = turnos.length ? turnos.map(function(r){
    var h = calcHours(r.inicio, r.fin);
    var isFut = parseTurnoEnd(r) >= now;
    var estadoLabel = r.estado==='active'?'Activo':r.estado==='asignado'?'Confirmado':'Cancelado';
    return '<div class="dt-row dt-'+r.estado+'">'
      +'<div class="dt-date">'+fmtDateHuman(r.inicio)+'</div>'
      +'<div class="dt-time">'+parseHour(r.inicio)+' -> '+parseHour(r.fin)+' ('+h+'h)'
        +(r.locality?' · '+r.locality:'')+'</div>'
      +'<div class="dt-estado"><span class="estado-badge estado-'+r.estado+'">'+estadoLabel+'</span>'
        +(isFut&&r.estado==='active'?'<button class="btn-desp-sm" onclick="adminCancelTurno('+r.sheetRow+',this.dataset.name)" data-name="'+name.replace(/"/g,"&quot;")+'">Cancelar</button>':'')
      +'</div>'
      +'</div>';
  }).join('') : '<div class="empty-state">Sin turnos registrados.</div>';
  modal.classList.add('open');
}

async function adminCancelTurno(sheetRow, driverNameOrEl) {
  var driverName = (typeof driverNameOrEl === 'string') ? driverNameOrEl : (event && event.target ? event.target.dataset.name : '');
  if (!confirm('Cancelar turno de '+driverName+'?')) return;
  showLoading('Cancelando...');
  try {
    await api({action:'cancelTurno', sheetRow:sheetRow, motivo:'Cancelado por admin'});
    var idx = allTurnos.findIndex(function(r){return r.sheetRow===sheetRow;});
    if (idx!==-1) allTurnos[idx].estado='cancelled';
    showToast('Turno cancelado.','warning');
    // Refresh the modal
    var t = allTurnos.find(function(r){return r.sheetRow===sheetRow;});
    if (t) openDriverTurnos(t.doc, t.plate, driverName);
  } catch(e){ showToast('[Error] '+e.message,'error'); }
  hideLoading();
}

// -- ADMIN -- vista consolidada por día (NUEVA) ------

// ── ASIGNAR turno (despacho admin) ──────────────────────
async function asignarTurno(sheetRow) {
  const r = allTurnos.find(x => x.sheetRow === sheetRow);
  if (!r) return;
  if (r.estado === 'asignado') {
    showToast('Este turno ya fue despachado.', 'warning'); return;
  }
  if (!confirm('Despachar a ' + r.plate + ' (' + parseHour(r.inicio) + ' -> ' + parseHour(r.fin) + ')? Esta accion no se puede deshacer.')) return;
  showLoading('Marcando como despachado...');
  try {
    await api({action: 'asignarTurno', sheetRow: sheetRow});
    // Actualizar localmente
    const idx = allTurnos.findIndex(x => x.sheetRow === sheetRow);
    if (idx !== -1) allTurnos[idx].estado = 'asignado';
    showConsolidado();
    showToast('[OK] Placa ' + r.plate + ' despachada.', 'success');
  } catch(e) { showToast('[Error] ' + e.message, 'error'); }
  hideLoading();
}

// filterConsolidado: aplica filtros de fecha y conductor
function filterConsolidado() {
  showConsolidado();
}
function clearConsolidadoFilter() {
  var df = document.getElementById('filterConsolidadoDate');
  var cf = document.getElementById('filterConsolidadoConductor');
  if (df) df.value = '';
  if (cf) cf.value = '';
  showConsolidado();
}

function showConsolidado() {
  var now    = new Date();
  var mp     = now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
  var dateF  = (document.getElementById('filterConsolidadoDate')||{}).value || '';
  var condF  = ((document.getElementById('filterConsolidadoConductor')||{}).value||'').toLowerCase().trim();

  // Mostrar active Y asignado del mes
  var mesRows = allTurnos.filter(function(r) {
    return (r.estado==='active'||r.estado==='asignado') && turnoStartDate(r).startsWith(mp);
  });

  // Aplicar filtro de fecha
  if (dateF) {
    mesRows = mesRows.filter(function(r){ return turnoStartDate(r)===dateF; });
  }

  // Aplicar filtro de conductor (nombre o placa)
  if (condF) {
    mesRows = mesRows.filter(function(r) {
      var driver = driverCache.find(function(d){ return d.doc===r.doc && d.plate===r.plate; });
      var name   = driver ? driver.name.toLowerCase() : '';
      return name.includes(condF) || r.plate.toLowerCase().includes(condF);
    });
  }

  // Agrupar por fecha
  var byDay = {};
  mesRows.forEach(function(r) {
    var d = turnoStartDate(r);
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(r);
  });

  var sortedDays = Object.keys(byDay).sort();
  var wrap = document.getElementById('consolidadoWrap');

  if (!sortedDays.length) {
    wrap.innerHTML = '<div class="empty-state">Sin turnos'+(dateF?' para el '+dateF:'')+(condF?' de "'+condF+'"':'')+'.</div>';
    document.getElementById('consolidadoCard').style.display = 'block';
    return;
  }

  wrap.innerHTML = sortedDays.map(function(date) {
    var rows = byDay[date];
    rows.sort(function(a,b){ return parseHour(a.inicio).localeCompare(parseHour(b.inicio)); });
    var totalDesp = rows.filter(function(r){return r.estado==='asignado';}).length;
    var totalPend = rows.filter(function(r){return r.estado==='active';}).length;
    var totalH    = rows.reduce(function(a,r){return a+calcHours(r.inicio,r.fin);},0);
    var dLabel    = new Date(date+'T12:00:00').toLocaleDateString('es-CO',{weekday:'long',day:'numeric',month:'long'});
    dLabel = dLabel.charAt(0).toUpperCase()+dLabel.slice(1);

    return '<div class="consol-day">'+
      '<div class="consol-day-header">'+
        '<span class="consol-date">'+dLabel+'</span>'+
        '<span class="consol-stats">'+
          '<span class="consol-badge-pend">'+totalPend+' pendiente(s)</span>'+
          '<span class="consol-badge-desp">'+totalDesp+' despachado(s)</span>'+
          '<span class="consol-total-h">'+totalH+'h total</span>'+
        '</span>'+
      '</div>'+
      '<div class="consol-blocks">'+
        rows.map(function(r) {
          var h        = calcHours(r.inicio, r.fin);
          var overnight= parseDate(r.fin) !== parseDate(r.inicio);
          var driver   = driverCache.find(function(d){return d.doc===r.doc&&d.plate===r.plate;});
          var name     = driver ? driver.name : r.doc;
          var isDesp   = r.estado === 'asignado';
          return '<div class="consol-block'+(isDesp?' desp':'')+'">'+
            '<div class="consol-block-time">'+
              parseHour(r.inicio)+'<br><span>-></span><br>'+parseHour(r.fin)+(overnight?'<span class="nd-tag">+1</span>':'')+
            '</div>'+
            '<div class="consol-block-info">'+
              '<div class="consol-driver-name">'+name+(isDesp?'<span class="desp-tag">Despachado</span>':'')+'</div>'+
              '<div class="consol-block-meta">'+
                '<span class="plate-badge'+(isDesp?' plate-desp':'')+'">'+r.plate+'</span>'+
                (r.locality?'<span class="loc-tag">[Loc] '+r.locality+'</span>':'')+
                '<span class="sched-dur">'+h+'h</span>'+
              '</div>'+
            '</div>'+
            '<div class="consol-block-action">'+
              (isDesp
                ? '<span class="desp-lock">Bloqueado</span>'
                : '<button class="btn-desp" onclick="asignarTurno('+r.sheetRow+')">Despachar</button>'
              )+
            '</div>'+
          '</div>';
        }).join('')+
      '</div>'+
    '</div>';
  }).join('');

  document.getElementById('consolidadoCard').style.display = 'block';
}

function switchAdminTab(tab, btn) {
  document.querySelectorAll('#page-admin .tab-btn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  document.getElementById('adminTabConductores').style.display  = tab==='conductores'?'block':'none';
  document.getElementById('adminTabConsolidado').style.display  = tab==='consolidado'?'block':'none';
  document.getElementById('adminTabSheet').style.display        = 'none';
  if (tab==='consolidado') showConsolidado();
}

function showSheetView() {
  const rows=allTurnos.filter(r=>r.estado==='active').sort((a,b)=>a.inicio.localeCompare(b.inicio));
  document.getElementById('sheetViewWrap').innerHTML=`
    <div class="raw-table-wrap">
      <table class="raw-table">
        <thead><tr><th>ID</th><th>Documento</th><th>Placa</th><th>Inicio</th><th>Fin</th><th>Estado</th><th>FechaCreacion</th><th>Localidad</th></tr></thead>
        <tbody>${rows.map(r=>`<tr>
          <td class="mono small">${r.id}</td><td>${r.doc}</td>
          <td><span class="plate-badge">${r.plate}</span></td>
          <td>${r.inicio}</td><td>${r.fin}</td>
          <td><span class="estado-badge estado-${r.estado}">${r.estado}</span></td>
          <td class="mono small">${r.fechaCreacion}</td>
          <td>${r.locality?`<span class="loc-tag">[Loc] ${r.locality}</span>`:'--'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  document.getElementById('sheetViewCard').style.display='block';
}

function exportCSV() {
  if (!allTurnos.length) { showToast('Carga los datos primero.','warning'); return; }
  const hdrs=['ID','Documento','Placa','Inicio','Fin','Estado','MotivoCancelacion','FechaCreacion','FechaCancelacion','Localidad','Notas'];
  let csv=hdrs.join(',')+'\n';
  allTurnos.forEach(r=>{csv+=`"${r.id}","${r.doc}","${r.plate}","${r.inicio}","${r.fin}","${r.estado}","${r.motivoCan}","${r.fechaCreacion}","${r.fechaCan}","${r.locality}","${r.notes}"\n`;});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  a.download=`specialcar_${ds(new Date())}.csv`; a.click();
  showToast('[OK] CSV exportado.','success');
}

async function syncNow() {
  showLoading('Actualizando...');
  try { await loadMyTurnos(); lastSync=new Date(); updateSyncUI(); showToast('[OK] Datos actualizados.','success'); }
  catch(e) { showToast('[Error] '+e.message,'error'); }
  hideLoading();
}
function updateSyncUI() {
  const t=lastSync?lastSync.toLocaleTimeString('es-CO'):null;
  const b=document.getElementById('dashSyncBadge'), s=document.getElementById('dashSyncTime');
  if(b){b.textContent=t?`v ${t}`:'Pendiente';b.className=`sync-badge ${t?'ok':'pending'}`;}
  if(s) s.textContent=t?`Última actualización: ${t}`:'Sin sincronizar';
}

function closeModal(id){document.getElementById(id).classList.remove('open');}
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.modal-overlay').forEach(o=>{o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open');});});
});
function showLoading(msg){document.getElementById('loadingText').textContent=msg||'Cargando...';document.getElementById('loadingOverlay').classList.add('show');}
function hideLoading(){document.getElementById('loadingOverlay').classList.remove('show');}
function showToast(msg,type='success'){
  const w=document.getElementById('toastWrap'),t=document.createElement('div');
  t.className=`toast ${type}`;t.textContent=msg;w.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transform='translateX(70px)';t.style.transition='all .3s';setTimeout(()=>t.remove(),300);},3500);
}
