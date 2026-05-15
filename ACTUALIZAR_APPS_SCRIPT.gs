// ═══════════════════════════════════════════════════════════════
//  INSTRUCCIÓN IMPORTANTE — CORS para móviles
//  Agrega estas dos funciones a tu Google Apps Script existente,
//  o asegúrate de que tu doGet() use ContentService así:
// ═══════════════════════════════════════════════════════════════

// ► REEMPLAZA tu función doGet() por esta versión con CORS:

function doGet(e) {
  // ── Leer parámetros ──────────────────────────────────────────
  var params = e.parameter || {};
  var action = params.action || '';

  // ── Ejecutar la acción ───────────────────────────────────────
  var result;
  try {
    result = handleAction(action, params);
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  // ── Responder con CORS (compatible con fetch desde móvil) ────
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
    // ↑ Google Apps Script agrega automáticamente los headers CORS
    //   cuando se despliega como Web App con acceso "Cualquier persona"
}

// ► Si ya tienes tu lógica en handleAction(), solo cambia doGet().
//   Si no, mueve toda tu lógica dentro de handleAction() así:

function handleAction(action, params) {
  // ── Aquí va TODA la lógica que ya tienes en tu script ────────
  // Ejemplo de estructura:

  if (action === 'ping') {
    return { ok: true, message: 'pong', timestamp: new Date().toISOString() };
  }

  if (action === 'login') {
    // ... tu lógica de login ...
  }

  if (action === 'getHorarios') {
    // ... tu lógica ...
  }

  // etc.

  return { ok: false, error: 'Acción no reconocida: ' + action };
}

// ═══════════════════════════════════════════════════════════════
//  NOTA: NO necesitas manejar el parámetro "callback" de JSONP.
//  La app web ya fue actualizada para usar fetch() en lugar de JSONP.
// ═══════════════════════════════════════════════════════════════
