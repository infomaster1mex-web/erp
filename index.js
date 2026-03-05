// ═══════════════════════════════════════════════════════════════
// index.js — SOS Digital WhatsApp Multi-Bot (Baileys)
// Sesiones: avisos | campañas | grupos | respaldo1 | respaldo2
// ═══════════════════════════════════════════════════════════════
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

import express from 'express';
import qrcode from 'qrcode';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.SOS_API_KEY || 'sos_digital_secret_2025';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '';  // Tu WhatsApp personal (ej: 524491234567)

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Configuración de sesiones ────────────────────────────────
const SESIONES_CONFIG = {
  avisos:    { nombre: 'Avisos & Recordatorios', color: '#00d4ff', autoReply: false },
  campanas:  { nombre: 'Campañas & Marketing',   color: '#ff6b35', autoReply: false },
  grupos:    { nombre: 'Publicador de Grupos',    color: '#a855f7', autoReply: false },
  respaldo1: {
    nombre: 'Respaldo 1', color: '#6ee7b7', autoReply: true,
    autoMsg: '¡Hola! 👋 Este número es solo para *avisos automáticos*.\n\nPara atención personalizada escríbenos a nuestro número principal:\n📱 *{{ADMIN_PHONE}}*\n\n— SOS Digital 🌟'
  },
  respaldo2: {
    nombre: 'Respaldo 2', color: '#fbbf24', autoReply: true,
    autoMsg: '¡Hola! 👋 Este número es solo para *avisos automáticos*.\n\nPara atención personalizada escríbenos a nuestro número principal:\n📱 *{{ADMIN_PHONE}}*\n\n— SOS Digital 🌟'
  },
};

// ── Estado global por sesión ─────────────────────────────────
const sesiones = {};
for (const id of Object.keys(SESIONES_CONFIG)) {
  sesiones[id] = { sock: null, listo: false, qr: null, numero: null, reconectando: false };
}

// ── Crear/conectar una sesión ────────────────────────────────
async function conectarSesion(sesionId) {
  const cfg  = SESIONES_CONFIG[sesionId];
  const s    = sesiones[sesionId];
  if (!cfg) return;

  const authDir = path.join(__dirname, 'auth_info', sesionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version }          = await fetchLatestBaileysVersion();

  s.sock = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: [`SOS ${cfg.nombre}`, 'Chrome', '120.0'],
  });

  s.sock.ev.on('creds.update', saveCreds);

  s.sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${sesionId}] QR generado`);
      try { s.qr = await qrcode.toDataURL(qr); } catch(e) {}
      s.listo = false;
    }

    if (connection === 'open') {
      s.listo = true;
      s.qr    = null;
      s.reconectando = false;
      s.numero = s.sock.user?.id?.split(':')[0] || null;
      console.log(`[${sesionId}] ✅ Conectado: ${s.numero}`);
    }

    if (connection === 'close') {
      s.listo = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconectar = code !== DisconnectReason.loggedOut;
      console.log(`[${sesionId}] Desconectado. Código: ${code}`);
      if (reconectar && !s.reconectando) {
        s.reconectando = true;
        setTimeout(() => conectarSesion(sesionId), 5000);
      } else if (!reconectar) {
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
        setTimeout(() => conectarSesion(sesionId), 3000);
      }
    }
  });

  // ── Auto-reply para sesiones de respaldo ──────────────────
  if (cfg.autoReply) {
    s.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.includes('@g.us') || jid.includes('status@')) continue;

        // Solo responder una vez por hora al mismo número
        const cacheKey = `${sesionId}:${jid}`;
        if (!global._autoReplyCache) global._autoReplyCache = {};
        const now = Date.now();
        if (global._autoReplyCache[cacheKey] && now - global._autoReplyCache[cacheKey] < 3600000) continue;
        global._autoReplyCache[cacheKey] = now;

        const adminPhone = ADMIN_PHONE || 'nuestro número principal';
        const texto = cfg.autoMsg.replace(/\{\{ADMIN_PHONE\}\}/g, adminPhone);
        try {
          await s.sock.sendMessage(jid, { text: texto });
          console.log(`[${sesionId}] Auto-reply → ${jid.split('@')[0]}`);
        } catch(e) {
          console.error(`[${sesionId}] Error auto-reply:`, e.message);
        }
      }
    });
  }
}

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const key = req.body?.api_key || req.query?.api_key || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── Normalizar teléfono ──────────────────────────────────────
function toJid(tel) {
  return String(tel).replace(/\D/g, '') + '@s.whatsapp.net';
}

// ═══════════════════════════════════════════════════════════════
//  RUTAS — PANEL WEB
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  let html = `
  <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SOS Digital — WhatsApp Hub</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',sans-serif;background:#0a0a0a;color:#fff;padding:24px}
    h1{text-align:center;font-size:1.6rem;margin-bottom:24px;color:#00d4ff}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;max-width:1000px;margin:0 auto}
    .card{background:#111;border:1px solid #222;border-radius:12px;padding:18px;position:relative;overflow:hidden}
    .card-accent{position:absolute;top:0;left:0;right:0;height:3px}
    .card h2{font-size:.95rem;margin:6px 0}
    .card .status{font-size:.8rem;margin-bottom:10px}
    .card .numero{font-size:.75rem;color:#888}
    .qr-img{display:block;max-width:200px;margin:10px auto;border:4px solid #fff;border-radius:8px}
    .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:.72rem;font-weight:700}
    .badge-on{background:rgba(0,229,160,.15);color:#6ee7b7}
    .badge-off{background:rgba(255,92,92,.15);color:#fca5a5}
    .badge-qr{background:rgba(255,184,0,.15);color:#fde68a}
    a.btn{display:inline-block;margin-top:8px;padding:6px 14px;border-radius:6px;font-size:.78rem;color:#fff;text-decoration:none;border:1px solid #333}
    a.btn:hover{background:#222}
  </style>
  <meta http-equiv="refresh" content="15">
  </head><body>
  <h1>📱 SOS Digital — WhatsApp Hub</h1>
  <div class="grid">`;

  for (const [id, cfg] of Object.entries(SESIONES_CONFIG)) {
    const s = sesiones[id];
    let statusBadge, extra = '';
    if (s.listo) {
      statusBadge = `<span class="badge badge-on">✅ Conectado</span>`;
      extra = `<div class="numero">+${s.numero || '—'}</div>`;
    } else if (s.qr) {
      statusBadge = `<span class="badge badge-qr">📱 Escanea QR</span>`;
      extra = `<img class="qr-img" src="${s.qr}" alt="QR ${id}">`;
    } else {
      statusBadge = `<span class="badge badge-off">⏳ Iniciando...</span>`;
    }

    html += `
    <div class="card">
      <div class="card-accent" style="background:${cfg.color}"></div>
      <h2>${cfg.nombre}</h2>
      <div class="status">${statusBadge}</div>
      ${extra}
      <a class="btn" href="/sesion/${id}/desconectar?api_key=${API_KEY}">🔄 Reconectar</a>
    </div>`;
  }

  html += `</div></body></html>`;
  res.send(html);
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS — API GENERAL
// ═══════════════════════════════════════════════════════════════

// Estado de todas las sesiones
app.get('/sos/status', (req, res) => {
  const estado = {};
  for (const [id, s] of Object.entries(sesiones)) {
    estado[id] = {
      nombre: SESIONES_CONFIG[id].nombre,
      listo:  s.listo,
      numero: s.numero,
      tieneQR: !!s.qr,
    };
  }
  res.json({ ok: true, sesiones: estado });
});

// Ping individual (compatible con el sistema anterior)
app.get('/sos/ping', (req, res) => {
  const s = sesiones.avisos;
  res.json({ ok: s.listo, estado: s.listo ? 'conectado' : 'desconectado', numero: s.numero || null });
});

// Estado de una sesión específica
app.get('/sesion/:id/status', (req, res) => {
  const s = sesiones[req.params.id];
  if (!s) return res.json({ ok: false, error: 'Sesión no existe' });
  res.json({ ok: s.listo, numero: s.numero, tieneQR: !!s.qr });
});

// Reconectar sesión (borra auth y reconecta)
app.get('/sesion/:id/desconectar', auth, async (req, res) => {
  const id = req.params.id;
  const s = sesiones[id];
  if (!s) return res.json({ ok: false, error: 'Sesión no existe' });

  try {
    if (s.sock) { s.sock.end(); s.sock = null; }
    s.listo = false; s.qr = null; s.numero = null;
    const authDir = path.join(__dirname, 'auth_info', id);
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
    setTimeout(() => conectarSesion(id), 1000);
    res.redirect('/');
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS — ENVÍO (Avisos - compatible con sistema anterior)
// ═══════════════════════════════════════════════════════════════
app.post('/sos/enviar', auth, async (req, res) => {
  let { telefono, mensaje, sesion } = req.body;
  const sesionId = sesion || 'avisos';
  const s = sesiones[sesionId];

  if (!s) return res.json({ ok: false, error: `Sesión ${sesionId} no existe` });
  if (!telefono || !mensaje) return res.json({ ok: false, error: 'Faltan campos: telefono, mensaje' });
  if (!s.listo) return res.json({ ok: false, error: `Bot ${sesionId} no conectado` });

  try {
    await s.sock.sendMessage(toJid(telefono), { text: mensaje });
    console.log(`[${sesionId}] ✅ Enviado → ${telefono}`);
    res.json({ ok: true, telefono, sesion: sesionId });
  } catch (err) {
    console.error(`[${sesionId}] ❌ Error → ${telefono}:`, err.message);
    res.json({ ok: false, error: err.message });
  }
});

// Envío masivo (compatible)
app.post('/sos/enviar-masivo', auth, async (req, res) => {
  const { mensajes, sesion } = req.body;
  const sesionId = sesion || 'avisos';
  const s = sesiones[sesionId];

  if (!s) return res.json({ ok: false, error: `Sesión ${sesionId} no existe` });
  if (!Array.isArray(mensajes) || !mensajes.length) return res.json({ ok: false, error: 'Se espera array mensajes' });
  if (!s.listo) return res.json({ ok: false, error: 'Bot no conectado' });

  const resultados = [];
  for (const item of mensajes) {
    const tel = String(item.telefono || '').replace(/\D/g, '');
    try {
      await s.sock.sendMessage(toJid(tel), { text: item.mensaje });
      resultados.push({ telefono: tel, ok: true });
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      resultados.push({ telefono: tel, ok: false, error: err.message });
    }
  }

  const exitosos = resultados.filter(r => r.ok).length;
  console.log(`[${sesionId}] Masivo: ${exitosos}/${mensajes.length}`);
  res.json({ ok: true, total: mensajes.length, exitosos, resultados });
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS — CAMPAÑAS (Marketing)
// ═══════════════════════════════════════════════════════════════

// Enviar campaña de texto a lista de números
app.post('/campana/enviar', auth, async (req, res) => {
  const { numeros, mensaje, imagen_url, sesion } = req.body;
  const sesionId = sesion || 'campanas';
  const s = sesiones[sesionId];

  if (!s) return res.json({ ok: false, error: `Sesión ${sesionId} no existe` });
  if (!Array.isArray(numeros) || !numeros.length) return res.json({ ok: false, error: 'Se espera array numeros' });
  if (!mensaje && !imagen_url) return res.json({ ok: false, error: 'Falta mensaje o imagen' });
  if (!s.listo) return res.json({ ok: false, error: `Bot campañas no conectado` });

  const resultados = [];
  let exitosos = 0;

  for (const tel of numeros) {
    const limpio = String(tel).replace(/\D/g, '');
    if (!limpio) { resultados.push({ telefono: tel, ok: false, error: 'Número vacío' }); continue; }

    try {
      if (imagen_url && mensaje) {
        // Imagen con caption
        await s.sock.sendMessage(toJid(limpio), {
          image: { url: imagen_url },
          caption: mensaje
        });
      } else if (imagen_url) {
        // Solo imagen
        await s.sock.sendMessage(toJid(limpio), {
          image: { url: imagen_url }
        });
      } else {
        // Solo texto
        await s.sock.sendMessage(toJid(limpio), { text: mensaje });
      }
      resultados.push({ telefono: limpio, ok: true });
      exitosos++;
      // Pausa anti-ban: 1.5-3 seg random
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
    } catch (err) {
      resultados.push({ telefono: limpio, ok: false, error: err.message });
    }
  }

  console.log(`[campana] ${exitosos}/${numeros.length} enviados`);
  res.json({ ok: true, total: numeros.length, exitosos, fallidos: numeros.length - exitosos, resultados });
});

// Enviar imagen desde base64
app.post('/campana/enviar-imagen', auth, async (req, res) => {
  const { numeros, mensaje, imagen_base64, sesion } = req.body;
  const sesionId = sesion || 'campanas';
  const s = sesiones[sesionId];

  if (!s?.listo) return res.json({ ok: false, error: `Bot ${sesionId} no conectado` });
  if (!Array.isArray(numeros) || !numeros.length) return res.json({ ok: false, error: 'Se espera array numeros' });
  if (!imagen_base64) return res.json({ ok: false, error: 'Falta imagen_base64' });

  const imgBuffer = Buffer.from(imagen_base64, 'base64');
  const resultados = [];
  let exitosos = 0;

  for (const tel of numeros) {
    const limpio = String(tel).replace(/\D/g, '');
    if (!limpio) continue;
    try {
      const msgPayload = { image: imgBuffer };
      if (mensaje) msgPayload.caption = mensaje;
      await s.sock.sendMessage(toJid(limpio), msgPayload);
      resultados.push({ telefono: limpio, ok: true });
      exitosos++;
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
    } catch (err) {
      resultados.push({ telefono: limpio, ok: false, error: err.message });
    }
  }

  res.json({ ok: true, total: numeros.length, exitosos, fallidos: numeros.length - exitosos, resultados });
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS — GRUPOS
// ═══════════════════════════════════════════════════════════════

// Obtener lista de grupos
app.get('/grupos/lista', auth, async (req, res) => {
  const sesionId = req.query.sesion || 'grupos';
  const s = sesiones[sesionId];
  if (!s?.listo) return res.json({ ok: false, error: 'Bot grupos no conectado' });

  try {
    const groups = await s.sock.groupFetchAllParticipating();
    const lista = Object.values(groups).map(g => ({
      id:           g.id,
      nombre:       g.subject,
      participantes: g.participants?.length || 0,
      descripcion:  g.desc || '',
    }));
    res.json({ ok: true, grupos: lista, total: lista.length });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Enviar mensaje a grupos
app.post('/grupos/enviar', auth, async (req, res) => {
  const { grupo_ids, mensaje, imagen_url, imagen_base64, sesion } = req.body;
  const sesionId = sesion || 'grupos';
  const s = sesiones[sesionId];

  if (!s?.listo) return res.json({ ok: false, error: 'Bot grupos no conectado' });
  if (!Array.isArray(grupo_ids) || !grupo_ids.length) return res.json({ ok: false, error: 'Se espera array grupo_ids' });

  const resultados = [];
  let exitosos = 0;

  for (const gid of grupo_ids) {
    try {
      if (imagen_base64) {
        const buf = Buffer.from(imagen_base64, 'base64');
        const payload = { image: buf };
        if (mensaje) payload.caption = mensaje;
        await s.sock.sendMessage(gid, payload);
      } else if (imagen_url) {
        const payload = { image: { url: imagen_url } };
        if (mensaje) payload.caption = mensaje;
        await s.sock.sendMessage(gid, payload);
      } else {
        await s.sock.sendMessage(gid, { text: mensaje });
      }
      resultados.push({ grupo: gid, ok: true });
      exitosos++;
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
    } catch (err) {
      resultados.push({ grupo: gid, ok: false, error: err.message });
    }
  }

  res.json({ ok: true, total: grupo_ids.length, exitosos, resultados });
});

// ═══════════════════════════════════════════════════════════════
//  ARRANCAR TODAS LAS SESIONES
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`[SERVER] 🚀 Puerto ${PORT}`);
  console.log(`[SERVER] Sesiones configuradas: ${Object.keys(SESIONES_CONFIG).join(', ')}`);
});

// Iniciar sesiones con delay entre cada una para no saturar
(async () => {
  const ids = Object.keys(SESIONES_CONFIG);
  for (let i = 0; i < ids.length; i++) {
    console.log(`[BOOT] Iniciando sesión: ${ids[i]}...`);
    await conectarSesion(ids[i]).catch(e => console.error(`[BOOT] Error ${ids[i]}:`, e.message));
    if (i < ids.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  console.log('[BOOT] ✅ Todas las sesiones iniciadas');
})();
