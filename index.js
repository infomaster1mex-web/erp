const { Client, LocalAuth } = require('whatsapp-web.js');
const express              = require('express');
const qrcode               = require('qrcode-terminal');
const qrcodeLib            = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_KEY = process.env.SOS_API_KEY || 'sos_digital_secret_2025';

// ── Estado global ─────────────────────────────────────────────
let botListo    = false;
let qrBase64    = null;
let ultimoError = null;
let intentos    = 0;

// ── Cliente WhatsApp ──────────────────────────────────────────
function crearCliente() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-accelerated-2d-canvas',
        '--disable-features=VizDisplayCompositor,site-per-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
      ],
    },
  });
}

let client = crearCliente();

function inicializar() {
  intentos++;
  console.log(`[WA] Intento ${intentos} de inicialización…`);

  client.on('qr', async (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('[WA] QR listo — ábrelo en la URL del bot');
    try { qrBase64 = await qrcodeLib.toDataURL(qr); } catch(e) {}
  });

  client.on('ready', () => {
    botListo    = true;
    qrBase64    = null;
    ultimoError = null;
    intentos    = 0;
    console.log('[WA] ✅ Bot listo:', client.info?.wid?.user);
  });

  client.on('authenticated', () => {
    console.log('[WA] ✅ Autenticado');
  });

  client.on('auth_failure', (msg) => {
    botListo    = false;
    ultimoError = msg;
    console.error('[WA] ❌ Auth failure:', msg);
    reintentar();
  });

  client.on('disconnected', (reason) => {
    botListo    = false;
    ultimoError = reason;
    console.warn('[WA] ⚠️ Desconectado:', reason);
    reintentar();
  });

  client.initialize().catch((err) => {
    console.error('[WA] Error en initialize:', err.message);
    ultimoError = err.message;
    reintentar();
  });
}

function reintentar() {
  const delay = Math.min(intentos * 5000, 30000); // máx 30 seg
  console.log(`[WA] Reintentando en ${delay/1000}s…`);
  setTimeout(() => {
    try { client.destroy().catch(()=>{}); } catch(e) {}
    client = crearCliente();
    inicializar();
  }, delay);
}

// ── Middleware auth ───────────────────────────────────────────
function auth(req, res, next) {
  const key = req.body?.api_key || req.query?.api_key || req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ── Rutas ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (botListo) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1 style="color:#25d366">✅ Bot SOS Digital Activo</h1>
        <p>Número conectado: <b>${client.info?.wid?.user || '—'}</b></p>
        <p style="color:#888">El bot está listo para enviar mensajes.</p>
      </body></html>
    `);
  }
  if (qrBase64) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
        <h1>📱 Escanea el QR con WhatsApp</h1>
        <p style="color:#aaa">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${qrBase64}" style="border:8px solid #fff;border-radius:12px;margin-top:16px" />
        <p style="color:#666;font-size:12px;margin-top:12px">Se refresca en 20 segundos si expira</p>
        <meta http-equiv="refresh" content="20">
      </body></html>
    `);
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:#fff">
      <h1>⏳ Iniciando bot...</h1>
      <p>Espera unos segundos y recarga.</p>
      ${ultimoError ? `<p style="color:#ff5c5c;font-size:12px">Último error: ${ultimoError}</p>` : ''}
      <meta http-equiv="refresh" content="5">
    </body></html>
  `);
});

app.get('/sos/ping', (req, res) => {
  res.json({ ok: botListo, estado: botListo ? 'conectado' : 'desconectado', numero: client.info?.wid?.user || null });
});

app.post('/sos/enviar', auth, async (req, res) => {
  let { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.json({ ok: false, error: 'Faltan campos' });
  telefono = String(telefono).replace(/\D/g, '');
  if (!botListo) return res.json({ ok: false, error: 'Bot no conectado aún' });
  try {
    await client.sendMessage(`${telefono}@c.us`, mensaje);
    console.log(`[SOS] ✅ Enviado → ${telefono}`);
    res.json({ ok: true, telefono });
  } catch (err) {
    console.error(`[SOS] ❌ Error → ${telefono}:`, err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.post('/sos/enviar-masivo', auth, async (req, res) => {
  const { mensajes } = req.body;
  if (!Array.isArray(mensajes) || !mensajes.length) return res.json({ ok: false, error: 'Se espera array mensajes' });
  if (!botListo) return res.json({ ok: false, error: 'Bot no conectado' });
  const resultados = [];
  for (const item of mensajes) {
    const tel = String(item.telefono || '').replace(/\D/g, '');
    try {
      await client.sendMessage(`${tel}@c.us`, item.mensaje);
      resultados.push({ telefono: tel, ok: true });
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      resultados.push({ telefono: tel, ok: false, error: err.message });
    }
  }
  res.json({ ok: true, total: mensajes.length, exitosos: resultados.filter(r=>r.ok).length, resultados });
});

// ── Arrancar ──────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[SERVER] 🚀 Puerto ${PORT}`));
inicializar();
