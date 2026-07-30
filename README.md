# 🚗 Special CAR — FleetSync v2.1 (Supabase)

Sistema de disponibilidad y programación de flota con 4 roles, base de datos en Supabase, seguridad por fila (RLS), reportería con gráficas y mapa de calor.

## Roles

| Rol | Ingreso | Qué hace |
|---|---|---|
| **Administrador** | Email + contraseña | Configura **todo**: gestiona el equipo (crea/elimina/roles) y **carga la base diaria de conductores** desde el Excel de la plataforma (importar/exportar). Tiene acceso a todas las pantallas |
| **Conductor** | Placa + Documento | Sube su disponibilidad por franjas eligiendo con cuál de sus vehículos, reporta la ubicación GPS del vehículo, ve/cancela sus turnos |
| **Analista** | Email + contraseña | Valida disponibilidades (valida/rechaza), crea disponibilidades a nombre de conductores, registra conductores |
| **Coordinador de operaciones** | Email + contraseña | Programa los vehículos (asigna servicio/ruta/zona), administra vehículos y **vincula conductores a vehículos** |
| **Jefe de operación** | Email + contraseña | Reportería completa (KPIs, franjas, zonas, mapa de calor, sin asignar), administra vehículos y vincula conductores, y **gestiona el equipo: crea, elimina y cambia el rol de los empleados** |

## Modelo conductor ⟷ vehículo (muchos a muchos)

- Un **vehículo puede tener varios conductores**, pero la base de datos **rechaza** dos disponibilidades del mismo vehículo que se crucen en horario.
- Un **conductor puede operar varios vehículos**, pero la base de datos **rechaza** dos disponibilidades del mismo conductor que se crucen en horario (aunque sean vehículos distintos).
- Solo el **coordinador** y el **jefe de operación** pueden vincular/desvincular conductores de vehículos (página *Flota*).
- Estas reglas son *exclusion constraints* de Postgres: se cumplen aunque dos personas guarden al mismo tiempo, y la app muestra un mensaje claro (⛔ "ese vehículo/conductor ya tiene una disponibilidad que se cruza…").
- Los turnos **cancelados o rechazados liberan la franja** automáticamente.

## Instalación (15 minutos)

### 1. Crea el proyecto en Supabase
1. Entra a [supabase.com](https://supabase.com) → **New project** (plan gratuito sirve).
2. Espera a que el proyecto esté listo.

### 2. Ejecuta el esquema
1. Menú **SQL Editor** → **New query**.
2. Pega **todo** el contenido de `supabase/schema.sql` → **Run**.
3. Debe terminar sin errores. Esto crea tablas, roles, vistas, funciones y las políticas de seguridad (RLS).

### 3. Configura la autenticación y crea el equipo
1. **Authentication → Sign In / Providers → Email**: desactiva **"Confirm email"** (ni conductores ni staff necesitan confirmar correo).
2. Crea a los 6 empleados de una vez: **SQL Editor → New query**, pega `supabase/crear_equipo.sql` y **Run**. Esto crea a José (jefe), Christian, Miguel, Nataly, Claudia (coordinadores) y Juan (analista), todos con la contraseña temporal **`Special2026*`** (cámbiala dentro del archivo antes de correr, o pide que cada quien la cambie).

De ahí en adelante, **José gestiona el equipo desde la app** (menú "Equipo"): crear nuevos empleados, cambiar roles, restablecer contraseñas y eliminar. Para eso hay que desplegar una función segura (paso 3b).

### 3b. Desplegar la función de gestión de equipo
El jefe crea y elimina cuentas desde la app mediante una **Edge Function** (así la llave de administrador nunca queda expuesta en el navegador). Se instala una sola vez:

1. Instala el CLI de Supabase (en tu computador):
   - macOS: `brew install supabase/tap/supabase`
   - Windows (scoop): `scoop install supabase`
   - o vía npm: `npm install -g supabase`
2. En la carpeta del proyecto:
```bash
supabase login
supabase link --project-ref TU_PROJECT_REF     # el ref sale en Settings → General
supabase functions deploy gestionar-empleados --no-verify-jwt
```
3. Listo. La función usa automáticamente las llaves internas del proyecto (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`), que Supabase ya inyecta; no tienes que configurarlas.

> El `TU_PROJECT_REF` es el identificador corto del proyecto (ej. `abcdefghijklmno`), visible en la URL del dashboard y en Settings → General.
>
> Si aún no despliegas la función, todo lo demás funciona; solo el panel "Equipo" mostrará un aviso de que la función no está disponible.

> Los **conductores no se crean en Authentication**: el staff los registra en la app (página *Flota*), el coordinador o jefe los **vincula a uno o más vehículos**, y la cuenta se crea sola la primera vez que el conductor entra con **placa (de un vehículo vinculado) + documento**. Una persona = una cuenta, aunque opere varios vehículos.

### 4. Configura `config.js`
En Supabase: **Settings → API** → copia la URL y la `anon public` key:
```javascript
const APP_CONFIG = {
  SUPABASE_URL: "https://abcdefgh.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
  DRIVER_EMAIL_DOMAIN: "conductores.specialcar.app"
};
```
La `anon key` es pública por diseño: los datos están protegidos por RLS en la base de datos, no por ocultar la llave.

### 5. Publica
Sube `index.html`, `config.js`, `js/`, `assets/` a **GitHub Pages** (o Netlify/Vercel):
1. Repo público → Settings → Pages → Branch `main` → Save.
2. Tu app queda en `https://TU_USUARIO.github.io/NOMBRE_REPO/`.

> A diferencia de la versión anterior con Apps Script, **esta versión sí funciona en localhost** (no hay problemas de CORS ni JSONP).

## Flujo operativo

1. **Conductor** entra con placa + documento → sube disponibilidad (días + franja horaria, soporta turnos que cruzan medianoche) → reporta la ubicación GPS del vehículo.
2. **Analista** revisa la cola de *pendientes* → **Valida** o **Rechaza**. También puede crear disponibilidades por teléfono a nombre del conductor (quedan validadas de una vez).
3. **Coordinador** abre *Programación*, elige el día → asigna servicio/ruta y zona a cada disponibilidad validada. El contador rojo "Sin asignar" debe llegar a 0.
4. **Jefe de operación** abre *Centro de decisión* con el rango de fechas → ve cobertura (%), gráfica apilada por franja horaria (asignados vs sin asignar), gráfica por localidad, **mapa de calor** (concentración por zona o por GPS reportado) y la tabla de vehículos sin asignar para tomar decisiones con el equipo.

## Cargue diario de la base de conductores (rol Administrador)

El administrador entra a la pestaña **Base de datos** y:

- **⬆ Cargar documento del día:** sube el Excel `DocumentosAfiliados_*.xlsx` (el mismo que exporta tu plataforma actual, con columnas Empresa, Placa, Tipo, Nombre, Nro Identificacion, Nombre Documento, Inicio Vigencia, Vigente Hasta, Estado, Fecha - Hora Cargue, Usuario). El sistema **deriva automáticamente** los conductores (filas tipo *Conductor*), los vehículos (por placa), los vínculos conductor-vehículo y el estado de vigencia de cada documento. Es idempotente: volver a subir el mismo archivo no duplica nada; solo agrega lo nuevo y refresca la foto de documentos.
- **⬇ Descargar base actual:** exporta todos los documentos a un Excel con el mismo formato, para respaldo.
- **Tabla de vencimientos:** muestra los vehículos con documentos vencidos o sin cargar (SOAT, tecnomecánica, licencia, etc.), para no programar un vehículo con papeles al día.

### Cargue automático diario (opcional)

Si quieres que la base se actualice sola cada mañana sin que nadie suba el archivo, hay dos caminos:

1. **Si tu plataforma actual puede enviar el Excel a una URL o dejarlo en un storage** (Google Drive, S3, un FTP): se crea una segunda Edge Function programada con **pg_cron** que lo descarga y llama a `importar_cargue` cada día a una hora fija. Requiere que definamos de dónde sale el archivo automáticamente.
2. **Si el Excel solo se puede descargar manualmente** de tu plataforma: lo más práctico es el botón (10 segundos al día).

Para montar la opción 1 necesito saber cómo queda disponible el archivo cada día (¿lo genera un correo? ¿una URL? ¿un Drive?). Dímelo y preparo la función programada.

## Alerta de documentos antes de despachar

Con el cargue diario, el sistema sabe qué documentos de cada vehículo están **vencidos** o **sin cargar**. Los clasifica en dos grupos:

- **Críticos para circular** (bloquean el despacho): SOAT, revisión técnico-mecánica, revisión preventiva, licencia de conducción, seguro de responsabilidad civil, tarjeta de operación, exámenes médicos y planilla de seguridad social.
- **Administrativos** (solo advertencia): RUT, hoja de vida, contratos, etc.

La alerta aparece en varios puntos:

- **Programación (coordinador/admin):** cada vehículo pendiente muestra su estado documental. Si tiene un documento crítico vencido o sin cargar, la fila se marca en rojo y el botón cambia a "Despachar igual". Al intentar asignarlo, el modal muestra qué documentos faltan y **exige marcar una casilla de confirmación** ("despacho bajo mi responsabilidad") antes de continuar. La asignación queda marcada con la nota `[DESPACHADO CON DOCS PENDIENTES]` para trazabilidad.
- **Validación (analista):** cada disponibilidad muestra una etiqueta con su estado documental.
- **Reportería (jefe):** KPI "Con docs críticos" y una tabla de todos los vehículos del rango con documentos pendientes, con el detalle de cuáles.
- **Inicio (conductor):** si su vehículo tiene documentos críticos pendientes, se le avisa en sus próximos turnos para que lo reporte.

El bloqueo no es absoluto (operaciones puede despachar bajo su responsabilidad con la confirmación), pero nunca pasa desapercibido. Si prefieres que sea un bloqueo **total** (imposible asignar hasta regularizar), se puede endurecer con una sola línea; dime y lo cambio.

## Modelo de datos

```
profiles            (usuario ↔ rol: conductor, analista, coordinador, jefe, admin)
conductores         (persona: nombre, documento=PIN, teléfono, localidad, empresa)
vehiculos           (placa, tipo, número interno, localidad, empresa)
conductor_vehiculo  (vínculo M:N — lo administran coordinador, jefe y admin)
disponibilidades    (conductor + vehículo + inicio/fin — con restricciones de NO solapamiento)
asignaciones        (servicio, zona, notas — 1 por disponibilidad)
ubicaciones         (lat/lng por conductor y vehículo)
documentos          (foto diaria de vigencias: SOAT, tecnomecánica, licencia, etc.)
cargues             (auditoría de cada importación diaria)
```

El cargue diario del Excel alimenta `conductores`, `vehiculos`, `conductor_vehiculo` y `documentos` mediante la función `importar_cargue`, que solo pueden ejecutar admin y jefe.

Seguridad: cada tabla tiene **Row Level Security**. Un conductor solo ve y modifica lo suyo; el staff ve todo; solo el coordinador puede crear asignaciones; solo analista/coordinador validan. Todo se verifica en la base de datos, no en el navegador.

## Preguntas frecuentes

- **¿Cómo cambio el documento/PIN de un conductor que ya entró alguna vez?** Edita el documento en la app y además actualiza su usuario en Authentication → Users (su email interno es `c<documento>@conductores.specialcar.app`, la contraseña es `SC·` + documento).
- **¿Qué pasa si intento guardar un turno que se cruza?** La base de datos lo rechaza y la app muestra el motivo exacto (cruce por vehículo o cruce por conductor). Nunca quedan dobles reservas, ni siquiera con dos usuarios guardando a la vez.
- **Ya había ejecutado el esquema anterior y tengo datos.** Usa `supabase/migracion_v2_a_v2.1.sql` (separa vehículos, crea los vínculos y agrega las restricciones). Si el proyecto está vacío, mejor resetea la base y ejecuta `schema.sql` completo.
- **¿Puedo borrar los conductores de ejemplo?** Sí: elimina la sección "DATOS DE EJEMPLO" del `schema.sql` antes de ejecutarlo, o bórralos desde la app.
- **¿Tiempo real?** Los botones "↻ Actualizar" refrescan al instante. Si quieres actualizaciones automáticas, Supabase Realtime se puede activar después sin cambiar el esquema.
