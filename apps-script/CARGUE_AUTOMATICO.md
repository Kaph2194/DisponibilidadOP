# Cargue automático de FleetSync desde el portal SGT

Proyecto de Google Apps Script **propio de FleetSync** (independiente del módulo de Cartera de juridico@). Corre con la cuenta **directortransporte@specialcar.com.co**.

## Qué hace

A las **6:00, 12:00 y 17:00** (hora Colombia) entra al portal SGT, descarga los reportes y hace en FleetSync los mismos cargues que el administrador hace a mano:

| Reporte del portal | Filtros | Cargue en FleetSync |
|---|---|---|
| Documentos Afiliados | Empresa Todos · Estado Afiliados **Activos** · Detallado · Tipo documento Todos | Base de datos (`importar_cargue`) |
| Conductores Gral | Estado **Activos** | Conductores (`importar_conductores`) |
| Parque Automotor | Las 6 empresas · Estado vehículo **Activos** (se descartan inactivos) | Consolidado (`importar_consolidado`) |
| Cartera de Rodamientos | Fecha corte hoy · Empresa Todas · Estado **Activos** | Cartera (`importar_cartera`) |

- Cada ejecución hace **un** cargue y programa el siguiente un minuto después (Google limita cada ejecución a 6 minutos).
- Cada cargue queda en la hoja **"FleetSync - Registro de cargues automáticos"** y en la tabla `cargues` de FleetSync con el archivo `Automatico …`.
- Los Excel descargados se guardan 30 días en la carpeta de Drive **"FleetSync - Reportes del portal"** (de directortransporte@). **Nunca se suben a este repositorio**, que es público.
- Si un cargue falla, llega un correo a directortransporte@ (máximo uno por día).

## Instalación (una vez, ~10 minutos)

1. **Usuario de FleetSync para la integración:** el jefe de operación crea en **Equipo** un usuario, por ejemplo `integracion@specialcar.com.co`, con rol **Administrador** (o Jefe).
2. Con la sesión de **directortransporte@**, abrir <https://script.google.com> → **Nuevo proyecto** → nombre `FleetSync Cargue Automático`.
3. Pegar [`FleetSync.gs`](FleetSync.gs) en `Código.gs` y guardar.
4. ⚙️ **Configuración del proyecto** → activar *Mostrar el archivo de manifiesto "appsscript.json"* → en el editor reemplazar `appsscript.json` por [`appsscript.json`](appsscript.json) → guardar.
5. ⚙️ **Configuración del proyecto → Propiedades del script** → agregar:

   | Propiedad | Valor |
   |---|---|
   | `PORTAL_USUARIO` | correo con el que se entra al portal SGT |
   | `PORTAL_CLAVE` | contraseña del portal |
   | `FLEET_USUARIO` | el usuario de FleetSync del paso 1 |
   | `FLEET_CLAVE` | su contraseña |

6. En el editor elegir **`configurarTodo`** → **▶ Ejecutar** → aceptar los permisos marcando **Seleccionar todo**. Programa el cargue y prueba el ingreso a FleetSync.
7. Elegir **`probarCargue`** → **▶ Ejecutar**: hace los 4 cargues (uno por minuto). El resultado queda en la hoja de registro.

No se publica como aplicación web: solo corre con sus disparadores.

## Diagnóstico

Si un reporte del portal no se descarga, ejecutar su diagnóstico y revisar el *Registro de ejecución* (no muestra contraseñas):
`diagnosticarDocumentos`, `diagnosticarConductores`, `diagnosticarParque`, `diagnosticarCartera`.
Debe aparecer **"DESCARGA OK: …"**. Si dice "DESCARGA FALLÓ", las líneas de *Formulario* e *Intentos* muestran qué ve el script.

Para cambiar las horas: `CONFIG.HORAS` al inicio de `FleetSync.gs`, guardar y ejecutar de nuevo `configurarTodo`.
