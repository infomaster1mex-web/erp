# 🔌 Integración WhatsApp Bot — SOS Digital + Railway

## Qué hace esta integración

- **Botón "Aviso"** en el panel de renovaciones → envía el mensaje directo al cliente por WhatsApp (ya no abre solo el link wa.me).
- **Indicador de bot** en el toolbar → muestra 🟢 Bot activo / 🔴 Bot offline en tiempo real.
- **Cron automático** → envía 3 recordatorios por cliente:
  - 🔔 1 día **antes** de vencer
  - 🚨 El día **que vence**
  - ⛔ 1 día **después** (ya venció)

---

## Paso 1 — Railway (tu bot Node.js)

### 1.1 Copiar el archivo de rutas

Copia `railway/sos_whatsapp_route.js` a la raíz (o subcarpeta `routes/`) de tu proyecto Railway.

### 1.2 Registrar las rutas en tu app

En tu `index.js` o `app.js` principal, agrega:

```js
const sosRouter = require('./sos_whatsapp_route');

// Asegúrate de pasar "client" que es tu instancia de whatsapp-web.js
// Ejemplo:
//   const { Client } = require('whatsapp-web.js');
//   const client = new Client({ ... });
//   client.initialize();

app.use('/', sosRouter(client));
```

### 1.3 Variable de entorno en Railway

En el dashboard de Railway → tu servicio → **Variables**, agrega:

```
SOS_API_KEY = sos_digital_secret_2025
```

> ⚠️ Puedes cambiar el valor, pero debe ser **el mismo** que pongas en `includes/whatsapp_config.php`.

### 1.4 Probar el endpoint

```bash
curl https://TU-APP.railway.app/sos/ping
# → {"ok":true,"estado":"conectado"}

curl -X POST https://TU-APP.railway.app/sos/enviar \
  -H "Content-Type: application/json" \
  -d '{"telefono":"524491234567","mensaje":"Hola prueba","api_key":"sos_digital_secret_2025"}'
# → {"ok":true,"telefono":"524491234567"}
```

---

## Paso 2 — Hostinger (tu PHP)

Sube los siguientes archivos, respetando la ruta exacta:

| Archivo en el ZIP               | Destino en Hostinger                                      |
|---------------------------------|-----------------------------------------------------------|
| `php/includes/whatsapp_config.php` | `public_html/includes/whatsapp_config.php`             |
| `php/modulos/renovaciones/whatsapp_api.php` | `public_html/modulos/renovaciones/whatsapp_api.php` |
| `php/modulos/renovaciones/recordatorios.php` | `public_html/modulos/renovaciones/recordatorios.php` |
| `php/modulos/renovaciones/cron_recordatorios.php` | `public_html/modulos/renovaciones/cron_recordatorios.php` |
| `php/modulos/renovaciones/dashboard_renovaciones.php` | `public_html/modulos/renovaciones/dashboard_renovaciones.php` |

### 2.1 Editar la configuración

Abre `includes/whatsapp_config.php` y cambia:

```php
define('WA_BOT_URL', 'https://TU-APP.railway.app');  // ← tu URL de Railway
define('WA_API_KEY', 'sos_digital_secret_2025');      // ← igual que en Railway
```

---

## Paso 3 — Cron en Hostinger

Ve a **hPanel → Cron Jobs** y agrega:

```
Hora: 0 9 * * *     (todos los días a las 9 AM)
Comando: php /home/u[TUUSER]/public_html/modulos/renovaciones/cron_recordatorios.php
```

O si quieres ejecutarlo también en la tarde:
```
0 9,18 * * *
```

Para probar manualmente visita:
```
https://tudominio.com/modulos/renovaciones/cron_recordatorios.php?cron_key=infomaster_cron_2025
```

---

## Flujo completo

```
Hostinger Cron (PHP)
   └─► cron_recordatorios.php
         └─► whatsapp_api.php → POST https://TU-APP.railway.app/sos/enviar
                                       └─► client.sendMessage() → WhatsApp ✅

Panel Dashboard (usuario hace clic en "Aviso")
   └─► fetch recordatorios.php?accion=enviar_whatsapp
         └─► whatsapp_api.php → POST https://TU-APP.railway.app/sos/enviar
                                       └─► client.sendMessage() → WhatsApp ✅
```

---

## Notas importantes

- El bot de Railway debe estar **autenticado** (QR escaneado) para que funcione.
- Si el bot está offline, el botón "Aviso" mostrará el error y ofrecerá abrir **wa.me** como respaldo.
- Los envíos quedan registrados en la tabla `recordatorios` con estado `enviado` o `fallido`.
- El cron respeta el parámetro `DATEDIFF` — si hay días = -1 ya no filtra por `fecha_vencimiento >= CURDATE()`, así alcanza a los vencidos de ayer.
