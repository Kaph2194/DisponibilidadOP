// ══════════════════════════════════════════════════════════════
//  Edge Function: gestionar-empleados
//  Solo el "jefe de operación" puede crear, eliminar y cambiar el
//  rol de empleados de staff (coordinador, analista, jefe).
//  La service_role key vive SOLO aquí (servidor), nunca en el navegador.
// ══════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const ROLES_STAFF = ['coordinador', 'analista', 'jefe', 'admin'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const SUPABASE_URL      = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const ANON_KEY          = Deno.env.get('SUPABASE_ANON_KEY');

  // Cliente admin (poderes totales) — solo en el servidor
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1) Verificar quién llama, usando su propio token
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return json({ error: 'Falta autenticación.' }, 401);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } }
  });
  const { data: { user }, error: uErr } = await asUser.auth.getUser(token);
  if (uErr || !user) return json({ error: 'Sesión inválida.' }, 401);

  // 2) El que llama DEBE ser jefe o admin
  const { data: perfil } = await admin
    .from('profiles').select('role').eq('id', user.id).single();
  if (!perfil || !['jefe', 'admin'].includes(perfil.role))
    return json({ error: 'Solo el jefe de operación o el administrador pueden gestionar empleados.' }, 403);

  // 3) Ejecutar la acción
  let payload;
  try { payload = await req.json(); }
  catch { return json({ error: 'Cuerpo inválido.' }, 400); }
  const { action } = payload;

  try {
    // ── Listar empleados de staff ──
    if (action === 'list') {
      const { data: perfiles } = await admin
        .from('profiles').select('id, role, full_name')
        .in('role', ROLES_STAFF);
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const emails = Object.fromEntries((list?.users || []).map(u => [u.id, u.email]));
      const empleados = (perfiles || []).map(p => ({
        id: p.id, role: p.role, full_name: p.full_name, email: emails[p.id] || ''
      })).sort((a, b) => a.full_name.localeCompare(b.full_name));
      return json({ ok: true, empleados });
    }

    // ── Crear empleado ──
    if (action === 'create') {
      const { email, password, full_name, role } = payload;
      if (!email || !password || !role) return json({ error: 'Faltan email, contraseña o rol.' }, 400);
      if (!ROLES_STAFF.includes(role)) return json({ error: 'Rol no válido.' }, 400);
      if (password.length < 6) return json({ error: 'La contraseña debe tener al menos 6 caracteres.' }, 400);

      const { data: created, error } = await admin.auth.admin.createUser({
        email: email.trim().toLowerCase(),
        password,
        email_confirm: true,
        user_metadata: { role, full_name: full_name || '' }
      });
      if (error) return json({ error: error.message }, 400);

      // Asegurar el perfil con el rol correcto (por si el trigger no corrió aún)
      await admin.from('profiles').upsert({
        id: created.user.id, role, full_name: full_name || ''
      });
      return json({ ok: true, id: created.user.id });
    }

    // ── Cambiar rol ──
    if (action === 'setRole') {
      const { target_id, role } = payload;
      if (!target_id || !ROLES_STAFF.includes(role)) return json({ error: 'Datos inválidos.' }, 400);
      // Evitar quedarse sin ningún jefe ni admin
      if (!['jefe', 'admin'].includes(role)) {
        const { count } = await admin.from('profiles')
          .select('id', { count: 'exact', head: true }).in('role', ['jefe', 'admin']);
        if (count <= 1 && target_id === user.id)
          return json({ error: 'No puedes quitarte el rol: eres el único jefe/admin.' }, 400);
      }
      await admin.from('profiles').update({ role }).eq('id', target_id);
      await admin.auth.admin.updateUserById(target_id, { user_metadata: { role } });
      return json({ ok: true });
    }

    // ── Restablecer contraseña ──
    if (action === 'resetPassword') {
      const { target_id, password } = payload;
      if (!target_id || !password || password.length < 6)
        return json({ error: 'Contraseña inválida (mínimo 6 caracteres).' }, 400);
      const { error } = await admin.auth.admin.updateUserById(target_id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ── Eliminar empleado ──
    if (action === 'delete') {
      const { target_id } = payload;
      if (!target_id) return json({ error: 'Falta el empleado a eliminar.' }, 400);
      if (target_id === user.id) return json({ error: 'No puedes eliminar tu propia cuenta.' }, 400);
      const { error } = await admin.auth.admin.deleteUser(target_id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'Acción desconocida: ' + action }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
