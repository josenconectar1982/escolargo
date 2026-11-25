# EscolarGo

**Tu hijo en ruta, tú en tranquilidad.**

EscolarGo sirve para seguir en tiempo real las rutas escolares. Tiene tres perfiles:

- **Padres:** ven el bus en el mapa, saben cuánto falta para que llegue y reciben avisos cuando la ruta arranca, cuando el bus está cerca y cuando su hijo sube, llega al colegio o baja en casa. Pueden marcar "Hoy no va" y escribirle a la auxiliar.
- **Auxiliar de ruta:** es la responsable de los estudiantes. Inicia la ruta (mañana o tarde), comparte el GPS de su celular, marca a cada estudiante como subió, bajó o no salió, reporta retrasos, tiene un botón de pánico y chatea con los padres.
- **Colegio:** tiene un panel con todas las rutas en vivo, alertas (retrasos, exceso de velocidad, emergencias, rutas sin auxiliar), vencimientos del SOAT y de la revisión técnico-mecánica, y puede leer todas las conversaciones.

Es una **app web instalable (PWA)**: se abre desde el navegador del celular y se agrega a la pantalla de inicio. No necesita Play Store ni App Store para las pruebas.

## Cuentas de prueba

La contraseña de todas es `demo1234`.

| Usuario | Perfil |
|---|---|
| `laura` | Mamá de Valentina e Isabella |
| `andres` | Papá de Tomás |
| `camila` | Mamá de Samuel |
| `marcela` | Auxiliar de la Ruta 07 |
| `colegio` | Coordinación de transporte |

Los datos de ejemplo son de **Cali**: el colegio está en Pance y las paradas en Capri, El Ingenio y Ciudad Jardín.

**Cómo probarlo sin manejar:** entra como `marcela`, inicia la ruta y toca **"Modo prueba: simular recorrido"**. El bus se mueve por las paradas. En otro celular o en otra pestaña, entra como `laura` y mira cómo llegan los avisos.

## Correrlo en tu computador

Necesitas Node.js 22.5 o superior. Localmente usa SQLite, que ya viene en Node, así que no hace falta instalar ninguna base de datos.

```bash
npm install
npm start
# abre http://localhost:3000
```

## Publicarlo gratis en Render

1. Sube este repositorio a GitHub.
2. En Render elige **New → Blueprint**, selecciona el repositorio y Render crea el servidor y la base de datos Postgres a partir de `render.yaml`.
3. Genera las llaves para las notificaciones push con `node scripts/vapid.js` y pega los dos valores en las variables `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` del servicio.

Límites del plan gratis de Render:

- El servidor se duerme después de 15 minutos sin uso, y la primera visita después de eso tarda unos 30 a 60 segundos en despertarlo.
- La base de datos Postgres gratis vence a los 30 días. Para un piloto real con un colegio, pasa al plan pago más básico.

## Notificaciones

- Con la app abierta, los avisos llegan al instante.
- Con la app cerrada, llegan como notificaciones push si el usuario tocó **"Activar notificaciones"** (en la campana). En Android funciona desde Chrome. En iPhone, primero hay que **agregar la app a la pantalla de inicio** (Compartir → Agregar a inicio) y abrirla desde ahí.

## Tecnología

- Servidor en Node.js sin frameworks, con Server-Sent Events para el tiempo real.
- Postgres en producción y SQLite para pruebas locales.
- Mapa con Leaflet y OpenStreetMap, que son gratis y no piden llave.
- Push con el estándar Web Push (llaves VAPID).

## Privacidad

La app maneja datos de menores, por eso:

- Cada padre ve solo a sus hijos y su parada, nunca las direcciones de otros niños.
- El chat es solo entre cada padre y la auxiliar de su ruta. No hay grupos entre padres, y el colegio puede leer las conversaciones como respaldo.
- Antes de usarla con familias reales, el colegio debe recoger la autorización de tratamiento de datos (Ley 1581 de 2012) y publicar una política de privacidad.

## Próximos pasos

- Panel para que el colegio cree rutas, estudiantes y padres (por ahora se cargan con los datos de demo).
- Entrega segura con código o QR del acudiente.
- Historial y reportes por fecha.
- Apps nativas para Play Store y App Store.
