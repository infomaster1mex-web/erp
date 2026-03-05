// ═══════════════════════════════════════════════════════════════
// index.js — Bot WhatsApp para SOS Digital
// Railway + whatsapp-web.js
// ═══════════════════════════════════════════════════════════════

const { Client, LocalAuth } = require('whatsapp-web.js');
const express              = require('express');
const qrcode               = require('qrcode-terminal');
const qrcodeLib            = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Parsear body JSON ──────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API Key (configúrala en Railway → Variables) ───────────────
const API_KEY = process.env.SOS_API_KEY || 'sos_digital_secret_2025';

// ═══════════════════════════════════════════════════════════════
// CLIENTE WHATSAPP
// ═══════════════════════════════════════════════════════════════
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  },
});

// Estado del bot
let botListo    = false;
let qrBase64    = null;   // para mostrarlo en el navegador
let ultimoError = null;

client.on('qr', async (qr) => {
  qrcode.generate(qr, { small: true });   // muestra en logs de Railway
  console.log('[WA] Escanea el QR en: https://TU-APP.railway.app/qr');
  try {
    qrBase64 = await qrcodeLib.toDataURL(qr);
  } catch (e) { qrBase64 = null; }
});

client.on('ready', () => {
  botListo    = true;
  qrBase64    = null;
  ultimoError = null;
  console.log('[WA] ✅ Bot conectado y listo:', client.info?.wid?.user);
});

client.on('authenticated', () => {
  console.log('[WA] ✅ Autenticado correctamente');
});

client.on('auth_failure', (msg) => {
  botListo    = false;
  ultimoError = msg;
  console.error('[WA] ❌ Fallo de autenticación:', msg);
});

client.on('disconnected', (reason) => {
  botListo    = false;
  ultimoError = reason;
  console.warn('[WA] ⚠️ Desconectado:', reason);
  // Intentar reconectar después de 10 segundos
  setTimeout(() => {
    console.log('[WA] Intentando reconectar…');
    client.initialize().catch(console.error);
  }, 10_000);
});

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE AUTH
// ═══════════════════════════════════════════════════════════════
function auth(req, res, next) {
  const key = req.body?.api_key || req.query?.api_key || req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// RUTAS
// ═══════════════════════════════════════════════════════════════

// Página de inicio con QR visual (para escanear fácil)
app.get('/', (req, res) => {
  if (botListo) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1 style="color:#25d366">✅ Bot SOS Digital Activo</h1>
        <p>Número: <b>${client.info?.wid?.user || '—'}</b></p>
        <p style="color:#888">El bot está listo para enviar mensajes.</p>
      </body></html>
    `);
  }
  if (qrBase64) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1>📱 Escanea el QR con WhatsApp</h1>
        <p style="color:#aaa">Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrBase64}" style="border:8px solid #fff;border-radius:12px;margin-top:16px" />
        <p style="color:#666;font-size:12px;margin-top:12px">El QR se refresca automáticamente — recarga la página si expiró</p>
        <meta http-equiv="refresh" content="20">
      </body></html>
    `);
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
      <h1>⏳ Iniciando bot…</h1>
      <p>Espera unos segundos y recarga.</p>
      <meta http-equiv="refresh" content="5">
    </body></html>
  `);
});

// Alias /qr para ver el QR directamente
app.get('/qr', (req, res) => res.redirect('/'));

// ── Ping (PHP llama esto para saber si el bot está vivo) ───────
app.get('/sos/ping', (req, res) => {
  res.json({
    ok:     botListo,
    estado: botListo ? 'conectado' : 'desconectado',
    numero: client.info?.wid?.user || null,
    error:  ultimoError || null,
  });
});

// ── Enviar un mensaje individual ───────────────────────────────
// POST /sos/enviar
// Body: { telefono, mensaje, api_key }
app.post('/sos/enviar', auth, async (req, res) => {
  let { telefono, mensaje } = req.body;

  if (!telefono || !mensaje) {
    return res.json({ ok: false, error: 'Faltan campos: telefono y mensaje' });
  }

  telefono = String(telefono).replace(/\D/g, '');
  if (telefono.length < 10) {
    return res.json({ ok: false, error: 'Número inválido: ' + telefono });
  }

  if (!botListo) {
    return res.json({ ok: false, error: 'Bot no conectado. Escanea el QR en /' });
  }

  try {
    const chatId = `${telefono}@c.us`;
    await client.sendMessage(chatId, mensaje);
    console.log(`[SOS] ✅ Enviado → ${telefono}`);
    res.json({ ok: true, telefono, chatId });
  } catch (err) {
    console.error(`[SOS] ❌ Error → ${telefono}:`, err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ── Envío masivo (para el cron de recordatorios) ───────────────
// POST /sos/enviar-masivo
// Body: { mensajes: [{telefono, mensaje}, ...], api_key }
app.post('/sos/enviar-masivo', auth, async (req, res) => {
  const { mensajes } = req.body;

  if (!Array.isArray(mensajes) || mensajes.length === 0) {
    return res.json({ ok: false, error: 'Se espera array "mensajes"' });
  }
  if (mensajes.length > 50) {
    return res.json({ ok: false, error: 'Máximo 50 mensajes por llamada' });
  }
  if (!botListo) {
    return res.json({ ok: false, error: 'Bot no conectado' });
  }

  const resultados = [];
  for (const item of mensajes) {
    const tel   = String(item.telefono || '').replace(/\D/g, '');
    const texto = item.mensaje || '';
    if (!tel || !texto) {
      resultados.push({ telefono: tel, ok: false, error: 'Datos incompletos' });
      continue;
    }
    try {
      await client.sendMessage(`${tel}@c.us`, texto);
      resultados.push({ telefono: tel, ok: true });
      // Pausa entre mensajes para no ser bloqueado por WhatsApp
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      resultados.push({ telefono: tel, ok: false, error: err.message });
    }
  }

  const exitosos = resultados.filter(r => r.ok).length;
  console.log(`[SOS] Masivo: ${exitosos}/${mensajes.length} enviados`);
  res.json({ ok: true, total: mensajes.length, exitosos, resultados });
});

// ═══════════════════════════════════════════════════════════════
// ARRANCAR
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`[SERVER] 🚀 Servidor en puerto ${PORT}`);
});

console.log('[WA] Iniciando cliente WhatsApp…');
client.initialize().catch((err) => {
  console.error('[WA] Error al inicializar:', err);
});
