// ═══════════════════════════════════════════════════════════════
// railway/sos_whatsapp_route.js
//
// Agrega estas rutas a tu servidor Express existente en Railway.
//
// INSTRUCCIONES:
//   1. Copia este archivo a tu proyecto Railway.
//   2. En tu archivo principal (index.js / app.js) agrega:
//        import sosRoutes from './sos_whatsapp_route.js';
//        app.use('/', sosRoutes(client));   // "client" = tu instancia de whatsapp-web.js
//   3. En Railway → Variables, agrega:
//        SOS_API_KEY = sos_digital_secret_2025   ← usa el mismo valor que en whatsapp_config.php
//   4. Redeploy.
// ═══════════════════════════════════════════════════════════════

import express from 'express';

/**
 * @param {object} client  Instancia ya inicializada del bot
 */
export default function sosRoutes(client) {
  const router = express.Router();
  const API_KEY = process.env.SOS_API_KEY || 'sos_digital_secret_2025';

  // ── Middleware: verificar api_key ──────────────────────────────────────────
  function auth(req, res, next) {
    const key = req.body?.api_key || req.query?.api_key;
    if (key !== API_KEY) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
  }

  // ── GET /sos/ping  →  verifica que el bot esté conectado ──────────────────
  router.get('/sos/ping', (req, res) => {
    const estado = client.info ? 'conectado' : 'desconectado';
    res.json({ ok: !!client.info, estado });
  });

  // ── POST /sos/enviar  →  envía un mensaje de WhatsApp ─────────────────────
  //
  // Body JSON:
  //   { "telefono": "524491234567", "mensaje": "Hola...", "api_key": "..." }
  //
  router.post('/sos/enviar', auth, async (req, res) => {
    let { telefono, mensaje } = req.body;

    if (!telefono || !mensaje) {
      return res.json({ ok: false, error: 'Faltan campos: telefono, mensaje' });
    }

    // Limpiar número y armar chatId de WhatsApp
    telefono = String(telefono).replace(/\D/g, '');
    if (!telefono) {
      return res.json({ ok: false, error: 'Número de teléfono inválido' });
    }
    const chatId = `${telefono}@c.us`;

    try {
      // Verificar que el bot esté listo
      if (!client.info) {
        return res.json({ ok: false, error: 'El bot aún no está autenticado en WhatsApp' });
      }

      await client.sendMessage(chatId, mensaje);
      console.log(`[SOS] ✅ Mensaje enviado → ${telefono}`);
      res.json({ ok: true, telefono, chatId });

    } catch (err) {
      console.error(`[SOS] ❌ Error enviando a ${telefono}:`, err.message);
      res.json({ ok: false, error: err.message || 'Error al enviar mensaje' });
    }
  });

  // ── POST /sos/enviar-masivo  →  envía a múltiples números (para el cron) ──
  //
  // Body JSON:
  //   { "mensajes": [ { "telefono": "52...", "mensaje": "..." }, ... ], "api_key": "..." }
  //
  router.post('/sos/enviar-masivo', auth, async (req, res) => {
    const { mensajes } = req.body;

    if (!Array.isArray(mensajes) || mensajes.length === 0) {
      return res.json({ ok: false, error: 'Se espera un array "mensajes"' });
    }
    if (mensajes.length > 50) {
      return res.json({ ok: false, error: 'Máximo 50 mensajes por llamada' });
    }
    if (!client.info) {
      return res.json({ ok: false, error: 'Bot no autenticado' });
    }

    const resultados = [];
    for (const item of mensajes) {
      const tel    = String(item.telefono || '').replace(/\D/g, '');
      const texto  = item.mensaje || '';
      if (!tel || !texto) {
        resultados.push({ telefono: tel, ok: false, error: 'Datos incompletos' });
        continue;
      }
      try {
        await client.sendMessage(`${tel}@c.us`, texto);
        resultados.push({ telefono: tel, ok: true });
        // Pausa entre mensajes para no ser bloqueado por WA
        await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        resultados.push({ telefono: tel, ok: false, error: err.message });
      }
    }

    const exitosos = resultados.filter(r => r.ok).length;
    res.json({ ok: true, total: mensajes.length, exitosos, resultados });
  });

  return router;
}
