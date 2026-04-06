# 🚗 Special CAR — FleetSync
### Sistema de Gestión de Horarios para Conductores

---

## 🚀 Instalación completa

### PASO 1 — Crea el Google Sheet

1. Ve a [sheets.google.com](https://sheets.google.com) → nueva hoja
2. Crea **dos pestañas**: `Conductores` y `Horarios`

**Pestaña Conductores** — fila 1:
```
A1:Nombre  B1:Documento  C1:Placa  D1:Telefono  E1:TipoVehiculo  F1:NumeroInterno  G1:Localidad
```

**Pestaña Horarios** — fila 1:
```
A1:ID  B1:Documento  C1:Placa  D1:Inicio  E1:Fin  F1:Estado  G1:MotivoCancelacion  H1:FechaCreacion  I1:FechaCancelacion  J1:Localidad  K1:Notas
```

Agrega conductores en **Conductores** desde fila 2:
- Col **B** = Documento/Cédula → es el PIN de acceso
- Col **C** = Placa → es el usuario

---

### PASO 2 — Instala el Apps Script (CON soporte JSONP)

1. En tu Google Sheet → **Extensiones → Apps Script**
2. Borra todo y pega este código completo:

```javascript
const SS_ID    = SpreadsheetApp.getActiveSpreadsheet().getId();
const TAB_COND = 'Conductores';
const TAB_HOR  = 'Horarios';
const ADMIN_PIN= 'admin123'; // ← Cambia esto

// IMPORTANTE: soporta JSONP (parámetro callback) para evitar errores CORS
function doGet(e) {
  const p        = e.parameter || {};
  const callback = p.callback  || '';   // ← JSONP callback name
  let result;

  try {
    switch(p.action) {
      case 'login':        result = login(p);        break;
      case 'getHorarios':  result = getHorarios(p);  break;
      case 'addTurno':     result = addTurno(p);     break;
      case 'updateTurno':  result = updateTurno(p);  break;
      case 'cancelTurno':  result = cancelTurno(p);  break;
      case 'saveProfile':  result = saveProfile(p);  break;
      case 'getAllDrivers': result = getAllDrivers();  break;
      case 'getAllTurnos':  result = getAllTurnos();   break;
      case 'ping':         result = {ok:true,msg:'pong'}; break;
      default: result = { ok:false, error:'Accion desconocida: '+p.action };
    }
  } catch(err) {
    result = { ok:false, error:err.message };
  }

  const json = JSON.stringify(result);

  // Si viene con callback → responder como JSONP (evita CORS)
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  // Sin callback → responder como JSON normal
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) { return doGet(e); }

// ── FUNCIONES ─────────────────────────────────────────

function login(p) {
  if(p.plate==='ADMIN' && p.doc===ADMIN_PIN)
    return {ok:true, driver:{name:'Administrador',plate:'ADMIN',doc:ADMIN_PIN,isAdmin:true}};

  const rows = SpreadsheetApp.openById(SS_ID)
    .getSheetByName(TAB_COND).getDataRange().getValues();

  for(let i=1; i<rows.length; i++){
    const r=rows[i];
    if((r[1]||'').toString().trim() === (p.doc||'').trim() &&
       (r[2]||'').toString().trim().toUpperCase() === (p.plate||'').trim().toUpperCase())
      return {ok:true, rowIndex:i+1, driver:{
        name:r[0]||'', doc:r[1]||'', plate:(r[2]||'').toUpperCase(),
        phone:r[3]||'', vehicleType:r[4]||'', vehicleNum:r[5]||'', locality:r[6]||''
      }};
  }
  return {ok:false, error:'Placa o documento no encontrado.'};
}

function getHorarios(p) {
  const rows=getHS().getDataRange().getValues(), result=[];
  for(let i=1; i<rows.length; i++){
    const r=rows[i];
    if((r[1]||'').toString().trim()===(p.doc||'').trim() &&
       (r[2]||'').toString().trim().toUpperCase()===(p.plate||'').trim().toUpperCase())
      result.push(rtt(r,i+1));
  }
  return {ok:true, turnos:result};
}

function addTurno(p) {
  const id='SH'+Date.now()+Math.random().toString(36).slice(2,6).toUpperCase();
  getHS().appendRow([id, p.doc, p.plate, p.inicio, p.fin,
    'active','', new Date().toISOString(),'', p.locality||'', p.notes||'']);
  return {ok:true, id:id};
}

function updateTurno(p) {
  const row=parseInt(p.sheetRow);
  const v=getHS().getRange(row,1,1,11).getValues()[0];
  v[3]=p.inicio; v[4]=p.fin;
  v[9]=p.locality||v[9]; v[10]=p.notes!==undefined?p.notes:v[10];
  getHS().getRange(row,1,1,11).setValues([v]);
  return {ok:true};
}

function cancelTurno(p) {
  const row=parseInt(p.sheetRow);
  const v=getHS().getRange(row,1,1,11).getValues()[0];
  v[5]='cancelled'; v[6]=p.motivo||''; v[8]=new Date().toISOString();
  getHS().getRange(row,1,1,11).setValues([v]);
  return {ok:true};
}

function saveProfile(p) {
  const s=SpreadsheetApp.openById(SS_ID).getSheetByName(TAB_COND);
  const row=parseInt(p.rowIndex);
  const v=s.getRange(row,1,1,7).getValues()[0];
  v[0]=p.name||v[0]; v[3]=p.phone||v[3];
  v[4]=p.vehicleType||v[4]; v[5]=p.vehicleNum||v[5]; v[6]=p.locality||v[6];
  s.getRange(row,1,1,7).setValues([v]);
  return {ok:true};
}

function getAllDrivers() {
  const rows=SpreadsheetApp.openById(SS_ID)
    .getSheetByName(TAB_COND).getDataRange().getValues();
  const d=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i]; if(!r[1]) continue;
    d.push({rowIndex:i+1, name:r[0]||'', doc:r[1]||'',
      plate:(r[2]||'').toUpperCase(), phone:r[3]||'',
      vehicleType:r[4]||'', vehicleNum:r[5]||'', locality:r[6]||''});
  }
  return {ok:true, drivers:d};
}

function getAllTurnos() {
  const rows=getHS().getDataRange().getValues(), t=[];
  for(let i=1;i<rows.length;i++){ if(rows[i][0]) t.push(rtt(rows[i],i+1)); }
  return {ok:true, turnos:t};
}

function getHS(){ return SpreadsheetApp.openById(SS_ID).getSheetByName(TAB_HOR); }

function rtt(r,ri){
  return {sheetRow:ri, id:r[0]||'', doc:r[1]||'', plate:r[2]||'',
    inicio:r[3]||'', fin:r[4]||'', estado:r[5]||'active',
    motivoCan:r[6]||'', fechaCreacion:r[7]||'', fechaCan:r[8]||'',
    locality:r[9]||'', notes:r[10]||''};
}
```

3. Clic en 💾 **Guardar** → Nombre del proyecto: `FleetSync`

---

### PASO 3 — Despliega como Web App

1. **Implementar → Nueva implementación**
2. Engranaje ⚙️ → **Aplicación web**
3. Configurar:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**
4. Clic en **Implementar** → Autoriza los permisos cuando te pida
5. Copia la URL:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```

> ⚠️ **Cada vez que modifiques el script** → nueva implementación (no editar la existente)

---

### PASO 4 — Configura config.js

```javascript
const SHEETS_CONFIG = {
  SCRIPT_URL: "https://script.google.com/macros/s/TU_ID_AQUI/exec",
  ADMIN_PIN:  "admin123"
};
```

---

### PASO 5 — Sube a GitHub Pages

1. Crea repo en GitHub → Público
2. Sube: `index.html`, `app.js`, `config.js`
3. Settings → Pages → Branch: main → Save
4. Tu app: `https://TU_USUARIO.github.io/NOMBRE_REPO/`

---

## ❓ ¿Por qué no funciona desde localhost?

**Es normal.** El error CORS desde `127.0.0.1` o `localhost` ocurre porque
Google Apps Script bloquea orígenes locales por seguridad. La app usa
técnica **JSONP** que esquiva CORS, pero algunos navegadores en modo muy estricto
pueden bloquearlo localmente. **Desde GitHub Pages siempre funciona.**

Para probar localmente sin subir a GitHub:
- Chrome: arranca con `--disable-web-security --user-data-dir=/tmp/test`
- O simplemente prueba directamente en GitHub Pages

---

## 🆘 Errores comunes

| Error | Causa | Solución |
|-------|-------|---------|
| CORS en localhost | Google bloquea localhost | Prueba en GitHub Pages (funciona) |
| `0 turnos guardados` | Fechas con <12h de anticipación | Selecciona fechas de mañana en adelante |
| Timeout 15s | URL incorrecta o script no público | Verifica SCRIPT_URL y que acceso sea "Cualquier persona" |
| `Accion desconocida` | Script desactualizado | Pega el código nuevo y reimplementa |

---

## 👤 Admin

- **Placa:** `ADMIN`  
- **PIN:** el que pusiste en `ADMIN_PIN` del script (default: `admin123`)

