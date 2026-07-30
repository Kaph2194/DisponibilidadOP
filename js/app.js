// ── FleetSync v2.1 · app.js ───────────────────────────────────
// Lógica de interfaz. Los datos vienen de Api (js/api.js).

const HOURS = Array.from({length:24},(_,i)=>String(i).padStart(2,'0')+':00');
const DIAS  = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

let ME = null;                 // { session, profile, conductor }
let loginMode = 'driver';

// selección de horas
let nd = { start:null, end:null, dias:new Set() };   // conductor
let ac = { start:null, end:null };                    // analista
// contexto de modales
let ctxAsignar=null, ctxCancelar=null, ctxConductorEdit=null, ctxVehiculoEdit=null, ctxVincularVeh=null;
let ctxAsignarBloqueado=false;
// mapas / charts
let mapUbic=null, markUbic=null, mapHeat=null, heatLayer=null, zoneMarkers=[];
let chFranjas=null, chZonas=null;
let heatMode='disp', lastReporte=null;
// caches
let cacheConductores=[], cacheVehiculos=[], cacheVinculos=[], misVehs=[];

// ══════════ Helpers ══════════
const $ = id => document.getElementById(id);
const hoyISO = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };

function toast(msg, isErr){
  const t=$('toast'); t.textContent=msg; t.className=isErr?'err':''; t.style.display='block';
  clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none', 4200);
}
function parseFechaLocal(v){
  // "2026-07-30" → medianoche LOCAL (no UTC). Timestamps completos pasan tal cual.
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(v + 'T12:00:00');
  return new Date(v);
}
function fmtFecha(iso){
  const d=parseFechaLocal(iso);
  return DIAS[d.getDay()]+' '+d.getDate()+'/'+String(d.getMonth()+1).padStart(2,'0');
}
function fmtHora(iso){
  const d=new Date(iso);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function fmtRango(r){ return fmtFecha(r.inicio)+' · '+fmtHora(r.inicio)+' → '+fmtHora(r.fin); }
function horasEntre(a,b){ return Math.round((new Date(b)-new Date(a))/36e5*10)/10; }
function estadoBadge(r){
  if (r.asignacion_id) return '<span class="badge b-asignada">Asignada</span>';
  const m={pendiente:'b-pendiente',validada:'b-validada',rechazada:'b-rechazada',cancelada:'b-cancelada'};
  return `<span class="badge ${m[r.estado]||'b-pendiente'}">${r.estado}</span>`;
}
// Alerta de documentos: devuelve {nivel:'ok'|'warn'|'block', texto, detalle}
function docAlerta(r){
  const crit = r.docs_criticos_pendientes||0;
  const critVenc = r.docs_criticos_vencidos||0;
  if (crit>0){
    return { nivel:'block',
      texto: critVenc>0 ? `⛔ ${critVenc} doc. crítico(s) vencido(s)` : `⛔ ${crit} doc. crítico(s) sin cargar`,
      detalle: r.detalle_criticos||'' };
  }
  const otros = (r.docs_vencidos||0)+(r.docs_sin_cargar||0);
  if (otros>0) return { nivel:'warn', texto:`⚠ ${otros} doc. administrativo(s) pendiente(s)`, detalle:'' };
  return { nivel:'ok', texto:'✓ Documentos al día', detalle:'' };
}
function docBadge(r){
  const a=docAlerta(r);
  const cls = a.nivel==='block'?'b-cancelada':(a.nivel==='warn'?'b-pendiente':'b-validada');
  return `<span class="badge ${cls}" title="${a.detalle}">${a.texto}</span>`;
}
function carteraAlerta(r){
  const p = r.cartera_periodos_vencidos||0;
  const v = r.cartera_valor_vencido||0;
  if (p>0) return { hay:true, texto:`💳 Cartera: ${p} período(s) vencido(s) · $${Number(v).toLocaleString('es-CO')}` };
  return { hay:false, texto:'' };
}
function tsLocal(fecha, hhmm){ return new Date(fecha+'T'+hhmm+':00').toISOString(); }
function rangoDia(fecha){
  const a=new Date(fecha+'T00:00:00');
  return [a.toISOString(), new Date(a.getTime()+864e5).toISOString()];
}
const puedeGestionarFlota = () => ['coordinador','jefe','admin'].includes(ME.profile.role);
const puedeGestionarPersonas = () => ['coordinador','jefe','analista','admin'].includes(ME.profile.role);

// ══════════ Pico y placa (servicio transporte especial Bogotá) ══════════
// Rotación de parejas de dígitos, avanza 1 paso por día hábil (lun-sáb).
// Domingos y festivos NO aplica. Horario 5:30am–9:00pm.
// Ancla verificada: jueves 30/07/2026 → restringe 7 y 8.
const PYP_PARES = [[1,2],[3,4],[5,6],[7,8],[9,0]];
// Festivos Colombia 2026 (fechas sin restricción)
const FESTIVOS_2026 = new Set([
  '2026-01-01','2026-01-12','2026-03-23','2026-04-02','2026-04-03','2026-05-01',
  '2026-05-18','2026-06-08','2026-06-15','2026-06-29','2026-07-20','2026-08-07',
  '2026-08-17','2026-10-12','2026-11-02','2026-11-16','2026-12-08','2026-12-25'
]);
function isoLocal(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function esDomingoOFestivo(d){
  return d.getDay()===0 || FESTIVOS_2026.has(isoLocal(d));
}
// Cuenta días hábiles (lun-sáb, sin festivos) entre dos fechas (puede ser negativo)
function diasHabilesEntre(desde, hasta){
  let c=0; const paso = hasta>=desde?1:-1;
  const a=new Date(desde), b=new Date(hasta);
  a.setHours(12,0,0,0); b.setHours(12,0,0,0);
  while(a.getTime()!==b.getTime()){
    a.setDate(a.getDate()+paso);
    if(!esDomingoOFestivo(a)) c+=paso;
  }
  return c;
}
function picoYPlacaDe(fecha){
  const d = parseFechaLocal(fecha); d.setHours(12,0,0,0);
  if (esDomingoOFestivo(d)) return { aplica:false, digitos:[], texto:'No aplica (domingo/festivo)' };
  const ancla = new Date('2026-07-30T12:00:00'); // jueves → índice 3 (7,8)
  const idxAncla = 3;
  const n = diasHabilesEntre(ancla, d);
  let idx = ((idxAncla + n) % 5 + 5) % 5;
  const par = PYP_PARES[idx];
  return { aplica:true, digitos:par, texto:`Restringe placas terminadas en ${par[0]} y ${par[1]}` };
}
function placaRestringida(placa, fecha){
  const pp = picoYPlacaDe(fecha);
  if (!pp.aplica) return false;
  const m = String(placa).trim().match(/(\d)\D*$/); // último dígito
  if (!m) return false;
  return pp.digitos.includes(parseInt(m[1],10));
}

// ══════════ Navegación por rol ══════════
const NAV = {
  conductor: [
    ['p-c-inicio','🏠','Inicio'],
    ['p-c-nueva','➕','Disponibilidad'],
    ['p-c-turnos','📋','Mis turnos'],
    ['p-c-ubic','📍','Ubicación'],
    ['p-c-perfil','👤','Perfil']
  ],
  analista: [
    ['p-a-validar','✅','Validación'],
    ['p-a-crear','➕','Crear disponibilidad'],
    ['p-s-flota','🚗','Flota']
  ],
  coordinador: [
    ['p-o-programar','🗓','Programación'],
    ['p-a-validar','✅','Validación'],
    ['p-s-flota','🚗','Flota']
  ],
  jefe: [
    ['p-j-reportes','📊','Reportería'],
    ['p-o-programar','🗓','Programación'],
    ['p-s-flota','🚗','Flota'],
    ['p-j-equipo','👥','Equipo']
  ],
  admin: [
    ['p-j-reportes','📊','Reportería'],
    ['p-o-programar','🗓','Programación'],
    ['p-s-flota','🚗','Flota'],
    ['p-ad-datos','🗄','Base de datos'],
    ['p-ad-cartera','💳','Cartera'],
    ['p-ad-consolidado','📋','Consolidado'],
    ['p-j-equipo','👥','Equipo']
  ]
};

const PAGE_LOADERS = {
  'p-c-inicio':  () => UI.loadConductorData(),
  'p-c-turnos':  () => UI.loadConductorData(),
  'p-c-ubic':    () => UI.initMiUbicacion(),
  'p-a-validar': () => UI.loadValidacion(),
  'p-a-crear':   () => UI.loadCrearAnalista(),
  'p-s-flota':   () => UI.loadFlota(),
  'p-o-programar': () => UI.loadProgramacion(),
  'p-j-reportes':  () => UI.loadReportes(),
  'p-j-equipo':    () => UI.loadEquipo(),
  'p-ad-datos':    () => UI.loadAdminDatos(),
  'p-ad-cartera':  () => UI.loadCartera(),
  'p-ad-consolidado': () => UI.loadConsolidado()
};

function buildNav(role){
  const items = NAV[role]||[];
  $('sideNav').innerHTML = items.map(([id,ic,lbl],i)=>
    `<button class="nav-item ${i===0?'on':''}" data-p="${id}" onclick="UI.go('${id}',this)"><span class="ic">${ic}</span> ${lbl}</button>`).join('');
  $('mobNav').innerHTML = items.map(([id,ic,lbl],i)=>
    `<button class="${i===0?'on':''}" data-p="${id}" onclick="UI.go('${id}',this)"><span class="ic">${ic}</span>${lbl}</button>`).join('');
}

// ══════════ UI ══════════
const UI = {

  // ── Login / sesión ──
  loginTab(mode){
    loginMode=mode;
    $('tabDriver').classList.toggle('on', mode==='driver');
    $('tabStaff').classList.toggle('on', mode==='staff');
    $('formDriver').style.display = mode==='driver'?'':'none';
    $('formStaff').style.display  = mode==='staff'?'':'none';
    $('loginErr').style.display='none';
  },

  async doLogin(){
    const btn=$('btnLogin'), err=$('loginErr');
    err.style.display='none';
    btn.disabled=true; btn.innerHTML='<span class="spin"></span>Entrando…';
    let r;
    if (loginMode==='driver'){
      const plate=$('lgPlate').value.trim(), doc=$('lgDoc').value.trim();
      r = (!plate||!doc) ? {ok:false,error:'Ingresa placa y documento.'} : await Api.loginConductor(plate,doc);
    } else {
      const em=$('lgEmail').value.trim(), pw=$('lgPass').value;
      r = (!em||!pw) ? {ok:false,error:'Ingresa email y contraseña.'} : await Api.loginStaff(em,pw);
    }
    btn.disabled=false; btn.textContent='Entrar';
    if (!r.ok){ err.textContent=r.error; err.style.display='block'; return; }
    await UI.enterApp();
  },

  async logout(){ await Api.logout(); location.reload(); },

  async enterApp(){
    ME = await Api.getMe();
    if (!ME){ toast('No se pudo cargar tu perfil', true); return; }
    const role = ME.profile.role;
    $('loginScreen').style.display='none';
    $('appScreen').style.display='block';
    $('sideName').textContent = ME.conductor?.nombre || ME.profile.full_name || ME.session.user.email;
    $('sideRole').textContent = ROLE_LABELS[role]||role;
    $('sidePlaca').innerHTML  = '';
    buildNav(role);

    const opts = LOCALIDADES.map(l=>`<option>${l}</option>`).join('');
    ['ndLoc','pfLoc','acLoc','mcLoc','mvLoc','mAsigZona'].forEach(id=>{ if($(id)) $(id).innerHTML=opts; });
    ['ndFecha','acFecha','prFecha'].forEach(id=>{ if($(id)) $(id).value=hoyISO(); });
    if ($('rpDesde')){ $('rpDesde').value=hoyISO(); const h=new Date(); h.setDate(h.getDate()+7); $('rpHasta').value=h.toISOString().slice(0,10); }
    if ($('avDesde')){ $('avDesde').value=hoyISO(); const h=new Date(); h.setDate(h.getDate()+14); $('avHasta').value=h.toISOString().slice(0,10); }

    buildHourRail('ndHoras', nd, ()=>ndResumen());
    buildHourRail('acHoras', ac, ()=>acResumen());
    $('ndFecha').addEventListener('change', buildDiasRail);
    buildDiasRail();

    // Conductor: cargar sus vehículos y perfil
    if (role==='conductor' && ME.conductor){
      misVehs = await Api.misVehiculos(ME.conductor.id);
      const vopts = misVehs.map(v=>`<option value="${v.vehiculo_id}">${v.placa}${v.tipo_vehiculo?' · '+v.tipo_vehiculo:''}${v.numero_interno?' · '+v.numero_interno:''}</option>`).join('');
      $('ndVehiculo').innerHTML = vopts || '<option value="">— Sin vehículos vinculados —</option>';
      $('ubVehiculo').innerHTML = vopts || '<option value="">— Sin vehículos vinculados —</option>';
      if (misVehs.length===1) $('sidePlaca').innerHTML = `<span class="placa sm">${misVehs[0].placa}</span>`;
      $('pfNombre').value=ME.conductor.nombre||''; $('pfTel').value=ME.conductor.telefono||'';
      $('pfLoc').value=ME.conductor.localidad||LOCALIDADES[0];
    }

    UI.go(NAV[role][0][0], null);

    // Recordatorio de cargue diario (para admin/jefe)
    if (['admin','jefe'].includes(role)) UI.chequearRecordatorioCargue();
  },

  async chequearRecordatorioCargue(){
    try {
      const cfg = await Api.getConfig();
      if (cfg.recordatorio_cargue_activo !== 'true') return;
      const ultimo = await Api.ultimoCargue();
      const cargadoHoy = ultimo && new Date(ultimo.created_at).toDateString() === new Date().toDateString();
      if (cargadoHoy) return;
      // ¿Ya pasó la hora del recordatorio hoy?
      const [hh,mm] = (cfg.recordatorio_cargue_hora||'07:00').split(':').map(Number);
      const ahora = new Date();
      const horaRec = new Date(); horaRec.setHours(hh, mm, 0, 0);
      if (ahora >= horaRec){
        const portal = cfg.portal_url;
        toast('⏰ Recordatorio: falta el cargue de la base de conductores de hoy', false);
        // Aviso persistente clickeable
        setTimeout(()=>{
          const t=$('toast');
          t.style.display='block'; t.className='';
          t.innerHTML = `⏰ Falta el cargue de hoy. <a href="#" onclick="UI.go('p-ad-datos');document.getElementById('toast').style.display='none';return false" style="color:var(--amber);text-decoration:underline">Ir a cargar →</a>`;
          clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none', 9000);
        }, 3500);
      }
    } catch(e){ /* silencioso */ }
  },

  go(pageId, btn){
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
    $(pageId).classList.add('on');
    document.querySelectorAll('[data-p]').forEach(b=>b.classList.toggle('on', b.dataset.p===pageId));
    (PAGE_LOADERS[pageId]||(()=>{}))();
    window.scrollTo({top:0});
  },

  cerrarModal(id){ $(id).classList.remove('on'); },

  // ══════════ CONDUCTOR ══════════
  async loadConductorData(){
    if (!ME.conductor){ toast('Tu usuario no está vinculado a un conductor', true); return; }
    const turnos = await Api.misDisponibilidades(ME.conductor.id);
    $('cHola').textContent = 'Hola, '+(ME.conductor.nombre.split(' ')[0]||'');

    const ahora=new Date(), mes=ahora.getMonth(), anio=ahora.getFullYear();
    const activos = turnos.filter(t=>t.estado!=='cancelada' && t.estado!=='rechazada');
    const delMes  = activos.filter(t=>{ const d=new Date(t.inicio); return d.getMonth()===mes && d.getFullYear()===anio; });
    const prox    = activos.filter(t=>new Date(t.inicio)>ahora).sort((a,b)=>new Date(a.inicio)-new Date(b.inicio));

    $('cKpiMes').textContent = delMes.length;
    $('cKpiHoras').textContent = Math.round(delMes.reduce((s,t)=>s+horasEntre(t.inicio,t.fin),0))+' h';
    $('cKpiProx').textContent = prox.length ? fmtFecha(prox[0].inicio) : '—';

    $('cProximos').innerHTML = prox.length ? prox.slice(0,6).map(t=>{
      const al=docAlerta(t);
      return `<div class="item"><div class="info">
        <div class="t1"><span class="placa sm">${t.placa}</span> &nbsp;${fmtRango(t)}</div>
        <div class="t2">${t.localidad||'Sin localidad'}${t.asignacion_id?` · Servicio: ${t.servicio||'—'} (${t.zona||''})`:''}</div>
        ${al.nivel==='block'?`<div class="t2" style="color:var(--red);margin-top:4px">⛔ Tu vehículo tiene documentos pendientes: ${al.detalle||''}. Repórtalo a operaciones.</div>`:''}
      </div>${estadoBadge(t)}</div>`;
    }).join('')
      : '<div class="empty">No tienes turnos próximos. Sube tu disponibilidad para que te programen.</div>';

    $('cTurnosList').innerHTML = turnos.length ? turnos.map(t=>{
      const puedeCancelar = t.estado!=='cancelada' && t.estado!=='rechazada' && new Date(t.inicio)>new Date();
      return `<div class="item"><div class="info">
        <div class="t1"><span class="placa sm">${t.placa}</span> &nbsp;${fmtRango(t)} <span style="color:var(--faint)">· ${horasEntre(t.inicio,t.fin)} h</span></div>
        <div class="t2">${t.localidad||''}${t.notas?' · '+t.notas:''}${t.estado==='cancelada'&&t.motivo_cancelacion?' · Motivo: '+t.motivo_cancelacion:''}</div>
      </div>
      <div class="acts">${estadoBadge(t)}
        ${puedeCancelar?`<button class="btn btn-red-o sm" onclick="UI.abrirCancelar('${t.id}','${t.placa} · ${fmtRango(t)}')">Cancelar</button>`:''}
      </div></div>`;
    }).join('') : '<div class="empty">Aún no has registrado disponibilidades.</div>';
  },

  async guardarDisponibilidad(){
    if (!ME.conductor) return toast('Usuario sin conductor vinculado', true);
    const vehId=$('ndVehiculo').value;
    if (!vehId) return toast('No tienes vehículos vinculados. Pide al coordinador que te vincule.', true);
    if (nd.start===null || nd.end===null) return toast('Selecciona la franja horaria', true);
    const dias=[...nd.dias]; if(!dias.length) return toast('Selecciona al menos un día', true);
    if (!$('ndLoc').value) return toast('Selecciona la localidad', true);

    const rows = dias.map(f=>{
      let finDia=f;
      if (nd.end<=nd.start){ const d=new Date(f+'T00:00:00'); d.setDate(d.getDate()+1); finDia=d.toISOString().slice(0,10); }
      return { conductor_id:ME.conductor.id, vehiculo_id:vehId,
               inicio:tsLocal(f,HOURS[nd.start]), fin:tsLocal(finDia,HOURS[nd.end]),
               localidad:$('ndLoc').value, notas:$('ndNotas').value.trim() };
    });
    const { error } = await Api.crearDisponibilidades(rows);
    if (error) return toast(Api.friendly(error), true);
    toast(rows.length+' disponibilidad(es) guardada(s) ✓');
    nd={start:null,end:null,dias:new Set()}; $('ndNotas').value='';
    buildHourRail('ndHoras',nd,()=>ndResumen()); buildDiasRail(); ndResumen();
  },

  abrirCancelar(id, txt){ ctxCancelar=id; $('mCanInfo').textContent=txt; $('mCanMotivo').value=''; $('mCancelar').classList.add('on'); },
  async confirmarCancelacion(){
    const { error } = await Api.cancelarDisponibilidad(ctxCancelar, $('mCanMotivo').value.trim());
    UI.cerrarModal('mCancelar');
    if (error) return toast(Api.friendly(error), true);
    toast('Turno cancelado');
    UI.loadConductorData(); if($('p-a-validar').classList.contains('on')) UI.loadValidacion();
  },

  // ── Ubicación (conductor) ──
  async initMiUbicacion(){
    if (!mapUbic){
      mapUbic = L.map('mapaMiUbic').setView([4.65,-74.1], 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        {attribution:'© OpenStreetMap · © CARTO', maxZoom:19}).addTo(mapUbic);
    }
    setTimeout(()=>mapUbic.invalidateSize(), 150);
    const u = await Api.miUltimaUbicacion(ME.conductor.id);
    if (u){
      UI._pintarMiUbic(u.lat,u.lng);
      $('ubicUltima').textContent = 'Última reportada: '+new Date(u.reportada_at).toLocaleString('es-CO');
    } else $('ubicUltima').textContent='Aún no has reportado ubicación.';
  },
  _pintarMiUbic(lat,lng){
    if (markUbic) markUbic.remove();
    markUbic = L.circleMarker([lat,lng],{radius:10,color:'#FFB020',fillColor:'#FFB020',fillOpacity:.85}).addTo(mapUbic);
    mapUbic.setView([lat,lng], 14);
  },
  reportarUbicacion(){
    const st=$('ubicStatus');
    const vehId=$('ubVehiculo').value;
    if (!vehId) return toast('No tienes vehículos vinculados.', true);
    if (!navigator.geolocation){ st.textContent='Tu navegador no soporta GPS.'; return; }
    st.innerHTML='<span class="spin"></span>Obteniendo GPS…';
    navigator.geolocation.getCurrentPosition(async pos=>{
      const {latitude:lat, longitude:lng, accuracy}=pos.coords;
      const { error } = await Api.reportarUbicacion(ME.conductor.id, vehId, lat, lng, accuracy);
      if (error){ st.textContent=''; return toast(Api.friendly(error), true); }
      st.textContent=''; toast('Ubicación reportada ✓');
      UI._pintarMiUbic(lat,lng);
      $('ubicUltima').textContent='Última reportada: '+new Date().toLocaleString('es-CO');
    }, err=>{ st.textContent=''; toast('No se pudo obtener el GPS: '+err.message, true); },
    { enableHighAccuracy:true, timeout:12000 });
  },

  // ── Perfil (conductor) ──
  async guardarPerfil(){
    const { error } = await Api.updatePerfilConductor(ME.conductor.id, {
      nombre:$('pfNombre').value.trim(), telefono:$('pfTel').value.trim(),
      localidad:$('pfLoc').value
    });
    if (error) return toast(Api.friendly(error), true);
    toast('Perfil actualizado ✓'); ME = await Api.getMe();
    $('sideName').textContent = ME.conductor?.nombre||'';
  },

  // ══════════ ANALISTA ══════════
  async loadValidacion(){
    const [d1] = rangoDia($('avDesde').value||hoyISO());
    const [,d2] = rangoDia($('avHasta').value||hoyISO());
    let rows = await Api.disponibilidadesRango(d1,d2);
    const filtro = $('avEstado').value;
    if (filtro) rows = rows.filter(r=>r.estado===filtro);
    const soyValidador = ['analista','coordinador'].includes(ME.profile.role);
    $('avList').innerHTML = rows.length ? rows.map(r=>`
      <div class="item"><div class="info">
        <div class="t1"><span class="placa sm">${r.placa}</span> &nbsp;${r.conductor_nombre}</div>
        <div class="t2">${fmtRango(r)} · ${r.localidad||'—'} · ${r.tipo_vehiculo||''} ${r.numero_interno||''}${r.notas?' · '+r.notas:''}</div>
        <div style="margin-top:6px">${docBadge(r)}</div>
      </div>
      <div class="acts">${estadoBadge(r)}
        ${soyValidador && r.estado==='pendiente' ? `
          <button class="btn btn-green sm" onclick="UI.validar('${r.id}','validada')">Validar</button>
          <button class="btn btn-red-o sm" onclick="UI.validar('${r.id}','rechazada')">Rechazar</button>`:''}
      </div></div>`).join('')
      : '<div class="empty">No hay disponibilidades con ese filtro.</div>';
  },

  async validar(id, estado){
    const { error } = await Api.cambiarEstadoDisponibilidad(id, estado);
    if (error) return toast(Api.friendly(error), true);
    toast(estado==='validada'?'Disponibilidad validada ✓':'Disponibilidad rechazada');
    UI.loadValidacion();
  },

  async loadCrearAnalista(){
    cacheConductores = await Api.listConductores();
    $('acConductor').innerHTML = cacheConductores.filter(c=>c.activo)
      .map(c=>`<option value="${c.id}">${c.nombre} — CC ${c.documento}</option>`).join('');
    await UI.acCargarVehiculos();
  },

  async acCargarVehiculos(){
    const cid=$('acConductor').value;
    if (!cid){ $('acVehiculo').innerHTML=''; return; }
    const vehs = await Api.misVehiculos(cid);
    $('acVehiculo').innerHTML = vehs.length
      ? vehs.map(v=>`<option value="${v.vehiculo_id}">${v.placa}${v.tipo_vehiculo?' · '+v.tipo_vehiculo:''}</option>`).join('')
      : '<option value="">— Este conductor no tiene vehículos vinculados —</option>';
  },

  async crearDispAnalista(){
    if (ac.start===null || ac.end===null) return toast('Selecciona la franja horaria', true);
    const f=$('acFecha').value; if(!f) return toast('Selecciona la fecha', true);
    const vehId=$('acVehiculo').value;
    if (!vehId) return toast('El conductor no tiene vehículos vinculados. Pide al coordinador o jefe que lo vincule.', true);
    let finDia=f;
    if (ac.end<=ac.start){ const d=new Date(f+'T00:00:00'); d.setDate(d.getDate()+1); finDia=d.toISOString().slice(0,10); }
    const { error } = await Api.crearDisponibilidades([{
      conductor_id: $('acConductor').value, vehiculo_id: vehId,
      inicio: tsLocal(f,HOURS[ac.start]), fin: tsLocal(finDia,HOURS[ac.end]),
      localidad: $('acLoc').value, notas: $('acNotas').value.trim(),
      estado: 'validada'
    }]);
    if (error) return toast(Api.friendly(error), true);
    toast('Disponibilidad creada y validada ✓');
    ac={start:null,end:null}; buildHourRail('acHoras',ac,()=>acResumen()); acResumen(); $('acNotas').value='';
  },

  // ══════════ STAFF: Flota (vehículos + conductores + vínculos) ══════════
  async loadFlota(){
    [cacheVehiculos, cacheConductores, cacheVinculos] = await Promise.all([
      Api.listVehiculos(), Api.listConductores(), Api.listVinculos()
    ]);
    const gestFlota = puedeGestionarFlota();          // coordinador y jefe
    const gestPers  = puedeGestionarPersonas();       // + analista
    $('btnNuevoVeh').style.display  = gestFlota?'':'none';
    $('btnNuevoCond').style.display = gestPers?'':'none';

    // Vehículos
    $('tblVehiculos').querySelector('tbody').innerHTML = cacheVehiculos.map(v=>{
      const links = cacheVinculos.filter(x=>x.vehiculo_id===v.id);
      const chips = links.map(x=>`<span class="chip">${x.conductor_nombre}${gestFlota?`<button title="Desvincular" onclick="UI.desvincular('${x.id}','${x.conductor_nombre}','${v.placa}')">✕</button>`:''}</span>`).join('') || '<span style="color:var(--faint)">Sin conductores</span>';
      return `<tr style="${v.activo?'':'opacity:.45'}">
        <td><span class="placa sm">${v.placa}</span></td>
        <td>${v.tipo_vehiculo||'—'}</td><td>${v.numero_interno||'—'}</td><td>${v.localidad||'—'}</td>
        <td>${chips}</td>
        <td style="white-space:nowrap">${gestFlota?`
          <button class="btn btn-ghost sm" onclick="UI.abrirVincular('${v.id}','${v.placa}')">＋ Conductor</button>
          <button class="btn btn-ghost sm" onclick="UI.abrirVehiculoModal('${v.id}')">Editar</button>`:''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--faint)">Sin vehículos registrados.</td></tr>';

    // Conductores
    $('tblConductores').querySelector('tbody').innerHTML = cacheConductores.map(c=>{
      const vehs = cacheVinculos.filter(x=>x.conductor_id===c.id)
        .map(x=>`<span class="placa sm" style="margin:2px 3px 2px 0">${x.placa}</span>`).join('') || '<span style="color:var(--faint)">Ninguno</span>';
      return `<tr style="${c.activo?'':'opacity:.45'}">
        <td>${c.nombre}</td><td>${c.documento}</td><td>${c.telefono||'—'}</td><td>${c.localidad||'—'}</td>
        <td>${vehs}</td>
        <td>${gestPers?`<button class="btn btn-ghost sm" onclick="UI.abrirConductorModal('${c.id}')">Editar</button>`:''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--faint)">Sin conductores registrados.</td></tr>';
  },

  // — Modal vehículo —
  abrirVehiculoModal(id){
    ctxVehiculoEdit = id||null;
    const v = id ? cacheVehiculos.find(x=>x.id===id) : null;
    $('mVehTitle').textContent = v ? 'Editar vehículo' : 'Nuevo vehículo';
    $('mvPlaca').value=v?.placa||''; $('mvTipo').value=v?.tipo_vehiculo||'';
    $('mvNum').value=v?.numero_interno||''; $('mvLoc').value=v?.localidad||LOCALIDADES[0];
    $('mVehiculo').classList.add('on');
  },
  async guardarVehiculoModal(){
    const v = {
      placa:$('mvPlaca').value.trim().toUpperCase(), tipo_vehiculo:$('mvTipo').value.trim(),
      numero_interno:$('mvNum').value.trim(), localidad:$('mvLoc').value
    };
    if (!v.placa) return toast('La placa es obligatoria', true);
    if (ctxVehiculoEdit) v.id=ctxVehiculoEdit;
    const { error } = await Api.saveVehiculo(v);
    if (error) return toast(Api.friendly(error), true);
    UI.cerrarModal('mVehiculo'); toast('Vehículo guardado ✓'); UI.loadFlota();
  },

  // — Modal conductor (persona) —
  abrirConductorModal(id){
    ctxConductorEdit = id||null;
    const c = id ? cacheConductores.find(x=>x.id===id) : null;
    $('mCondTitle').textContent = c ? 'Editar conductor' : 'Nuevo conductor';
    $('mcNombre').value=c?.nombre||''; $('mcDoc').value=c?.documento||'';
    $('mcTel').value=c?.telefono||''; $('mcLoc').value=c?.localidad||LOCALIDADES[0];
    // Al crear: exigir placa. Al editar: no se toca el vínculo aquí.
    if (id){
      $('mcVehiculoWrap').style.display='none';
    } else {
      $('mcVehiculoWrap').style.display='block';
      const vopts = cacheVehiculos.filter(v=>v.activo)
        .map(v=>`<option value="${v.id}">${v.placa}${v.tipo_vehiculo?' · '+v.tipo_vehiculo:''}</option>`).join('');
      $('mcVehiculo').innerHTML = vopts || '<option value="">— Primero crea un vehículo —</option>';
    }
    $('mConductor').classList.add('on');
  },
  async guardarConductorModal(){
    const c = {
      nombre:$('mcNombre').value.trim(), documento:$('mcDoc').value.trim(),
      telefono:$('mcTel').value.trim(), localidad:$('mcLoc').value
    };
    if (!c.nombre||!c.documento) return toast('Nombre y documento son obligatorios', true);

    if (ctxConductorEdit){
      c.id=ctxConductorEdit;
      const { error } = await Api.saveConductor(c);
      if (error) return toast(Api.friendly(error), true);
      UI.cerrarModal('mConductor'); toast('Conductor guardado ✓'); UI.loadFlota();
      return;
    }

    // Crear: la placa es obligatoria
    const vehId = $('mcVehiculo').value;
    if (!vehId) return toast('Debes seleccionar un vehículo/placa. Si no hay, crea primero un vehículo.', true);

    const { data: nuevo, error } = await Api.saveConductorReturn(c);
    if (error) return toast(Api.friendly(error), true);
    // Vincular a la placa
    const { error: e2 } = await Api.vincular(nuevo.id, vehId);
    if (e2){ toast('Conductor creado, pero no se pudo vincular: '+Api.friendly(e2), true); }
    else toast('Conductor creado y vinculado ✓');
    UI.cerrarModal('mConductor'); UI.loadFlota();
  },

  // — Vínculos —
  abrirVincular(vehId, placa){
    ctxVincularVeh = vehId;
    $('mViInfo').innerHTML = `Vehículo: <span class="placa sm">${placa}</span>`;
    const yaVinculados = new Set(cacheVinculos.filter(x=>x.vehiculo_id===vehId).map(x=>x.conductor_id));
    const libres = cacheConductores.filter(c=>c.activo && !yaVinculados.has(c.id));
    $('mViConductor').innerHTML = libres.length
      ? libres.map(c=>`<option value="${c.id}">${c.nombre} — CC ${c.documento}</option>`).join('')
      : '<option value="">— Todos los conductores ya están vinculados —</option>';
    $('mVincular').classList.add('on');
  },
  async confirmarVinculo(){
    const cid=$('mViConductor').value;
    if (!cid) return toast('No hay conductor para vincular', true);
    const { error } = await Api.vincular(cid, ctxVincularVeh);
    if (error) return toast(Api.friendly(error), true);
    UI.cerrarModal('mVincular'); toast('Conductor vinculado ✓'); UI.loadFlota();
  },
  async desvincular(vinculoId, nombre, placa){
    if (!confirm(`¿Quitar a ${nombre} del vehículo ${placa}? Sus disponibilidades ya creadas no se borran.`)) return;
    const { error } = await Api.desvincular(vinculoId);
    if (error) return toast(Api.friendly(error), true);
    toast('Vínculo eliminado'); UI.loadFlota();
  },

  // ══════════ COORDINADOR: Programación ══════════
  async loadProgramacion(){
    const fechaSel = $('prFecha').value||hoyISO();
    // Banner pico y placa
    const pp = picoYPlacaDe(fechaSel);
    const banner=$('pypBanner');
    if (pp.aplica){
      banner.style.borderLeftColor='var(--amber)';
      banner.innerHTML=`<div><div style="font-family:var(--font-d);font-weight:700;font-size:17px">🚦 Pico y placa · ${fmtFecha(fechaSel)}</div>
        <div style="color:var(--muted);font-size:13px">${pp.texto} · No circulan de 5:30am a 9:00pm (servicio transporte especial)</div></div>
        <div style="margin-left:auto;display:flex;gap:8px">
          <span class="placa sm" style="background:#FF5D5D;color:#fff;border-color:#8b1a1a">${pp.digitos[0]}</span>
          <span class="placa sm" style="background:#FF5D5D;color:#fff;border-color:#8b1a1a">${pp.digitos[1]}</span>
        </div>
        <a href="https://www.pyphoy.com/bogota/servicio-de-transporte-especial" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">Verificar ↗</a>`;
    } else {
      banner.style.borderLeftColor='var(--green)';
      banner.innerHTML=`<div style="font-family:var(--font-d);font-weight:700;font-size:17px;color:var(--green)">✓ ${fmtFecha(fechaSel)}: ${pp.texto} — circulan todas las placas</div>
        <a href="https://www.pyphoy.com/bogota/servicio-de-transporte-especial" target="_blank" style="margin-left:auto;color:var(--blue);font-size:12px;text-decoration:none">Verificar ↗</a>`;
    }

    const [d1,d2] = rangoDia(fechaSel);
    const rows = (await Api.disponibilidadesRango(d1,d2)).filter(r=>r.estado==='validada');
    const sin  = rows.filter(r=>!r.asignacion_id);
    const asig = rows.filter(r=>r.asignacion_id);
    $('prKpiVal').textContent=rows.length;
    $('prKpiAsig').textContent=asig.length;
    $('prKpiSin').textContent=sin.length;

    $('prPendientes').innerHTML = sin.length ? sin.map(r=>{
      const al = docAlerta(r);
      const bloqueado = al.nivel==='block';
      const restringida = placaRestringida(r.placa, fechaSel);
      const cart = carteraAlerta(r);
      return `<div class="item" style="${bloqueado?'border-color:var(--red);border-left:3px solid var(--red)':(restringida||cart.hay?'border-left:3px solid var(--amber)':'')}"><div class="info">
        <div class="t1"><span class="placa sm">${r.placa}</span> &nbsp;${r.conductor_nombre}
          ${restringida?'<span class="badge b-pendiente" style="margin-left:6px">🚦 Pico y placa hoy</span>':''}</div>
        <div class="t2">${fmtRango(r)} · ${r.localidad||'—'} · ${r.tipo_vehiculo||''} ${r.numero_interno||''} · Tel: ${r.telefono||'—'}</div>
        <div style="margin-top:6px">${docBadge(r)}${cart.hay?` <span class="badge b-cancelada" style="margin-left:4px">${cart.texto}</span>`:''}</div>
        ${bloqueado&&al.detalle?`<div class="t2" style="color:var(--red);margin-top:4px">Pendiente: ${al.detalle}</div>`:''}
      </div>
      <div class="acts"><span class="badge b-sin">Sin asignar</span>
        ${[ 'coordinador','admin'].includes(ME.profile.role)?`<button class="btn ${bloqueado?'btn-red-o':'btn-amber'} sm" style="width:auto" onclick="UI.abrirAsignar('${r.id}','${r.placa} · ${fmtRango(r)}','${r.localidad||''}',${bloqueado},'${(al.detalle||'').replace(/'/g,'')}')">${bloqueado?'Despachar igual':'Asignar'}</button>`:''}
      </div></div>`;
    }).join('')
      : '<div class="empty">🎉 No hay vehículos validados sin asignar para este día.</div>';

    $('prAsignadas').innerHTML = asig.length ? asig.map(r=>`
      <div class="item"><div class="info">
        <div class="t1"><span class="placa sm">${r.placa}</span> &nbsp;${r.servicio||'Servicio sin nombre'}</div>
        <div class="t2">${fmtRango(r)} · Zona: ${r.zona||'—'} · ${r.conductor_nombre}${r.asignacion_notas?' · '+r.asignacion_notas:''}</div>
      </div>
      <div class="acts"><span class="badge b-asignada">Asignada</span>
        ${[ 'coordinador','admin'].includes(ME.profile.role)?`<button class="btn btn-red-o sm" onclick="UI.quitarAsignacion('${r.asignacion_id}')">Quitar</button>`:''}
      </div></div>`).join('')
      : '<div class="empty">Ninguna asignación creada aún para este día.</div>';
  },

  abrirAsignar(dispId, info, loc, bloqueado, detalle){
    ctxAsignar=dispId;
    ctxAsignarBloqueado = !!bloqueado;
    $('mAsigInfo').textContent=info;
    $('mAsigServicio').value=''; $('mAsigNotas').value='';
    if (loc) $('mAsigZona').value=loc;
    const alerta = $('mAsigAlerta');
    if (bloqueado){
      alerta.style.display='block';
      alerta.innerHTML = `⛔ <b>Este vehículo tiene documentos críticos pendientes.</b><br>
        ${detalle?'Pendiente: '+detalle+'<br>':''}
        No debería despacharse hasta regularizarlos. Si aun así decides despacharlo, marca la casilla para confirmar.`;
      $('mAsigConfirmBox').style.display='flex';
      $('mAsigConfirm').checked=false;
    } else {
      alerta.style.display='none';
      $('mAsigConfirmBox').style.display='none';
    }
    $('mAsignar').classList.add('on');
  },
  async confirmarAsignacion(){
    const serv=$('mAsigServicio').value.trim();
    if (!serv) return toast('Escribe el servicio o ruta', true);
    if (ctxAsignarBloqueado && !$('mAsigConfirm').checked)
      return toast('Marca la casilla para confirmar el despacho pese a los documentos pendientes', true);
    const notas = $('mAsigNotas').value.trim() + (ctxAsignarBloqueado?' [DESPACHADO CON DOCS PENDIENTES]':'');
    const { error } = await Api.asignar(ctxAsignar, serv, $('mAsigZona').value, notas.trim());
    UI.cerrarModal('mAsignar');
    if (error) return toast(Api.friendly(error), true);
    toast(ctxAsignarBloqueado?'Vehículo despachado (con docs pendientes) ⚠':'Vehículo asignado ✓');
    UI.loadProgramacion();
  },
  async quitarAsignacion(id){
    const { error } = await Api.cancelarAsignacion(id);
    if (error) return toast(Api.friendly(error), true);
    toast('Asignación retirada'); UI.loadProgramacion();
  },

  // ══════════ ADMIN: Base de datos (cargue diario) ══════════
  async loadAdminDatos(){
    const [conds, vehs, vins, docsVeh, ultimo, hist, cfg] = await Promise.all([
      Api.listConductores(), Api.listVehiculos(), Api.listVinculos(),
      Api.docsPorVehiculo(), Api.ultimoCargue(), Api.listarCargues(), Api.getConfig()
    ]);
    $('adKpiCond').textContent = conds.length;
    $('adKpiVeh').textContent  = vehs.length;
    $('adKpiVin').textContent  = vins.length;
    const vencidos = docsVeh.reduce((s,d)=>s+(d.docs_vencidos||0),0);
    $('adKpiVenc').textContent = vencidos;

    UI._config = cfg;
    // Cargar valores de configuración en el formulario
    if ($('cfgHora'))   $('cfgHora').value   = cfg.recordatorio_cargue_hora || '07:00';
    if ($('cfgActivo')) $('cfgActivo').value = cfg.recordatorio_cargue_activo || 'true';
    if ($('cfgPortal')) $('cfgPortal').value = cfg.portal_url || '';
    $('cfgAbrirPortal').style.display = cfg.portal_url ? '' : 'none';

    // Banner de estado del cargue del día
    const banner = $('adBannerDia');
    const hoy = hoyISO();
    const cargadoHoy = ultimo && new Date(ultimo.created_at).toDateString() === new Date().toDateString();
    if (cargadoHoy){
      banner.style.borderLeft='3px solid var(--green)';
      banner.innerHTML = `<div><div style="font-family:var(--font-d);font-weight:700;font-size:17px;color:var(--green)">✓ Cargue de hoy realizado</div>
        <div style="color:var(--muted);font-size:13px">Último: ${new Date(ultimo.created_at).toLocaleString('es-CO')} · ${ultimo.filas} filas · ${ultimo.archivo||''}</div></div>`;
    } else {
      banner.style.borderLeft='3px solid var(--amber)';
      const portal = cfg.portal_url;
      banner.innerHTML = `<div style="flex:1;min-width:220px"><div style="font-family:var(--font-d);font-weight:700;font-size:17px;color:var(--amber)">⏰ Cargue de hoy pendiente</div>
        <div style="color:var(--muted);font-size:13px">${ultimo?('Último cargue: '+new Date(ultimo.created_at).toLocaleDateString('es-CO')):'Aún no se ha cargado ningún documento'}. Descarga el archivo del portal y súbelo abajo.</div></div>
        <div style="display:flex;gap:8px">
          ${portal?`<a class="btn btn-blue sm" style="width:auto;text-decoration:none" href="${portal}" target="_blank">1. Ir al portal ↗</a>`:''}
          <button class="btn btn-amber sm" style="width:auto" onclick="document.getElementById('adFile').scrollIntoView({behavior:'smooth'});document.getElementById('adFile').click()">2. Subir archivo</button>
        </div>`;
    }

    UI._docsVeh = docsVeh.filter(d=>(d.docs_vencidos||0)>0 || (d.docs_sin_cargar||0)>0)
      .sort((a,b)=>(b.docs_vencidos||0)-(a.docs_vencidos||0));
    UI.filtrarDocs();

    $('adHistorial').innerHTML = hist.length ? hist.map(c=>`
      <div style="padding:7px 0;border-bottom:1px solid var(--line)">
        <b>${new Date(c.created_at).toLocaleString('es-CO')}</b><br>
        <span style="color:var(--muted)">${c.filas} filas · +${c.conductores_new} cond · +${c.vehiculos_new} veh · +${c.vinculos_new} vínculos</span>
      </div>`).join('') : '<span style="color:var(--faint)">Aún no hay cargues.</span>';
  },

  async guardarConfigCargue(){
    const hora=$('cfgHora').value, activo=$('cfgActivo').value, portal=$('cfgPortal').value.trim();
    const r1 = await Api.setConfig('recordatorio_cargue_hora', hora);
    const r2 = await Api.setConfig('recordatorio_cargue_activo', activo);
    const r3 = await Api.setConfig('portal_url', portal);
    if (r1.error||r2.error||r3.error) return toast('Error al guardar: '+Api.friendly(r1.error||r2.error||r3.error), true);
    toast('Configuración guardada ✓');
    UI.loadAdminDatos();
  },

  abrirPortal(){
    const url = (UI._config||{}).portal_url;
    if (url) window.open(url, '_blank');
  },

  filtrarDocs(){
    const q = ($('adBuscarPlaca').value||'').toUpperCase().trim();
    const rows = (UI._docsVeh||[]).filter(d=>!q || (d.placa||'').includes(q));
    $('tblDocsVeh').querySelector('tbody').innerHTML = rows.length ? rows.slice(0,300).map(d=>`
      <tr><td><span class="placa sm">${d.placa}</span></td>
      <td style="color:${d.docs_vencidos?'var(--red)':'inherit'}">${d.docs_vencidos||0}</td>
      <td style="color:${d.docs_sin_cargar?'var(--amber)':'inherit'}">${d.docs_sin_cargar||0}</td>
      <td style="color:var(--green)">${d.docs_vigentes||0}</td>
      <td>${d.proximo_vencimiento?new Date(d.proximo_vencimiento).toLocaleDateString('es-CO'):'—'}</td></tr>`).join('')
      : '<tr><td colspan="5" style="color:var(--green)">✓ Sin documentos vencidos ni pendientes.</td></tr>';
  },

  // Helpers de lectura de Excel reutilizables
  _leerExcel(file){
    return file.arrayBuffer().then(buf=>{
      const wb = XLSX.read(buf, { cellDates:true });
      return { wb, ws: wb.Sheets[wb.SheetNames[0]] };
    });
  },
  _fmtDate(v){ if(!v) return null; const d=(v instanceof Date)?v:new Date(v); return isNaN(d)?null:d.toISOString().slice(0,10); },
  _fmtTs(v){ if(!v) return null; const d=(v instanceof Date)?v:new Date(v); return isNaN(d)?null:d.toISOString(); },
  _pick(r,keys){ for(const k of keys){ if(r[k]!=null && r[k]!=='') return r[k]; } return ''; },
  // Lee con detección de fila de encabezado (para archivos con título arriba)
  _sheetJson(ws, headerKeywords){
    let raw = XLSX.utils.sheet_to_json(ws, { defval:'' });
    // Si la primera fila no tiene las columnas esperadas, buscar la fila de header
    if (headerKeywords && raw.length){
      const cols = Object.keys(raw[0]).join('|').toLowerCase();
      const ok = headerKeywords.some(k=>cols.includes(k.toLowerCase()));
      if (!ok){
        // Buscar fila de encabezado usando array de arrays
        const aoa = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
        let hrow = -1;
        for (let i=0;i<Math.min(10,aoa.length);i++){
          const line = aoa[i].join('|').toLowerCase();
          if (headerKeywords.some(k=>line.includes(k.toLowerCase()))){ hrow=i; break; }
        }
        if (hrow>=0){
          raw = XLSX.utils.sheet_to_json(ws, { defval:'', range: hrow });
        }
      }
    }
    return raw;
  },

  async importarExcel(){
    const tipo = $('adTipo').value;
    const file = $('adFile').files[0];
    if (!file) return toast('Selecciona primero el archivo Excel', true);
    const st=$('adImportStatus'), btn=$('adBtnImport'), res=$('adResultado');
    st.innerHTML='<span class="spin"></span>Leyendo archivo…'; btn.disabled=true; res.style.display='none';

    try {
      const { ws } = await UI._leerExcel(file);

      if (tipo === 'conductores'){
        const raw = UI._sheetJson(ws, ['Documento','Nombres','Apellidos']);
        const P = UI._pick;
        const rows = raw.map(r=>({
          documento: String(P(r,['Documento','documento'])).trim(),
          nombres: String(P(r,['Nombres','nombres'])).trim(),
          apellidos: String(P(r,['Apellidos','apellidos'])).trim(),
          celular: String(P(r,['Celular','celular','Telefono'])).trim(),
          correo: String(P(r,['Correo Electronico','Correo Electrónico','Correo','correo'])).trim(),
          licencia_num: String(P(r,['Numero Licencia','Número Licencia'])).trim(),
          licencia_cat: String(P(r,['Categoria','Categoría'])).trim(),
          licencia_vence: UI._fmtDate(P(r,['Fecha Licencia'])),
          eps: String(P(r,['Nombre EPS','EPS'])).trim(),
          arl: String(P(r,['Entidad ARL','ARL'])).trim(),
          tipo_sangre: String(P(r,['Tipo Sangre'])).trim(),
          tel_emergencia: String(P(r,['Tel Emergencia'])).trim(),
          cod_interno: String(P(r,['Cod. Interno','Cod Interno'])).trim(),
          placa1: String(P(r,['Placa #1'])).trim(), placa2: String(P(r,['Placa #2'])).trim(),
          placa3: String(P(r,['Placa #3'])).trim(), placa4: String(P(r,['Placa #4'])).trim(),
          placa5: String(P(r,['Placa #5'])).trim()
        })).filter(x=>x.documento);
        if (!rows.length){ st.textContent=''; btn.disabled=false; return toast('No se encontraron conductores. ¿El archivo es el correcto?', true); }
        st.innerHTML=`<span class="spin"></span>Cargando ${rows.length} conductores…`;
        const r = await Api.importarConductores(file.name, rows);
        st.textContent=''; btn.disabled=false;
        if (r.error) return toast('Error: '+r.error, true);
        res.style.display='block';
        res.innerHTML = `✅ <b>Conductores actualizados</b><br>Nuevos: <b>${r.nuevos}</b> · Actualizados: <b>${r.actualizados}</b> · Vínculos nuevos: <b>${r.vinculos_nuevos}</b>`;
        toast('Conductores actualizados ✓'); $('adFile').value=''; UI.loadAdminDatos();
        return;
      }

      // tipo documentos (por defecto)
      const raw = UI._sheetJson(ws, ['Placa','Nombre Documento']);
      const P = UI._pick;
      const rows = raw.map(r=>({
        placa: String(P(r,['Placa','placa'])).trim(),
        documento_persona: String(P(r,['Nro Identificacion','Nro Identificación','Documento','documento_persona'])).trim(),
        nombre_persona: String(P(r,['Nombre','nombre_persona'])).trim(),
        tipo_titular: String(P(r,['Tipo','tipo_titular'])).trim(),
        nombre_documento: String(P(r,['Nombre Documento','nombre_documento'])).trim(),
        inicio_vigencia: UI._fmtDate(P(r,['Inicio Vigencia','inicio_vigencia'])),
        vigente_hasta: UI._fmtDate(P(r,['Vigente Hasta','vigente_hasta'])),
        estado: String(P(r,['Estado','estado'])).trim(),
        fecha_cargue: UI._fmtTs(P(r,['Fecha - Hora Cargue','Fecha Hora Cargue','fecha_cargue'])),
        usuario_cargue: String(P(r,['Usuario','usuario_cargue'])).trim(),
        empresa: String(P(r,['Empresa','empresa'])).trim()
      }));
      st.innerHTML=`<span class="spin"></span>Cargando ${rows.length} filas…`;
      const r = await Api.importarCargue(file.name, rows);
      st.textContent=''; btn.disabled=false;
      if (r.error) return toast('Error: '+r.error, true);
      res.style.display='block';
      res.innerHTML = `✅ <b>Cargue exitoso</b> · ${r.filas} filas procesadas<br>
        Nuevos: <b>${r.conductores_nuevos}</b> conductores, <b>${r.vehiculos_nuevos}</b> vehículos,
        <b>${r.vinculos_nuevos}</b> vínculos · <b>${r.documentos}</b> documentos actualizados`;
      toast('Base de datos actualizada ✓');
      $('adFile').value='';
      UI.loadAdminDatos();
    } catch(e){
      st.textContent=''; btn.disabled=false;
      toast('Error al leer el Excel: '+e.message, true);
    }
  },

  // ── Cartera ──
  async loadCartera(){
    UI._cartera = await Api.listarCartera(false);
    const mora = UI._cartera.filter(c=>(c.periodos_vencidos||0)>0);
    $('caKpiTotal').textContent = UI._cartera.length;
    $('caKpiMora').textContent = mora.length;
    const total = mora.reduce((s,c)=>s+(Number(c.valor_vencido)||0),0);
    $('caKpiValor').textContent = '$'+total.toLocaleString('es-CO');
    UI.renderCartera();
  },
  renderCartera(){
    const q=($('caBuscar').value||'').toUpperCase().trim();
    const solo=$('caFiltro').value==='mora';
    let rows=(UI._cartera||[]);
    if (solo) rows=rows.filter(c=>(c.periodos_vencidos||0)>0);
    if (q) rows=rows.filter(c=>(c.placa||'').includes(q));
    $('tblCartera').querySelector('tbody').innerHTML = rows.length ? rows.slice(0,500).map(c=>`
      <tr><td><span class="placa sm">${c.placa}</span></td><td>${c.nombre_afiliado||'—'}</td>
      <td>${c.empresa||'—'}</td><td style="font-size:12px">${c.ultimo_periodo_pago||'—'}</td>
      <td style="color:${c.periodos_vencidos>0?'var(--red)':'inherit'};font-weight:${c.periodos_vencidos>0?'700':'400'}">${c.periodos_vencidos||0}</td>
      <td style="color:${c.valor_vencido>0?'var(--red)':'inherit'}">$${Number(c.valor_vencido||0).toLocaleString('es-CO')}</td>
      <td>${c.estado||'—'}</td></tr>`).join('')
      : '<tr><td colspan="7" style="color:var(--faint)">Sin registros.</td></tr>';
  },
  async importarCartera(){
    const file=$('caFile').files[0];
    if (!file) return toast('Selecciona el archivo de cartera', true);
    const st=$('caStatus'), btn=$('caBtn');
    st.innerHTML='<span class="spin"></span>Leyendo…'; btn.disabled=true;
    try {
      const { ws } = await UI._leerExcel(file);
      const raw = UI._sheetJson(ws, ['Placa','Periodos Vencidos','Nombre Afiliado']);
      const P=UI._pick;
      const rows = raw.map(r=>({
        placa: String(P(r,['Placa','placa'])).trim(),
        num_interno: String(P(r,['Num. Interno','Num Interno'])).trim(),
        identificacion: String(P(r,['Identificacion','Identificación'])).trim(),
        nombre_afiliado: String(P(r,['Nombre Afiliado'])).trim(),
        celular: String(P(r,['Celular'])).trim(), correo: String(P(r,['Correo'])).trim(),
        empresa: String(P(r,['Empresa'])).trim(), clase_vehiculo: String(P(r,['Clase Vehiculo','Clase Vehículo'])).trim(),
        empresa_convenio: String(P(r,['Empresa Convenio'])).trim(),
        ultimo_periodo_pago: String(P(r,['Ultimo Periodo Pago','Último Periodo Pago'])).trim(),
        periodos_vencidos: String(P(r,['# Periodos Vencidos','Periodos Vencidos'])).trim(),
        valor_vencido: String(P(r,['$ Periodos Vencidos','Valor Vencido'])).replace(/[^0-9.-]/g,'').trim(),
        estado: String(P(r,['Estado'])).trim()
      })).filter(x=>x.placa);
      if (!rows.length){ st.textContent=''; btn.disabled=false; return toast('No se encontraron datos de cartera', true); }
      st.innerHTML=`<span class="spin"></span>Cargando ${rows.length}…`;
      const r = await Api.importarCartera(file.name, rows);
      st.textContent=''; btn.disabled=false;
      if (r.error) return toast('Error: '+r.error, true);
      toast(`Cartera actualizada: ${r.filas} registros ✓`); $('caFile').value=''; UI.loadCartera();
    } catch(e){ st.textContent=''; btn.disabled=false; toast('Error: '+e.message, true); }
  },

  // ── Consolidado ──
  async loadConsolidado(){
    UI._consolidado = await Api.listarConsolidado();
    $('coKpiTotal').textContent = UI._consolidado.length;
    const empresas = new Set(UI._consolidado.map(c=>c.empresa).filter(Boolean));
    $('coKpiEmpresas').textContent = empresas.size;
    const modelos = UI._consolidado.map(c=>parseInt(c.modelo)).filter(m=>!isNaN(m));
    $('coKpiModelo').textContent = modelos.length ? Math.round(modelos.reduce((a,b)=>a+b,0)/modelos.length) : '—';
    UI.renderConsolidado();
  },
  renderConsolidado(){
    const q=($('coBuscar').value||'').toUpperCase().trim();
    let rows=(UI._consolidado||[]);
    if (q) rows=rows.filter(c=>(c.placa||'').includes(q)||(c.nombre_propietario||'').toUpperCase().includes(q));
    $('tblConsolidado').querySelector('tbody').innerHTML = rows.length ? rows.slice(0,500).map(c=>`
      <tr><td><span class="placa sm">${c.placa}</span></td><td>${c.num_interno||'—'}</td>
      <td style="font-size:12px">${c.nombre_propietario||'—'}</td><td>${c.marca||'—'}</td>
      <td>${c.clase||'—'}</td><td>${c.modelo||'—'}</td>
      <td>${c.soat_fecha?new Date(c.soat_fecha).toLocaleDateString('es-CO'):'—'}</td>
      <td>${c.tecmecanica_fecha?new Date(c.tecmecanica_fecha).toLocaleDateString('es-CO'):'—'}</td>
      <td style="font-size:12px">${c.empresa||'—'}</td></tr>`).join('')
      : '<tr><td colspan="9" style="color:var(--faint)">Sin registros.</td></tr>';
  },
  async importarConsolidado(){
    const file=$('coFile').files[0];
    if (!file) return toast('Selecciona el archivo consolidado', true);
    const st=$('coStatus'), btn=$('coBtn');
    st.innerHTML='<span class="spin"></span>Leyendo…'; btn.disabled=true;
    try {
      const { ws } = await UI._leerExcel(file);
      const raw = UI._sheetJson(ws, ['Placa','Marca Vehículo','Nombre Propietario']);
      const P=UI._pick, D=UI._fmtDate;
      const rows = raw.map(r=>({
        placa: String(P(r,['Placa'])).trim(), num_interno: String(P(r,['No Interno','No. Interno'])).trim(),
        nombre_propietario: String(P(r,['Nombre Propietario'])).trim(), documento: String(P(r,['Documento'])).trim(),
        telefono: String(P(r,['Teléfono','Telefono'])).trim(), celular: String(P(r,['Celular'])).trim(),
        email: String(P(r,['Email'])).trim(), ciudad: String(P(r,['Ciudad Vehiculo','Ciudad Vehículo'])).trim(),
        tar_operacion: String(P(r,['Tar. Operacion #','Tar. Operación #'])).trim(),
        vence_operacion: D(P(r,['Vence T. Operacion','Vence T. Operación'])),
        marca: String(P(r,['Marca Vehículo','Marca Vehiculo'])).trim(), clase: String(P(r,['Clase Vehículo','Clase Vehiculo'])).trim(),
        combustible: String(P(r,['Tipo Combustible'])).trim(), carroceria: String(P(r,['Tipo Carrocería','Tipo Carroceria'])).trim(),
        pasajeros: String(P(r,['Pasajeros'])).trim(), modelo: String(P(r,['Modelo'])).trim(),
        cilindraje: String(P(r,['Cilindraje'])).trim(), chasis: String(P(r,['Chasis'])).trim(), motor: String(P(r,['Motor'])).trim(),
        soat_num: String(P(r,['No. SOAT','No SOAT'])).trim(), soat_entidad: String(P(r,['Entidad Soat','Entidad SOAT'])).trim(),
        soat_fecha: D(P(r,['Fecha SOAT'])), seguros_entidad: String(P(r,['Entidad Seguros'])).trim(),
        seguros_fecha: D(P(r,['Fecha Seguros'])), tecmecanica_fecha: D(P(r,['Fecha TecMecanica','Fecha Tecmecanica'])),
        preventiva_fecha: D(P(r,['Fecha Preventiva'])), tipo_convenio: String(P(r,['Tipo Convenio'])).trim(),
        empresa_convenio: String(P(r,['Empresa Convenio'])).trim(), estado: String(P(r,['Estado'])).trim(),
        estado_vehiculo: String(P(r,['Estado Vehículo','Estado Vehiculo'])).trim(), empresa: String(P(r,['Empresa'])).trim()
      })).filter(x=>x.placa);
      if (!rows.length){ st.textContent=''; btn.disabled=false; return toast('No se encontraron vehículos', true); }
      st.innerHTML=`<span class="spin"></span>Cargando ${rows.length}…`;
      const r = await Api.importarConsolidado(file.name, rows);
      st.textContent=''; btn.disabled=false;
      if (r.error) return toast('Error: '+r.error, true);
      toast(`Consolidado actualizado: ${r.filas} vehículos ✓`); $('coFile').value=''; UI.loadConsolidado();
    } catch(e){ st.textContent=''; btn.disabled=false; toast('Error: '+e.message, true); }
  },
  async exportarConsolidado(){
    const rows = UI._consolidado||[];
    if (!rows.length) return toast('No hay datos para exportar', true);
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Consolidado');
    XLSX.writeFile(wb, `Consolidado_${hoyISO().replace(/-/g,'_')}.xlsx`);
    toast('Excel descargado ✓');
  },

  async exportarExcel(){
    const st=$('adExportStatus');
    st.innerHTML='<span class="spin"></span>Preparando…';
    try {
      const docs = await Api.todosLosDocumentos();
      if (!docs.length){ st.textContent=''; return toast('No hay documentos para exportar', true); }
      const rows = docs.map(d=>({
        'Empresa': d.empresa||'', 'Placa': d.placa||'', 'Tipo': d.tipo_titular||'',
        'Nombre': d.nombre_persona||'', 'Nro Identificacion': d.documento_persona||'',
        'Nombre Documento': d.nombre_documento||'',
        'Inicio Vigencia': d.inicio_vigencia||'', 'Vigente Hasta': d.vigente_hasta||'',
        'Estado': d.estado||'',
        'Fecha - Hora Cargue': d.fecha_cargue?new Date(d.fecha_cargue).toLocaleString('es-CO'):'',
        'Usuario': d.usuario_cargue||''
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Documentos');
      const hoy = new Date().toISOString().slice(0,10).replace(/-/g,'_');
      XLSX.writeFile(wb, `DocumentosAfiliados_${hoy}.xlsx`);
      st.textContent=''; toast('Excel descargado ✓');
    } catch(e){ st.textContent=''; toast('Error al exportar: '+e.message, true); }
  },

  // ══════════ JEFE/ADMIN: Equipo ══════════
  async loadEquipo(){
    const tb=$('tblEquipo').querySelector('tbody');
    tb.innerHTML='<tr><td colspan="4" class="loading"><span class="spin"></span>Cargando…</td></tr>';
    const r = await Api.gestionarEmpleados('list');
    if (r.error){ tb.innerHTML=`<tr><td colspan="4" style="color:var(--red)">${r.error}</td></tr>`; return; }
    UI._equipo = r.empleados;
    tb.innerHTML = r.empleados.map(e=>{
      const esYo = e.id===ME.session.user.id;
      return `<tr>
        <td>${e.full_name||'—'}${esYo?' <span style="color:var(--amber)">(tú)</span>':''}</td>
        <td>${e.email}</td>
        <td>
          <select onchange="UI.cambiarRol('${e.id}',this.value)" style="width:auto;padding:5px 9px;font-size:13px">
            <option value="coordinador" ${e.role==='coordinador'?'selected':''}>Coordinador</option>
            <option value="analista" ${e.role==='analista'?'selected':''}>Analista</option>
            <option value="jefe" ${e.role==='jefe'?'selected':''}>Jefe</option>
            <option value="admin" ${e.role==='admin'?'selected':''}>Administrador</option>
          </select>
        </td>
        <td style="white-space:nowrap">
          <button class="btn btn-ghost sm" onclick="UI.abrirReset('${e.id}','${(e.full_name||e.email).replace(/'/g,'')}')">Clave</button>
          ${esYo?'':`<button class="btn btn-red-o sm" onclick="UI.eliminarEmpleado('${e.id}','${(e.full_name||e.email).replace(/'/g,'')}')">Eliminar</button>`}
        </td>
      </tr>`;
    }).join('') || '<tr><td colspan="4" style="color:var(--faint)">Sin empleados.</td></tr>';
  },

  abrirEmpleadoModal(){
    $('mEmpTitle').textContent='Nuevo empleado';
    $('meNombre').value=''; $('meEmail').value=''; $('mePass').value=''; $('meRol').value='coordinador';
    $('mEmpleado').classList.add('on');
  },
  async guardarEmpleado(){
    const nombre=$('meNombre').value.trim(), email=$('meEmail').value.trim(),
          pass=$('mePass').value, rol=$('meRol').value;
    if (!nombre||!email||!pass) return toast('Nombre, email y contraseña son obligatorios', true);
    if (pass.length<6) return toast('La contraseña debe tener al menos 6 caracteres', true);
    const btn=$('meGuardar'); btn.disabled=true; btn.innerHTML='<span class="spin"></span>Creando…';
    const r = await Api.gestionarEmpleados('create', { email, password:pass, full_name:nombre, role:rol });
    btn.disabled=false; btn.textContent='Crear';
    if (r.error) return toast(r.error, true);
    UI.cerrarModal('mEmpleado'); toast('Empleado creado ✓'); UI.loadEquipo();
  },
  async cambiarRol(id, rol){
    const r = await Api.gestionarEmpleados('setRole', { target_id:id, role:rol });
    if (r.error){ toast(r.error, true); UI.loadEquipo(); return; }
    toast('Rol actualizado ✓');
    if (id===ME.session.user.id){ toast('Cambiaste tu propio rol, recargando…'); setTimeout(()=>location.reload(),1200); }
  },
  abrirReset(id, nombre){ UI._resetId=id; $('mrInfo').textContent='Empleado: '+nombre; $('mrPass').value=''; $('mReset').classList.add('on'); },
  async confirmarReset(){
    const pass=$('mrPass').value;
    if (pass.length<6) return toast('Mínimo 6 caracteres', true);
    const r = await Api.gestionarEmpleados('resetPassword', { target_id:UI._resetId, password:pass });
    UI.cerrarModal('mReset');
    if (r.error) return toast(r.error, true);
    toast('Contraseña restablecida ✓');
  },
  async eliminarEmpleado(id, nombre){
    if (!confirm(`¿Eliminar a ${nombre}? Esta acción no se puede deshacer.`)) return;
    const r = await Api.gestionarEmpleados('delete', { target_id:id });
    if (r.error) return toast(r.error, true);
    toast('Empleado eliminado'); UI.loadEquipo();
  },

  // ══════════ JEFE: Reportería ══════════
  async loadReportes(){
    const [d1] = rangoDia($('rpDesde').value||hoyISO());
    const [,d2] = rangoDia($('rpHasta').value||hoyISO());
    const rows = (await Api.disponibilidadesRango(d1,d2))
      .filter(r=>['validada','pendiente'].includes(r.estado));
    lastReporte = rows;

    const asig = rows.filter(r=>r.asignacion_id);
    const sin  = rows.filter(r=>!r.asignacion_id);
    $('rpKpiDisp').textContent=rows.length;
    $('rpKpiAsig').textContent=asig.length;
    $('rpKpiSin').textContent=sin.length;
    $('rpKpiCob').textContent=(rows.length?Math.round(asig.length/rows.length*100):0)+'%';

    // Documentos críticos
    const conDocs = rows.filter(r=>(r.docs_criticos_pendientes||0)>0);
    $('rpKpiDocs').textContent = conDocs.length;
    $('tblDocsCriticos').querySelector('tbody').innerHTML = conDocs.length ? conDocs.map(r=>`
      <tr><td><span class="placa sm">${r.placa}</span></td><td>${r.conductor_nombre}</td>
      <td>${fmtFecha(r.inicio)}</td>
      <td>${r.asignacion_id?'<span class="badge b-asignada">Despachada</span>':estadoBadge(r)}</td>
      <td style="color:var(--red);font-size:12.5px">${r.detalle_criticos||'—'}</td></tr>`).join('')
      : '<tr><td colspan="5" style="color:var(--green)">✓ Ningún vehículo del rango tiene documentos críticos pendientes.</td></tr>';

    // — Por franja horaria —
    const fAsig=Array(24).fill(0), fSin=Array(24).fill(0);
    rows.forEach(r=>{
      const a=new Date(r.inicio), b=new Date(r.fin);
      for(let t=new Date(a); t<b; t.setHours(t.getHours()+1)){
        (r.asignacion_id?fAsig:fSin)[t.getHours()]++;
      }
    });
    if (chFranjas) chFranjas.destroy();
    Chart.defaults.color='#8C97A6'; Chart.defaults.borderColor='#28303C';
    chFranjas = new Chart($('chFranjas'), {
      type:'bar',
      data:{ labels:HOURS, datasets:[
        {label:'Asignados', data:fAsig, backgroundColor:'#4EA1FF', stack:'s'},
        {label:'Sin asignar', data:fSin, backgroundColor:'#FF5D5D', stack:'s'}
      ]},
      options:{ responsive:true, plugins:{legend:{position:'bottom'}},
        scales:{ x:{stacked:true,ticks:{maxRotation:0,autoSkip:true}}, y:{stacked:true,beginAtZero:true,ticks:{precision:0}} } }
    });

    // — Por localidad —
    const porLoc={};
    rows.forEach(r=>{
      const l=r.localidad||'Sin zona';
      porLoc[l]=porLoc[l]||{a:0,s:0};
      r.asignacion_id?porLoc[l].a++:porLoc[l].s++;
    });
    const locs=Object.keys(porLoc).sort((x,y)=>(porLoc[y].a+porLoc[y].s)-(porLoc[x].a+porLoc[x].s));
    if (chZonas) chZonas.destroy();
    chZonas = new Chart($('chZonas'), {
      type:'bar',
      data:{ labels:locs, datasets:[
        {label:'Asignados', data:locs.map(l=>porLoc[l].a), backgroundColor:'#4EA1FF', stack:'s'},
        {label:'Sin asignar', data:locs.map(l=>porLoc[l].s), backgroundColor:'#FFB020', stack:'s'}
      ]},
      options:{ indexAxis:'y', responsive:true, plugins:{legend:{position:'bottom'}},
        scales:{ x:{stacked:true,beginAtZero:true,ticks:{precision:0}}, y:{stacked:true} } }
    });

    // — Tabla sin asignar —
    $('tblSinAsignar').querySelector('tbody').innerHTML = sin.length ? sin.map(r=>`
      <tr><td><span class="placa sm">${r.placa}</span></td><td>${r.conductor_nombre}</td>
      <td>${fmtFecha(r.inicio)}</td><td>${fmtHora(r.inicio)} → ${fmtHora(r.fin)}</td>
      <td>${r.localidad||'—'}</td><td>${estadoBadge(r)}</td></tr>`).join('')
      : '<tr><td colspan="6" style="color:var(--green)">✓ Toda la flota disponible está asignada en el rango.</td></tr>';

    // — Mapa de calor —
    if (!mapHeat){
      mapHeat = L.map('mapaCalor').setView([4.62,-74.11], 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        {attribution:'© OpenStreetMap · © CARTO', maxZoom:19}).addTo(mapHeat);
    }
    setTimeout(()=>mapHeat.invalidateSize(), 150);
    UI.renderHeat();
  },

  setHeatMode(mode){
    heatMode=mode;
    $('hmModeDisp').classList.toggle('on', mode==='disp');
    $('hmModeGps').classList.toggle('on', mode==='gps');
    UI.renderHeat();
  },

  async renderHeat(){
    if (!mapHeat || !lastReporte) return;
    if (heatLayer){ heatLayer.remove(); heatLayer=null; }
    zoneMarkers.forEach(m=>m.remove()); zoneMarkers=[];
    let pts=[];

    if (heatMode==='disp'){
      const porLoc={};
      lastReporte.forEach(r=>{ const l=r.localidad; if(LOC_COORDS[l]) porLoc[l]=(porLoc[l]||0)+1; });
      const max=Math.max(1,...Object.values(porLoc));
      Object.entries(porLoc).forEach(([l,n])=>{
        const [lat,lng]=LOC_COORDS[l];
        pts.push([lat,lng, n/max]);
        zoneMarkers.push(L.marker([lat,lng],{icon:L.divIcon({className:'',html:
          `<div style="background:#151B23;border:1px solid #FFB020;color:#E9EDF2;border-radius:8px;padding:2px 7px;font:600 11px Inter,sans-serif;white-space:nowrap">${l}: ${n}</div>`,
          iconSize:null})}).addTo(mapHeat));
      });
    } else {
      const ubs = await Api.ultimasUbicaciones();
      pts = ubs.map(u=>[u.lat,u.lng,0.8]);
      ubs.forEach(u=>{
        zoneMarkers.push(L.circleMarker([u.lat,u.lng],{radius:6,color:'#4EA1FF',fillColor:'#4EA1FF',fillOpacity:.9})
          .bindPopup(`<b>${u.placa}</b><br>${u.nombre}<br><small>${new Date(u.reportada_at).toLocaleString('es-CO')}</small>`)
          .addTo(mapHeat));
      });
      if (!pts.length) toast('Aún no hay ubicaciones GPS reportadas', true);
    }
    if (pts.length){
      heatLayer=L.heatLayer(pts,{radius:38,blur:26,maxZoom:14,
        gradient:{0.2:'#2b5cff',0.5:'#37C97D',0.75:'#FFB020',1:'#FF5D5D'}}).addTo(mapHeat);
    }
  }
};

// ══════════ Componentes reutilizables ══════════
function buildHourRail(elId, state, onChange){
  const el=$(elId);
  el.innerHTML = HOURS.map((h,i)=>`<button type="button" data-i="${i}">${h}</button>`).join('');
  el.querySelectorAll('button').forEach(b=>{
    b.onclick=()=>{
      const i=+b.dataset.i;
      if (state.start===null || (state.start!==null && state.end!==null)){ state.start=i; state.end=null; }
      else state.end=i;
      paintRail(el, state); onChange();
    };
  });
  paintRail(el, state);
}
function paintRail(el, state){
  el.querySelectorAll('button').forEach(b=>{
    const i=+b.dataset.i;
    b.className='';
    if (i===state.start || i===state.end) b.className='sel';
    else if (state.start!==null && state.end!==null){
      if (state.end>state.start ? (i>state.start&&i<state.end) : (i>state.start||i<state.end)) b.className='mid';
    }
  });
}
function ndResumen(){
  const el=$('ndResumen');
  if (nd.start===null){ el.innerHTML='Selecciona días y franja horaria.'; return; }
  const fin = nd.end!==null?HOURS[nd.end]:'…';
  const noct = nd.end!==null && nd.end<=nd.start;
  const horas = nd.end!==null ? (nd.end>nd.start?nd.end-nd.start:24-nd.start+nd.end) : 0;
  el.innerHTML=`Franja: <b>${HOURS[nd.start]} → ${fin}</b>${noct?' <b>(cruza medianoche 🌙)</b>':''}
    ${nd.end!==null?` · <b>${horas} h</b>`:''} · Días seleccionados: <b>${nd.dias.size}</b>`;
}
function acResumen(){
  const el=$('acResumen');
  if (ac.start===null){ el.innerHTML='Selecciona la franja.'; return; }
  const fin=ac.end!==null?HOURS[ac.end]:'…';
  el.innerHTML=`Franja: <b>${HOURS[ac.start]} → ${fin}</b>${ac.end!==null&&ac.end<=ac.start?' (cruza medianoche 🌙)':''}`;
}
function buildDiasRail(){
  const base=$('ndFecha').value||hoyISO();
  nd.dias=new Set([base]);
  const d0=new Date(base+'T00:00:00');
  const el=$('ndDias'); el.innerHTML='';
  for(let k=0;k<7;k++){
    const d=new Date(d0); d.setDate(d.getDate()+k);
    const iso=d.toISOString().slice(0,10);
    const b=document.createElement('button');
    b.type='button'; b.textContent=DIAS[d.getDay()]+' '+d.getDate();
    b.className=nd.dias.has(iso)?'sel':'';
    b.onclick=()=>{ nd.dias.has(iso)?nd.dias.delete(iso):nd.dias.add(iso);
      b.classList.toggle('sel'); ndResumen(); };
    el.appendChild(b);
  }
  ndResumen();
}

// ══════════ Arranque ══════════
(async function init(){
  if (!APP_CONFIG.SUPABASE_URL || APP_CONFIG.SUPABASE_URL.includes('TU_PROYECTO')){
    $('loginErr').textContent='⚠ Configura SUPABASE_URL y SUPABASE_ANON_KEY en config.js';
    $('loginErr').style.display='block';
    return;
  }
  const session = await Api.getSession();
  if (session) await UI.enterApp();
  ['lgDoc','lgPass'].forEach(id=>$(id).addEventListener('keydown', e=>{ if(e.key==='Enter') UI.doLogin(); }));
})();
