// ╔══════════════════════════════════════════════════════════╗
// ║  SPECIAL CAR — FleetSync v2  |  config.js                ║
// ║  Único archivo que debes editar antes de publicar.       ║
// ║  Los datos están en: Supabase → Settings → API           ║
// ╚══════════════════════════════════════════════════════════╝

const APP_CONFIG = {
  // URL del proyecto, ej: https://abcdefgh.supabase.co
  SUPABASE_URL: "https://yaeknutbljjeetukhefq.supabase.co/rest/v1/",

  // anon public key (es segura de publicar: RLS protege los datos)
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhZWtudXRibGpqZWV0dWtoZWZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNjU3NzUsImV4cCI6MjEwMDk0MTc3NX0.ghq4dafj5X1iEt-4_LAWSRaIuxABBorKmo49VXoRsg8",

  // Dominio sintético para las cuentas de conductores (no cambiar tras el primer uso)
  DRIVER_EMAIL_DOMAIN: "conductores.specialcar.com.co"
};
