// ═══════════════════════════════════════════════════════════════
// index.js — Bot WhatsApp SOS Digital (Baileys — sin Chrome)
// ═══════════════════════════════════════════════════════════════
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
} from '@whiskeysockets/baileys';

import express from 'express';
import qrcode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ── ESM equivalente de __dirname ─────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.SOS_API_KEY || 'sos_digital_secret_2025';
const AUTH_DIR = path.join(__dirname, 'auth_info');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Estado global ─────────────────────────────────────────────
let sock      = null;
let botListo  = false;
let qrBase64  = null;
let numero    = null;

// ── Inicializar Baileys ───────────────────────────────────────
async function conectar() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['SOS Digital Bot', 'Chrome', '120.0'],
  });

  // ── Guardar credenciales ────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── QR ─────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WA] QR generado — ábrelo en la URL del bot');
      try { qrBase64 = await qrcode.toDataURL(qr); } catch(e) {}
      botListo = false;
    }

    if (connection === 'open') {
      botListo = true;
      qrBase64 = null;
      numero   = sock.user?.id?.split(':')[0] || sock.user?.id || null;
      console.log('[WA] ✅ Conectado como:', numero);
    }

    if (connection === 'close') {
      botListo = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconectar = code !== DisconnectReason.loggedOut;
      console.log('[WA] Desconectado. Código:', code, '— Reconectar:', reconectar);
      if (reconectar) {
        setTimeout(conectar, 5000);
      } else {
        console.log('[WA] Sesión cerrada — borra auth_info y reinicia para nuevo QR');
        // Borrar sesión corrupta para forzar nuevo QR
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e) {}
        setTimeout(conectar, 3000);
      }
    }
  });
}

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const key = req.body?.api_key || req.query?.api_key || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── Normalizar teléfono → JID de WhatsApp ────────────────────
function toJid(telefono) {
  const limpio = String(telefono).replace(/\D/g, '');
  return limpio + '@s.whatsapp.net';
}

// ── Rutas ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (botListo) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1 style="color:#25d366">✅ Bot SOS Digital Activo</h1>
        <p>Número: <b>+${numero || '—'}</b></p>
        <p style="color:#888">El bot está listo para enviar mensajes.</p>
      </body></html>
    `);
  }
  if (qrBase64) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1>📱 Escanea el QR con WhatsApp</h1>
        <p style="color:#aaa">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrBase64}" style="border:8px solid #fff;border-radius:12px;margin-top:16px;max-width:300px" />
        <p style="color:#666;font-size:12px;margin-top:12px">El QR expira en ~60 seg — recarga si expira</p>
        <meta http-equiv="refresh" content="30">
      </body></html>
    `);
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
      <h1>⏳ Iniciando bot...</h1>
      <p>Espera unos segundos y recarga.</p>
      <meta http-equiv="refresh" content="4">
    </body></html>
  `);
});

// Ping — PHP llama esto para saber si el bot está activo
app.get('/sos/ping', (req, res) => {
  res.json({ ok: botListo, estado: botListo ? 'conectado' : 'desconectado', numero: numero || null });
});

// Enviar mensaje individual
app.post('/sos/enviar', auth, async (req, res) => {
  let { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.json({ ok: false, error: 'Faltan campos: telefono, mensaje' });
  if (!botListo) return res.json({ ok: false, error: 'Bot no conectado — escanea el QR en /' });

  try {
    const jid = toJid(telefono);
    await sock.sendMessage(jid, { text: mensaje });
    console.log(`[SOS] ✅ Enviado → ${telefono}`);
    res.json({ ok: true, telefono });
  } catch (err) {
    console.error(`[SOS] ❌ Error → ${telefono}:`, err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Envío masivo (para el cron automático)
app.post('/sos/enviar-masivo', auth, async (req, res) => {
  const { mensajes } = req.body;
  if (!Array.isArray(mensajes) || !mensajes.length) return res.json({ ok: false, error: 'Se espera array mensajes' });
  if (!botListo) return res.json({ ok: false, error: 'Bot no conectado' });

  const resultados = [];
  for (const item of mensajes) {
    const tel = String(item.telefono || '').replace(/\D/g, '');
    try {
      await sock.sendMessage(toJid(tel), { text: item.mensaje });
      resultados.push({ telefono: tel, ok: true });
      await new Promise(r => setTimeout(r, 1000)); // pausa entre mensajes
    } catch (err) {
      resultados.push({ telefono: tel, ok: false, error: err.message });
    }
  }

  const exitosos = resultados.filter(r => r.ok).length;
  console.log(`[SOS] Masivo: ${exitosos}/${mensajes.length}`);
  res.json({ ok: true, total: mensajes.length, exitosos, resultados });
});

// ── Arrancar ──────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[SERVER] 🚀 Puerto ${PORT}`));
conectar().catch(console.error);
