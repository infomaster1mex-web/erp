// ═══════════════════════════════════════════════════════════════
// railway/sos_whatsapp_route.js  (ESM)
// ═══════════════════════════════════════════════════════════════

import express from 'express';

/**
 * @param {object} client  Instancia ya inicializada del bot
 */
export default function sosRoutes(client) {
  const router = express.Router();
  const API_KEY = process.env.SOS_API_KEY || 'sos_digital_secret_2025';

  function auth(req, res, next) {
    const key = req.body?.api_key || req.query?.api_key;
    if (key !== API_KEY) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
  }

  router.get('/sos/ping', (req, res) => {
    const estado = client.info ? 'conectado' : 'desconectado';
    res.json({ ok: !!client.info, estado });
  });

  router.post('/sos/enviar', auth, async (req, res) => {
    let { telefono, mensaje } = req.body;
    if (!telefono || !mensaje) {
      return res.json({ ok: false, error: 'Faltan campos: telefono, mensaje' });
    }
    telefono = String(telefono).replace(/\D/g, '');
    if (!telefono) {
      return res.json({ ok: false, error: 'Número de teléfono inválido' });
    }
    const chatId = `${telefono}@c.us`;
    try {
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
      const tel = String(item.telefono || '').replace(/\D/g, '');
      const texto = item.mensaje || '';
      if (!tel || !texto) {
        resultados.push({ telefono: tel, ok: false, error: 'Datos incompletos' });
        continue;
      }
      try {
        await client.sendMessage(`${tel}@c.us`, texto);
        resultados.push({ telefono: tel, ok: true });
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
