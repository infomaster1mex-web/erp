// ═══════════════════════════════════════════════════════════════
// index.js — SOS Digital WhatsApp Multi-Bot (Baileys)
// Sesiones: avisos | campanas | grupos | respaldo1 | respaldo2 | personal
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
const API_KEY     = process.env.SOS_API_KEY    || 'sos_digital_secret_2025';
const OPENAI_KEY  = process.env.OPENAI_API_KEY || '';
const ADMIN_PHONE = process.env.ADMIN_PHONE    || '';
const CMD_PHONE   = process.env.CMD_PHONE      || ADMIN_PHONE;
const CMD_SESION  = process.env.CMD_SESION     || 'grupos';

// ═══════════════════════════════════════════════════════════════
//  AGENTE DE MARKETING IA — Memoria persistente + Programación
// ═══════════════════════════════════════════════════════════════

const MEMORIA_FILE   = path.join(__dirname, 'auth_info', 'marketing_memoria.json');
const SCHEDULES_FILE = path.join(__dirname, 'auth_info', 'marketing_schedules.json');

// ── Memoria persistente ─────────────────────────────────────
// Guarda: historial de promos enviadas, plantillas, notas
function cargarMemoria() {
  try {
    if (fs.existsSync(MEMORIA_FILE)) return JSON.parse(fs.readFileSync(MEMORIA_FILE, 'utf8'));
  } catch(e) {}
  return { promos: [], plantillas: [], notas: [] };
}

function guardarMemoria(mem) {
  try {
    fs.mkdirSync(path.dirname(MEMORIA_FILE), { recursive: true });
    fs.writeFileSync(MEMORIA_FILE, JSON.stringify(mem, null, 2));
  } catch(e) { console.error('[MEM] Error guardando:', e.message); }
}

function registrarPromoEnviada(caption, destino, grupos = 0) {
  const mem = cargarMemoria();
  mem.promos.push({
    fecha: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
    caption: caption.slice(0, 200),
    destino,
    grupos,
  });
  if (mem.promos.length > 100) mem.promos = mem.promos.slice(-100);
  guardarMemoria(mem);
}

function guardarPlantilla(nombre, caption) {
  const mem = cargarMemoria();
  const idx = mem.plantillas.findIndex(p => p.nombre === nombre);
  if (idx >= 0) mem.plantillas[idx] = { nombre, caption };
  else mem.plantillas.push({ nombre, caption });
  guardarMemoria(mem);
}

// ── Schedules persistentes ──────────────────────────────────
function cargarSchedules() {
  try {
    if (fs.existsSync(SCHEDULES_FILE)) return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch(e) {}
  return [];
}

function guardarSchedules(schedules) {
  try {
    fs.mkdirSync(path.dirname(SCHEDULES_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  } catch(e) {}
}

// Map de timers activos para poder cancelarlos
const timersActivos = new Map();

// ── Historial de conversación ───────────────────────────────
const adminChat = [];

// Estado de ejecución pendiente
const adminPending = {
  accion: null,
  imgBuffer: null,
  videoBuffer: null,
  mediaType: null,
};

// ── Buffer de múltiples archivos ────────────────────────────
// Acumula imágenes/videos enviados en ráfaga (ej: 3 fotos a la vez)
// WhatsApp los manda como mensajes separados en rápida sucesión
const mediaBuffer = {
  items: [],      // [{buffer, mediaType}]
  texto: '',      // texto del último mensaje con media o del mensaje de texto que sigue
  timer: null,    // setTimeout para procesar cuando termina la ráfaga
  DELAY_MS: 4500, // espera 4.5s desde el último archivo antes de procesar
};

function resetMediaBuffer() {
  if (mediaBuffer.timer) clearTimeout(mediaBuffer.timer);
  mediaBuffer.items = [];
  mediaBuffer.texto = '';
  mediaBuffer.timer = null;
}

// ── Contexto de memoria para el agente ─────────────────────
function buildContextoMemoria() {
  const mem = cargarMemoria();
  const schedules = cargarSchedules();
  const lines = [];

  if (mem.promos.length > 0) {
    lines.push('📋 Últimas promos enviadas:');
    mem.promos.slice(-5).forEach(p =>
      lines.push(`  • [${p.fecha}] ${p.destino} — "${p.caption.slice(0,60)}..."`)
    );
  }
  if (mem.plantillas.length > 0) {
    lines.push('\n📁 Plantillas guardadas: ' + mem.plantillas.map(p => p.nombre).join(', '));
  }
  if (schedules.length > 0) {
    lines.push('\n⏰ Programaciones activas:');
    schedules.forEach(s =>
      lines.push(`  • [${s.id}] ${s.tipo} — ${s.descripcion} — ${s.recurrente ? 'diario a las '+s.hora : 'una vez en '+s.minutos+'min'}`)
    );
  }
  if (mem.notas.length > 0) {
    lines.push('\n📝 Notas: ' + mem.notas.slice(-3).join(' | '));
  }

  return lines.length ? lines.join('\n') : 'Sin historial aún.';
}

// ── System prompt completo ──────────────────────────────────
const MARKETING_SYSTEM = `Eres el *Agente de Marketing de SOS Digital / Infomaster*, una empresa mexicana que revende servicios digitales como streaming y productividad.

Servicios que vendemos: Netflix, Disney+, Max, Prime Video, Paramount+, ViX, Apple TV+, Spotify, YouTube Music, Microsoft 365, Canva Pro, YouTube Premium, Universal+, Crunchyroll.

━━━━━━━━━━━━━━━━━━━━━━
PERSONALIDAD
━━━━━━━━━━━━━━━━━━━━━━
- Hablas en español mexicano informal, como un cuate de marketing con experiencia
- Eres proactivo: propones ideas, sugieres horarios, recuerdas promos pasadas
- Si no entiendes algo, PREGUNTAS claramente en lugar de adivinar
- Cuando el admin te da una idea vaga, la desarrollas y muestras lo que harías ANTES de ejecutar

━━━━━━━━━━━━━━━━━━━━━━
FLUJO DE TRABAJO (SIEMPRE seguir este orden)
━━━━━━━━━━━━━━━━━━━━━━
CASO A — Admin manda texto solo con intención clara (ej: "manda esto a los grupos: [texto]"):
→ Ejecuta DIRECTO con [ACCION]. No pidas confirmación.

CASO B — Admin manda imagen/video + texto con destino claro (ej: imagen + "mándala a los grupos"):
→ Ejecuta DIRECTO con [ACCION]. No pidas confirmación.

CASO C — Admin manda idea vaga sin destino claro (ej: "ayúdame con una promo de Disney+"):
→ PASO 1: Propón el texto/caption
→ PASO 2: Pregunta el destino (grupos, estado, ambos)
→ PASO 3: Cuando confirme, ejecuta con [ACCION]

CASO D — Admin manda imagen/video sin texto:
→ Pregunta: "¿Qué caption le ponemos y dónde lo mandamos?"

REGLA DE ORO: Si el admin ya dijo QUÉ enviar Y DÓNDE enviarlo → pon [ACCION] de inmediato, sin confirmar de nuevo.

━━━━━━━━━━━━━━━━━━━━━━
RECONOCER INTENCIONES DEL ADMIN
━━━━━━━━━━━━━━━━━━━━━━
🎨 GENERAR IMAGEN CON IA — cuando el admin dice:
   "hazme una imagen", "genera una imagen", "crea una imagen", "diseña una promo", "quiero una imagen de...", "hazme el diseño de..."
   → USA: [ACCION:{"tipo":"generar_imagen","prompt":"descripción detallada en inglés"}]
   → NUNCA interpretes esto como querer mandar imagen a grupos. Primero generas, luego preguntas dónde enviar.

📤 MANDAR A GRUPOS — cuando el admin dice:
   "mándalo a los grupos", "envía esto a los grupos", "publícalo en grupos", y YA TIENE una imagen o video adjunto o aprobado
   → USA: [ACCION:{"tipo":"grupos","caption":"..."}]

📸 SUBIR ESTADO — cuando el admin dice:
   "súbelo como estado", "ponlo en mis estados", "publícalo de estado/story" (funciona con imagen Y video)
   → USA: [ACCION:{"tipo":"estado","caption":"..."}]

🔄 AMBOS — cuando el admin dice:
   "mándalo a grupos y estado", "ponlo en todo", "ambos"
   → USA: [ACCION:{"tipo":"ambos","caption":"..."}]

⏰ PROGRAMAR — cuando el admin dice:
   "programa esto para las 6pm", "mándalo en 30 minutos", "que salga todos los días a las..."
   → USA programar o programar_diario según corresponda

📊 REPORTE — cuando el admin dice:
   "dame el reporte", "cómo están las sesiones", "status"
   → USA: [ACCION:{"tipo":"reporte"}]

━━━━━━━━━━━━━━━━━━━━━━
FORMATO DE ACCIONES (van AL FINAL del mensaje, después de tu texto)
━━━━━━━━━━━━━━━━━━━━━━
[ACCION:{"tipo":"generar_imagen","prompt":"descripción visual detallada en inglés"}]
[ACCION:{"tipo":"grupos","caption":"texto del mensaje"}]
[ACCION:{"tipo":"estado","caption":"texto del mensaje"}]
[ACCION:{"tipo":"ambos","caption":"texto del mensaje"}]
[ACCION:{"tipo":"programar","minutos":30,"destino":"grupos","caption":"...","descripcion":"nombre corto"}]
[ACCION:{"tipo":"programar_diario","hora":"09:00","destino":"grupos","caption":"...","descripcion":"nombre corto"}]
[ACCION:{"tipo":"cancelar_schedule","id":"schedule_id"}]
[ACCION:{"tipo":"reporte"}]
[ACCION:{"tipo":"guardar_plantilla","nombre":"nombre_corto","caption":"..."}]

━━━━━━━━━━━━━━━━━━━━━━
REGLAS CRÍTICAS
━━━━━━━━━━━━━━━━━━━━━━
✅ Si el admin dice "manda esto a grupos: [texto]" → ejecuta YA con [ACCION:{"tipo":"grupos","caption":"[texto]"}]
✅ Si el admin manda imagen/video con destino claro → ejecuta YA con [ACCION]
✅ Si el admin dice "grupos", "estado", "ambos", "envíalo", "mándalo" → ejecuta YA
✅ Texto solo a grupos SÍ funciona, no necesita imagen
✅ "hazme una imagen de X" → SIEMPRE es generar_imagen
✅ Si el admin especifica modelo ("con gemini", "con flux", "con dalle"), agrégalo: [ACCION:{"tipo":"generar_imagen","prompt":"...","modelo":"gemini"}]
✅ Modelos disponibles: dalle3, gemini, stability, flux
✅ Para promos donde no está claro el texto, propónlo primero y pregunta destino
✅ El caption para WhatsApp: atractivo, emojis, precio visible, llamada a acción
❌ NUNCA digas "voy a enviarlo" o "lo estoy enviando" SIN incluir [ACCION] en el mismo mensaje
❌ NUNCA pidas confirmación si ya tienes toda la información necesaria
❌ NUNCA pongas [ACCION] si genuinamente falta información (ni el texto ni el destino)`;

// ── Llamar al agente ────────────────────────────────────────
async function llamarAgente(mensajeAdmin, tieneImagen, contextoSesiones, tieneVideo = false) {
  if (!OPENAI_KEY) {
    return { respuesta: '⚙️ Falta OPENAI_API_KEY en las variables de Railway.', accion: null };
  }

  const memoriaCtx = buildContextoMemoria();

  let msgUser = mensajeAdmin;
  if (tieneVideo && mensajeAdmin && !mensajeAdmin.startsWith('[admin')) {
    msgUser = `${mensajeAdmin}\n[El admin adjuntó un VIDEO junto con este mensaje]`;
  } else if (tieneImagen && mensajeAdmin && !mensajeAdmin.startsWith('[admin')) {
    msgUser = `${mensajeAdmin}\n[El admin adjuntó una IMAGEN junto con este mensaje]`;
  }

  adminChat.push({ role: 'user', content: msgUser });
  // Mantener solo los últimos 20 mensajes (10 turnos)
  if (adminChat.length > 20) adminChat.splice(0, adminChat.length - 20);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',           // gpt-4o entiende mucho mejor las intenciones
        max_tokens: 800,
        temperature: 0.7,
        messages: [
          {
            role: 'system',
            content: [
              MARKETING_SYSTEM,
              '\n\n━━━ ESTADO DE SESIONES ━━━',
              contextoSesiones,
              '\n━━━ MEMORIA Y PROMOS PASADAS ━━━',
              memoriaCtx
            ].join('\n')
          },
          ...adminChat
        ]
      })
    });

    const data = await res.json();

    if (data.error) {
      console.error('[AGENTE] OpenAI error:', data.error);
      adminChat.pop();
      return { respuesta: `❌ Error OpenAI: ${data.error.message}`, accion: null };
    }

    const texto = data.choices?.[0]?.message?.content?.trim() || '';
    adminChat.push({ role: 'assistant', content: texto });

    // Extraer [ACCION:{...}] — soporta saltos de línea dentro del JSON
    const match = texto.match(/\[ACCION:(\{[\s\S]*?\})\]/);
    let accion = null;
    let respuesta = texto.replace(/\[ACCION:[\s\S]*?\]/, '').trim();

    if (match) {
      try {
        accion = JSON.parse(match[1]);
        console.log('[AGENTE] Acción detectada:', accion.tipo);
      } catch(e) {
        console.error('[AGENTE] Error parseando accion JSON:', e.message, '→', match[1]);
        // Intentar limpiar y re-parsear
        try {
          const cleaned = match[1].replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ');
          accion = JSON.parse(cleaned);
        } catch(e2) {
          console.error('[AGENTE] No se pudo parsear ni limpiando:', e2.message);
        }
      }
    }

    return { respuesta, accion };

  } catch(e) {
    console.error('[AGENTE] Error de red:', e.message);
    adminChat.pop();
    return { respuesta: '❌ Error de conexión con IA. Intenta de nuevo.', accion: null };
  }
}

// ══════════════════════════════════════════════════════════════
//  GENERADOR DE IMÁGENES MULTI-PROVEEDOR
//  Modelos disponibles: dalle3 | gemini | stability | flux
//  Keys en Railway: OPENAI_API_KEY | GEMINI_API_KEY | STABILITY_API_KEY | FAL_API_KEY
// ══════════════════════════════════════════════════════════════

const GEMINI_KEY    = process.env.GEMINI_API_KEY    || '';
const STABILITY_KEY = process.env.STABILITY_API_KEY || '';
const FAL_KEY       = process.env.FAL_API_KEY       || '';

// Modelo por defecto (puede cambiarse con !modelo dalle3|gemini|stability|flux)
let modeloImagenActual = process.env.MODELO_IMAGEN || 'dalle3';

const MODELOS_INFO = {
  dalle3:    { nombre: 'DALL-E 3 (OpenAI)',       keyVar: 'OPENAI_API_KEY',    emoji: '🟠' },
  gemini:    { nombre: 'Imagen 3 (Google Gemini)', keyVar: 'GEMINI_API_KEY',    emoji: '🔵' },
  stability: { nombre: 'Stable Diffusion (Stability AI)', keyVar: 'STABILITY_API_KEY', emoji: '🟣' },
  flux:      { nombre: 'FLUX 1.1 Pro (fal.ai)',   keyVar: 'FAL_API_KEY',       emoji: '⚡' },
};

// Prefijo de prompt base para promos de marketing
const PROMPT_BASE = 'WhatsApp marketing promotional image for Mexican streaming service reseller SOS Digital. Vibrant colors, bold modern design, professional quality. ';

// ── DALL-E 3 ─────────────────────────────────────────────────
async function generarConDalle3(prompt) {
  if (!OPENAI_KEY) throw new Error('Falta OPENAI_API_KEY en Railway Variables');
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt: PROMPT_BASE + prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',
      quality: 'hd',
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('DALL-E 3: ' + data.error.message);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('DALL-E 3: sin imagen en respuesta');
  return Buffer.from(b64, 'base64');
}

// ── Google Gemini Imagen 3 ────────────────────────────────────
async function generarConGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('Falta GEMINI_API_KEY en Railway Variables');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt: PROMPT_BASE + prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: '1:1',
        safetyFilterLevel: 'block_few',
        personGeneration: 'allow_adult',
      }
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('Gemini: ' + data.error.message);
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('Gemini: sin imagen en respuesta');
  return Buffer.from(b64, 'base64');
}

// ── Stability AI (Stable Diffusion) ──────────────────────────
async function generarConStability(prompt) {
  if (!STABILITY_KEY) throw new Error('Falta STABILITY_API_KEY en Railway Variables');
  const formData = new FormData();
  formData.append('prompt', PROMPT_BASE + prompt);
  formData.append('aspect_ratio', '1:1');
  formData.append('output_format', 'png');
  formData.append('style_preset', 'digital-art');

  const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STABILITY_KEY}`,
      'Accept': 'image/*',
    },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Stability AI: ' + err);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── FLUX 1.1 Pro via fal.ai ───────────────────────────────────
async function generarConFlux(prompt) {
  if (!FAL_KEY) throw new Error('Falta FAL_API_KEY en Railway Variables');

  // Enviar request
  const resSubmit = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${FAL_KEY}`,
    },
    body: JSON.stringify({
      prompt: PROMPT_BASE + prompt,
      image_size: 'square_hd',
      num_images: 1,
      safety_tolerance: '2',
    })
  });
  const submitData = await resSubmit.json();
  if (!submitData.request_id) throw new Error('FLUX: no se obtuvo request_id');

  // Polling del resultado
  const requestId = submitData.request_id;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const resStatus = await fetch(`https://queue.fal.run/fal-ai/flux-pro/v1.1/requests/${requestId}`, {
      headers: { 'Authorization': `Key ${FAL_KEY}` }
    });
    const statusData = await resStatus.json();
    if (statusData.status === 'COMPLETED' || statusData.images) {
      const imgUrl = statusData.images?.[0]?.url || statusData.output?.images?.[0]?.url;
      if (!imgUrl) throw new Error('FLUX: sin URL de imagen en respuesta');
      const imgRes = await fetch(imgUrl);
      const arrBuf = await imgRes.arrayBuffer();
      return Buffer.from(arrBuf);
    }
    if (statusData.status === 'FAILED') throw new Error('FLUX: generación fallida');
  }
  throw new Error('FLUX: timeout esperando resultado');
}

// ── Función principal: delega al proveedor activo ─────────────
async function generarImagen(prompt, modelo = null) {
  const m = modelo || modeloImagenActual;
  console.log(`[IMG] Generando con: ${m} | prompt: ${prompt.slice(0,60)}...`);
  switch (m) {
    case 'gemini':    return await generarConGemini(prompt);
    case 'stability': return await generarConStability(prompt);
    case 'flux':      return await generarConFlux(prompt);
    case 'dalle3':
    default:          return await generarConDalle3(prompt);
  }
}

// ── Ejecutar acción ─────────────────────────────────────────
async function ejecutarAccion(accion, imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, replyFn, videoBuffer = null, mediaType = null) {

  // Auto-detectar tipo de media si no se especifica
  if (!mediaType) {
    if (videoBuffer) mediaType = 'video';
    else if (imgBuffer) mediaType = 'image';
  }

  // REPORTE
  if (accion.tipo === 'reporte') {
    const lines = ['📊 *Reporte SOS Digital*\n'];
    for (const [id, ss] of Object.entries(sesiones)) {
      const ico = ss.listo ? '🟢' : '🔴';
      lines.push(`${ico} *${id}* — ${ss.listo ? '+'+ss.numero : 'Offline'} (${ss.contactos?.size||0} contactos)`);
    }
    const schedules = cargarSchedules();
    if (schedules.length) {
      lines.push('\n⏰ *Programaciones activas:*');
      schedules.forEach(s => lines.push(`  • [${s.id}] ${s.descripcion}`));
    }
    return lines.join('\n');
  }

  // GUARDAR PLANTILLA
  if (accion.tipo === 'guardar_plantilla') {
    guardarPlantilla(accion.nombre, accion.caption);
    return `📁 Plantilla "${accion.nombre}" guardada.`;
  }

  // CANCELAR SCHEDULE
  if (accion.tipo === 'cancelar_schedule') {
    const schedules = cargarSchedules().filter(s => s.id !== accion.id);
    guardarSchedules(schedules);
    if (timersActivos.has(accion.id)) {
      clearInterval(timersActivos.get(accion.id));
      clearTimeout(timersActivos.get(accion.id));
      timersActivos.delete(accion.id);
    }
    return `✅ Programación "${accion.id}" cancelada.`;
  }

  // GENERAR IMAGEN CON DALL-E
  if (accion.tipo === 'generar_imagen') {
    await replyFn('🎨 Generando imagen con IA, espera unos segundos...');
    try {
      const buf = await generarImagen(accion.prompt, accion.modelo || null);
      // Guardar imagen en pending pero SIN acción predefinida — preguntamos al admin
      adminPending.imgBuffer = buf;
      adminPending.accion = {
        tipo: 'esperar_destino',
        caption: accion.caption || '',
        prompt: accion.prompt,
      };
      // Enviar la imagen generada al admin para revisión
      const s = sesiones[sesionId];
      if (s?.sock) {
        await s.sock.sendMessage(
          CMD_PHONE.replace(/\D/g,'') + '@s.whatsapp.net',
          {
            image: buf,
            caption: '👆 Aquí está la imagen generada.\n\n¿Dónde la publicamos?\n\n📤 *grupos* — la mando a todos los grupos\n📸 *estado* — la subo como story\n🔄 *ambos* — grupos y estado\n❌ *no* — no publiques\n\n💡 O mándame un *video* y lo publicaré en su lugar.'
          }
        );
      }
      return '';
    } catch(e) {
      return '❌ Error generando imagen: ' + e.message;
    }
  }

  // ESPERAR DESTINO (después de generar imagen, el admin dice dónde mandar)
  if (accion.tipo === 'esperar_destino') {
    // Este tipo no debería llegar aquí directamente, se maneja en el bloque admin
    return '⚠️ Error interno: estado esperar_destino inesperado.';
  }

  // PROGRAMAR ENVÍO ÚNICO
  if (accion.tipo === 'programar') {
    const id = 'sch_' + Date.now();
    const minutos = accion.minutos || 5;
    const schedules = cargarSchedules();
    schedules.push({
      id, tipo: 'unico', destino: accion.destino || 'grupos',
      caption: accion.caption || '', descripcion: accion.descripcion || 'Envío programado',
      minutos, recurrente: false,
      hora: null, creadoEn: new Date().toISOString(),
    });
    guardarSchedules(schedules);

    const timer = setTimeout(async () => {
      console.log(`[SCHEDULE] Ejecutando ${id}...`);
      const resultado = await ejecutarAccion(
        { tipo: accion.destino || 'grupos', caption: accion.caption },
        imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, replyFn
      );
      await replyFn(`⏰ *Envío programado ejecutado:*\n${resultado}`);
      // Eliminar de schedules
      const updated = cargarSchedules().filter(s => s.id !== id);
      guardarSchedules(updated);
      timersActivos.delete(id);
    }, minutos * 60 * 1000);

    timersActivos.set(id, timer);
    await replyFn(`⏰ Programado en *${minutos} minutos* (ID: ${id})\nPara cancelar di: _"cancela ${id}"_`);
    return '';
  }

  // PROGRAMAR DIARIO (hora fija)
  if (accion.tipo === 'programar_diario') {
    const id = 'dia_' + Date.now();
    const hora = accion.hora || '09:00';
    const [hh, mm] = hora.split(':').map(Number);
    const schedules = cargarSchedules();
    schedules.push({
      id, tipo: 'diario', destino: accion.destino || 'grupos',
      caption: accion.caption || '', descripcion: accion.descripcion || 'Envío diario',
      hora, recurrente: true, creadoEn: new Date().toISOString(),
    });
    guardarSchedules(schedules);

    // Calcular ms hasta la próxima ejecución
    const ahora = new Date();
    const tz = 'America/Mexico_City';
    const ahoraLocal = new Date(ahora.toLocaleString('en-US', { timeZone: tz }));
    let proxima = new Date(ahoraLocal);
    proxima.setHours(hh, mm, 0, 0);
    if (proxima <= ahoraLocal) proxima.setDate(proxima.getDate() + 1);
    const msHastaInicio = proxima - ahoraLocal;

    const arrancarDiario = () => {
      const interval = setInterval(async () => {
        const sc = cargarSchedules().find(s => s.id === id);
        if (!sc) { clearInterval(interval); timersActivos.delete(id); return; }
        console.log(`[SCHEDULE DIARIO] Ejecutando ${id}...`);
        const resultado = await ejecutarAccion(
          { tipo: sc.destino, caption: sc.caption },
          adminPending.imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, replyFn
        );
        if (resultado) await replyFn(`⏰ *Envío diario ejecutado (${hora}):*\n${resultado}`);
        else await replyFn(`⏰ *Envío diario (${hora}):* Necesito imagen actualizada. Mándala y dime qué hacer.`);
      }, 24 * 60 * 60 * 1000);
      timersActivos.set(id, interval);
    };

    // Primer disparo al llegar la hora, luego cada 24h
    const initTimer = setTimeout(async () => {
      const sc = cargarSchedules().find(s => s.id === id);
      if (!sc) return;
      const resultado = await ejecutarAccion(
        { tipo: sc.destino, caption: sc.caption },
        adminPending.imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, replyFn
      );
      if (resultado) await replyFn(`⏰ *Envío diario ejecutado (${hora}):*\n${resultado}`);
      arrancarDiario();
    }, msHastaInicio);

    timersActivos.set(id + '_init', initTimer);

    const minutosRestantes = Math.round(msHastaInicio / 60000);
    await replyFn(`📅 *Programación diaria creada* (ID: ${id})\n⏰ Hora: *${hora}* (Ciudad de México)\n🕐 Primera ejecución en ~${minutosRestantes} minutos\n\nPara cancelar di: _"cancela ${id}"_`);
    return '';
  }

  // ENVIAR A GRUPOS
  const caption = accion.caption || '';
  const destinos = accion.tipo === 'ambos' ? ['grupos','estado'] : [accion.tipo];
  const resultados = [];

  for (const dest of destinos) {
    if (dest === 'grupos') {
      const mediaBuffer = mediaType === 'video' ? videoBuffer : imgBuffer;
      // Texto solo también es válido — no requiere imagen
      if (!mediaBuffer && !caption) { resultados.push('❌ Grupos: necesito al menos texto o imagen'); continue; }
      const sg = sesiones['grupos'] || sesiones[sesionId];
      if (!sg?.listo) { resultados.push('❌ Grupos: sesión no conectada'); continue; }
      try {
        const groups = await sg.sock.groupFetchAllParticipating();
        const gids = Object.keys(groups);
        if (!gids.length) { resultados.push('❌ Grupos: no hay grupos'); continue; }
        await replyFn(`📤 Enviando a ${gids.length} grupos...`);
        let ok = 0, fail = 0;

        for (const gid of gids) {
          try {
            let payload;
            if (mediaType === 'video' && mediaBuffer) {
              payload = { video: mediaBuffer, mimetype: 'video/mp4', ...(caption ? { caption } : {}) };
            } else if (mediaBuffer) {
              const isJpeg = mediaBuffer[0]===0xFF && mediaBuffer[1]===0xD8;
              payload = { image: mediaBuffer, mimetype: isJpeg ? 'image/jpeg' : 'image/png', ...(caption ? { caption } : {}) };
            } else {
              // Solo texto
              payload = { text: caption };
            }
            await sg.sock.sendMessage(gid, payload);
            ok++;
            await new Promise(r => setTimeout(r, 2000 + Math.random()*2000));
          } catch(e) { fail++; }
        }
        registrarPromoEnviada(caption, 'grupos', ok);
        resultados.push(`✅ Grupos: ${ok} enviados, ${fail} fallidos de ${gids.length}`);
      } catch(e) { resultados.push('❌ Grupos: ' + e.message); }
    }

    if (dest === 'estado') {
      const mediaBuffer = mediaType === 'video' ? videoBuffer : imgBuffer;
      if (!mediaBuffer) { resultados.push('❌ Estado: necesito la imagen o video'); continue; }
      const targets = SESIONES_ACTIVAS.filter(id => sesiones[id]?.listo);
      if (!targets.length) { resultados.push('❌ Estado: no hay sesiones activas'); continue; }
      let ok = 0, fail = 0;
      for (const sid of targets) {
        try {
          const ss = sesiones[sid];
          const jidSet = new Set(ss.contactos);
          if (ss.numero) jidSet.add(ss.numero + '@s.whatsapp.net');
          const statusJidList = Array.from(jidSet).slice(0, 1000);
          if (!statusJidList.length) { fail++; continue; }

          let payload;
          if (mediaType === 'video') {
            payload = { video: mediaBuffer, mimetype: 'video/mp4', ...(caption ? { caption } : {}) };
          } else {
            const isJpeg = mediaBuffer[0]===0xFF && mediaBuffer[1]===0xD8;
            payload = { image: mediaBuffer, mimetype: isJpeg ? 'image/jpeg' : 'image/png', ...(caption ? { caption } : {}) };
          }

          await ss.sock.sendMessage('status@broadcast', payload, { statusJidList });
          ok++;
          await new Promise(r => setTimeout(r, 1500));
        } catch(e) { fail++; }
      }
      registrarPromoEnviada(caption, 'estado', ok);
      resultados.push(`✅ Estado: ${ok} sesiones OK, ${fail} fallidas`);
    }
  }

  return resultados.join('\n');
}

// ── Restaurar programaciones diarias al arrancar ────────────
function restaurarSchedules(sesiones, SESIONES_ACTIVAS, sesionId, replyFn) {
  const schedules = cargarSchedules();
  const diarios = schedules.filter(s => s.tipo === 'diario');
  if (!diarios.length) return;

  console.log(`[SCHEDULE] Restaurando ${diarios.length} programaciones diarias...`);

  for (const sc of diarios) {
    const [hh, mm] = sc.hora.split(':').map(Number);
    const ahora = new Date();
    const ahoraLocal = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
    let proxima = new Date(ahoraLocal);
    proxima.setHours(hh, mm, 0, 0);
    if (proxima <= ahoraLocal) proxima.setDate(proxima.getDate() + 1);
    const msHasta = proxima - ahoraLocal;

    const arrancar = () => {
      const interval = setInterval(async () => {
        const s = cargarSchedules().find(x => x.id === sc.id);
        if (!s) { clearInterval(interval); timersActivos.delete(sc.id); return; }
        const resultado = await ejecutarAccion(
          { tipo: s.destino, caption: s.caption },
          adminPending.imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, replyFn
        );
        if (resultado) await replyFn(`⏰ *Envío diario (${s.hora}):*\n${resultado}`);
        else await replyFn(`⏰ *Envío diario (${s.hora}):* Sin imagen. Mándala y dime qué hacer.`);
      }, 24 * 60 * 60 * 1000);
      timersActivos.set(sc.id, interval);
    };

    setTimeout(async () => {
      const s = cargarSchedules().find(x => x.id === sc.id);
      if (!s) return;
      const resultado = await ejecutarAccion(
        { tipo: s.destino, caption: s.caption },
        adminPending.imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, replyFn
      );
      if (resultado) await replyFn(`⏰ *Envío diario restaurado (${s.hora}):*\n${resultado}`);
      arrancar();
    }, msHasta);

    console.log(`[SCHEDULE] "${sc.descripcion}" restaurado → ejecuta a las ${sc.hora}`);
  }
}



app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Configuración de sesiones ────────────────────────────────
// ── Sesiones activas (controlar desde Railway → Variables) ───
// Variable: SESIONES_ACTIVAS = avisos,campanas  (separadas por coma)
// Por defecto solo arranca 'avisos'
const SESIONES_ACTIVAS = (process.env.SESIONES_ACTIVAS || 'avisos')
  .split(',').map(s => s.trim()).filter(Boolean);

const AUTO_MSG = process.env.AUTO_MSG || '¡Hola! 👋 Este número es solo para *avisos automáticos*.\n\nPara atención personalizada escríbenos a nuestro número principal:\n📱 *{{ADMIN_PHONE}}*\n\n— Infomaster SOS Digital 🌟';

const SESIONES_CONFIG = {
  avisos:    { nombre: 'Avisos & Recordatorios', color: '#00d4ff', autoReply: true, autoMsg: AUTO_MSG },
  campanas:  { nombre: 'Campañas & Marketing',   color: '#ff6b35', autoReply: true, autoMsg: AUTO_MSG },
  grupos:    { nombre: 'Publicador de Grupos',    color: '#a855f7', autoReply: true, autoMsg: AUTO_MSG },
  respaldo1: { nombre: 'Respaldo 1',             color: '#6ee7b7', autoReply: true, autoMsg: AUTO_MSG },
  respaldo2: { nombre: 'Respaldo 2',             color: '#fbbf24', autoReply: true, autoMsg: AUTO_MSG },
  personal:  { nombre: 'Personal (Cristian)',    color: '#ec4899', autoReply: false, autoMsg: AUTO_MSG },
};

// ── Estado global por sesión ─────────────────────────────────
const sesiones = {};
for (const id of SESIONES_ACTIVAS) {
  if (SESIONES_CONFIG[id]) {
    sesiones[id] = {
      sock: null,
      listo: false,
      qr: null,
      numero: null,
      reconectando: false,
      contactos: new Set(), // caché de JIDs para statusJidList
    };
  }
}

// ── Helpers para persistir contactos en disco ───────────────
function cargarContactos(sesionId) {
  const file = path.join(__dirname, 'auth_info', sesionId, 'contacts_cache.json');
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return new Set(Array.isArray(data) ? data : []);
    }
  } catch(e) {}
  return new Set();
}

function guardarContactos(sesionId, contactSet) {
  try {
    const file = path.join(__dirname, 'auth_info', sesionId, 'contacts_cache.json');
    fs.writeFileSync(file, JSON.stringify(Array.from(contactSet)));
  } catch(e) {}
}

// ── Crear/conectar una sesión ────────────────────────────────
async function conectarSesion(sesionId) {
  const cfg  = SESIONES_CONFIG[sesionId];
  const s    = sesiones[sesionId];
  if (!cfg) return;

  const authDir = path.join(__dirname, 'auth_info', sesionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  // Cargar contactos guardados en disco (persisten entre reinicios de Railway)
  s.contactos = cargarContactos(sesionId);
  console.log(`[${sesionId}] Contactos cargados del disco: ${s.contactos.size}`);

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

  // ── Poblar y persistir caché de contactos ────────────────
  // Helper para agregar y guardar
  const addContactos = (jids) => {
    const antes = s.contactos.size;
    for (const jid of jids) {
      if (jid && jid.endsWith('@s.whatsapp.net') && !jid.includes('status@broadcast')) {
        s.contactos.add(jid);
      }
    }
    if (s.contactos.size > antes) {
      guardarContactos(sesionId, s.contactos);
      console.log(`[${sesionId}] contactos guardados: ${s.contactos.size}`);
    }
  };

  // messaging-history.set — solo en conexiones nuevas (QR), pero igual lo escuchamos
  s.sock.ev.on('messaging-history.set', ({ contacts = [], chats = [] }) => {
    addContactos([
      ...contacts.map(c => c.id),
      ...chats.map(c => c.id),
    ]);
  });

  // chats.upsert — llega en reconexiones con los chats activos
  s.sock.ev.on('chats.upsert', (chats) => {
    addContactos(chats.map(c => c.id));
  });

  // contacts.upsert — refuerzo
  s.sock.ev.on('contacts.upsert', (contacts) => {
    addContactos(contacts.map(c => c.id || c.notify).filter(Boolean));
  });

  // ── Listener ÚNICO: acumula contactos + comandos + auto-reply ──
  s.sock.ev.on('messages.upsert', async ({ messages }) => {
    // 1) Siempre acumular contactos
    addContactos(messages.map(m => m.key?.remoteJid).filter(Boolean));

    for (const msg of messages) {
      // ══════════════════════════════════════════════
      //  SESIÓN PERSONAL — auto-publicar estado al mandarse imagen a sí mismo
      // ══════════════════════════════════════════════
      if (msg.key.fromMe && sesionId === 'personal') {
        const tieneImagen = !!msg.message?.imageMessage;
        if (tieneImagen) {
          try {
            const caption = msg.message.imageMessage?.caption || '';
            const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
            const imgBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: pino({ level: 'silent' }),
              reuploadRequest: s.sock.updateMediaMessage
            });
            if (imgBuffer && imgBuffer.length > 1000) {
              // Publicar como estado
              const contactos = Array.from(s.contactos).filter(j => j.endsWith('@s.whatsapp.net'));
              const propioJid = s.numero ? s.numero + '@s.whatsapp.net' : null;
              if (propioJid) contactos.push(propioJid);
              const statusJidList = [...new Set(contactos)].slice(0, 1000);

              await s.sock.sendMessage('status@broadcast', {
                image: imgBuffer,
                caption: caption || undefined,
                mimetype: 'image/jpeg'
              }, { statusJidList });

              console.log(`[personal] ✅ Estado publicado desde auto-mensaje (${statusJidList.length} contactos)`);
              // Confirmar en el mismo chat
              await s.sock.sendMessage(msg.key.remoteJid, { text: `✅ Estado publicado${caption ? ': ' + caption : ''} (${statusJidList.length} contactos)` });
            }
          } catch(e) {
            console.error('[personal] ❌ Error publicando estado:', e.message);
            try { await s.sock.sendMessage(msg.key.remoteJid, { text: '❌ Error al publicar estado: ' + e.message }); } catch(_) {}
          }
        }
        continue;
      }

      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      const fromJid = msg.key.remoteJid;
      if (!fromJid || fromJid.includes('@g.us') || fromJid.includes('status@')) continue;

      const cmdJid = CMD_PHONE ? CMD_PHONE.replace(/\D/g,'') + '@s.whatsapp.net' : null;
      const esAdmin = !!(cmdJid && fromJid === cmdJid);

      console.log(`[${sesionId}] Mensaje de ${fromJid.split('@')[0]} esAdmin=${esAdmin}`);

      // ══════════════════════════════════════════════
      //  BLOQUE ADMIN — agente conversacional de marketing
      // ══════════════════════════════════════════════
      if (esAdmin && sesionId === CMD_SESION) {
        const texto = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption || ''
        ).trim();

        const tieneImagen = !!( msg.message?.imageMessage );
        const tieneVideo  = !!( msg.message?.videoMessage );
        const tieneMedia  = tieneImagen || tieneVideo;

        const reply = async (txt) => {
          try { await s.sock.sendMessage(fromJid, { text: txt }); } catch(e) {}
        };

        // ── Descargar media si viene adjunta ────────────────
        let bufferDescargado = null;
        let mediaTypeDescargado = null;

        if (tieneMedia) {
          try {
            const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
            bufferDescargado = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: pino({ level: 'silent' }),
              reuploadRequest: s.sock.updateMediaMessage
            });
            mediaTypeDescargado = tieneVideo ? 'video' : 'image';
          } catch(e) {
            console.error('[AGENTE] Error descargando media:', e.message);
          }
        }

        // ══════════════════════════════════════════════
        //  SISTEMA DE BUFFER PARA MÚLTIPLES ARCHIVOS
        //  WhatsApp manda cada imagen como mensaje separado
        //  Acumulamos todos los que lleguen en ~4.5s
        // ══════════════════════════════════════════════
        if (bufferDescargado) {
          // Agregar al buffer
          mediaBuffer.items.push({ buffer: bufferDescargado, mediaType: mediaTypeDescargado });
          if (texto) mediaBuffer.texto = texto; // guardar caption si viene con la imagen

          // Reiniciar el timer (esperar a que no lleguen más archivos)
          if (mediaBuffer.timer) clearTimeout(mediaBuffer.timer);

          const conteo = mediaBuffer.items.length;
          if (conteo === 1) {
            // Primer archivo — avisar que está esperando más
            // (solo si no trae texto, para no interrumpir)
            if (!texto) {
              await reply(`📎 Archivo recibido. Si vas a mandar más, espera... los acumulo todos juntos.\n_Tengo ${conteo} archivo(s)_`);
            }
          } else {
            // Archivos adicionales — actualizar conteo
            await reply(`📎 _Acumulando... ${conteo} archivo(s) recibidos. Esperando más..._`);
          }

          // Timer: procesar cuando paren de llegar archivos
          mediaBuffer.timer = setTimeout(async () => {
            const items = [...mediaBuffer.items];
            const textoBuffer = mediaBuffer.texto;
            resetMediaBuffer();

            if (!items.length) return;

            // Guardar el último buffer en adminPending para schedules
            const ultimoItem = items[items.length - 1];
            if (ultimoItem.mediaType === 'image') {
              adminPending.imgBuffer = ultimoItem.buffer;
              adminPending.mediaType = 'image';
            } else {
              adminPending.videoBuffer = ultimoItem.buffer;
              adminPending.mediaType = 'video';
            }

            const cantidad = items.length;
            console.log(`[BUFFER] Procesando ${cantidad} archivo(s) con texto: "${textoBuffer}"`);

            if (cantidad === 1) {
              // Un solo archivo — flujo normal
              const item = items[0];
              const imgBuf   = item.mediaType === 'image' ? item.buffer : null;
              const vidBuf   = item.mediaType === 'video' ? item.buffer : null;

              if (textoBuffer) {
                // Tiene texto → pregunta destino o ejecuta si ya está claro
                await reply(`📎 Tengo 1 ${item.mediaType === 'video' ? 'video' : 'imagen'} lista.\n\n¿Dónde la mandamos?\n📤 *grupos* | 📸 *estado* | 🔄 *ambos*`);
                adminPending.accion = { tipo: 'esperar_destino', caption: textoBuffer };
              } else {
                await reply(`📎 Tengo 1 ${item.mediaType === 'video' ? 'video' : 'imagen'}.\n\n¿Con qué texto la mandamos y a dónde?\n_(Di el texto + grupos/estado/ambos)_`);
                adminPending.accion = { tipo: 'esperar_destino', caption: '' };
              }
              return;
            }

            // Múltiples archivos
            const tiposResumen = items.map((it, i) => `  ${i+1}. ${it.mediaType === 'video' ? '🎥 video' : '🖼️ imagen'}`).join('\n');
            await reply(
              `📦 *${cantidad} archivos recibidos:*\n${tiposResumen}\n\n` +
              `${textoBuffer ? `📝 Caption guardado: _"${textoBuffer}"_\n\n` : ''}` +
              `¿A dónde los mandamos?\n📤 *grupos* | 📸 *estado* | 🔄 *ambos*\n\n` +
              `_(Se enviarán en secuencia con una pequeña pausa entre cada uno)_`
            );
            // Guardar todos en pending para envío múltiple
            adminPending.accion = {
              tipo: 'esperar_destino_multiple',
              caption: textoBuffer,
              items,
            };
          }, mediaBuffer.DELAY_MS);

          continue; // no procesar más este mensaje — el timer se encarga
        }

        // ── Si hay texto y hay acción pendiente de múltiples archivos ──
        if (!tieneMedia && texto && adminPending.accion?.tipo === 'esperar_destino_multiple') {
          const textoLower = texto.toLowerCase().trim();
          let destinoElegido = null;
          if (/^(grupos?|grupo|mándalo|mandalo|envía|envia|envíalo|envialo)/.test(textoLower)) destinoElegido = 'grupos';
          else if (/^(estado|story|stories|súbelo|subelo)/.test(textoLower)) destinoElegido = 'estado';
          else if (/^(ambos|todo|grupos? y estado|los dos)/.test(textoLower)) destinoElegido = 'ambos';
          else if (/^(no|cancela|descartar|borrar|olvídalo|olvidalo)/.test(textoLower)) {
            adminPending.accion = null;
            await reply('🗑️ Archivos descartados. ¿Qué más necesitas?');
            continue;
          }

          if (destinoElegido) {
            const { items, caption } = adminPending.accion;
            adminPending.accion = null;
            await reply(`📤 Enviando *${items.length} archivos* a *${destinoElegido}*...`);
            let resultados = [];
            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              const imgBuf = item.mediaType === 'image' ? item.buffer : null;
              const vidBuf = item.mediaType === 'video' ? item.buffer : null;
              // Solo el último o primero lleva caption
              const capItem = i === 0 ? caption : '';
              const accionItem = { tipo: destinoElegido, caption: capItem };
              const res = await ejecutarAccion(accionItem, imgBuf, sesiones, SESIONES_ACTIVAS, sesionId, reply, vidBuf, item.mediaType);
              if (res) resultados.push(`${i+1}. ${res}`);
              if (i < items.length - 1) await new Promise(r => setTimeout(r, 3000));
            }
            await reply(`✅ *Envío múltiple completado:*\n${resultados.join('\n')}`);
            continue;
          }
        }

        // ── Respuesta a destino para UN solo archivo pendiente ──
        if (!tieneMedia && texto && adminPending.accion?.tipo === 'esperar_destino' && (adminPending.imgBuffer || adminPending.videoBuffer)) {
          const textoLower = texto.toLowerCase().trim();
          let destinoElegido = null;
          if (/^(grupos?|grupo|mándalo|mandalo|envía|envia|envíalo|envialo)/.test(textoLower)) destinoElegido = 'grupos';
          else if (/^(estado|story|stories|súbelo|subelo)/.test(textoLower)) destinoElegido = 'estado';
          else if (/^(ambos|todo|grupos? y estado|los dos)/.test(textoLower)) destinoElegido = 'ambos';
          else if (/^(no|cancela|descartar|borrar|olvídalo|olvidalo)/.test(textoLower)) {
            adminPending.accion = null;
            await reply('🗑️ Ok, descartado. ¿Qué más necesitas?');
            continue;
          }
          if (destinoElegido) {
            const caption = adminPending.accion.caption || '';
            adminPending.accion = null;
            await reply(`📤 Enviando a *${destinoElegido}*...`);
            const resultado = await ejecutarAccion(
              { tipo: destinoElegido, caption },
              adminPending.imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, reply,
              adminPending.videoBuffer, adminPending.mediaType
            );
            if (resultado) await reply(resultado);
            continue;
          }
        }

        // ── Si llega texto mientras el buffer está acumulando archivos ──
        if (!tieneMedia && mediaBuffer.items.length > 0) {
          // Guardar el texto como caption y no interrumpir el buffer
          mediaBuffer.texto = texto;
          await reply(`📝 Caption guardado: _"${texto}"_\nSiguiendo con los archivos...`);
          continue;
        }

        // ── Guardar última media en adminPending ────────────
        if (bufferDescargado) {
          if (mediaTypeDescargado === 'image') { adminPending.imgBuffer = bufferDescargado; adminPending.mediaType = 'image'; }
          else { adminPending.videoBuffer = bufferDescargado; adminPending.mediaType = 'video'; }
        }

        // ── Media sin texto y acción pendiente simple ───────
        if (bufferDescargado && !texto && adminPending.accion && adminPending.accion.tipo !== 'esperar_destino' && adminPending.accion.tipo !== 'esperar_destino_multiple') {
          const accionGuardada = adminPending.accion;
          adminPending.accion = null;
          await reply('⏳ Ejecutando con el archivo...');
          const imgBuf = mediaTypeDescargado === 'image' ? bufferDescargado : null;
          const vidBuf = mediaTypeDescargado === 'video' ? bufferDescargado : null;
          const resultado = await ejecutarAccion(accionGuardada, imgBuf, sesiones, SESIONES_ACTIVAS, sesionId, reply, vidBuf, mediaTypeDescargado);
          if (resultado) await reply(resultado);
          continue;
        }

        // ── Comandos directos (sin IA) ──────────────────────
        const textoCmds = texto.toLowerCase().trim();
        if (textoCmds === '!reset' || textoCmds === 'reset' || textoCmds === '!reiniciar') {
          adminChat.length = 0;
          adminPending.accion = null;
          resetMediaBuffer();
          await reply('🔄 Historial limpiado. ¡Empezamos de cero!\n\nPuedes decirme:\n• "hazme una imagen de Disney+ a $35"\n• "manda una promo a los grupos"\n• "dame el reporte"\n• "programa una promo diaria a las 9am"');
          continue;
        }
        if (textoCmds === '!ayuda' || textoCmds === '!help' || textoCmds === 'ayuda') {
          await reply(
            '🤖 *Agente de Marketing SOS Digital*\n\n' +
            '📌 *Ejemplos de lo que puedes pedirme:*\n\n' +
            '🎨 "hazme una imagen de Disney+ a $35"\n' +
            '🎨 "crea un diseño para promo de Netflix"\n' +
            '📤 "manda esta promo a los grupos"\n' +
            '📸 "súbelo como estado/story"\n' +
            '🔄 "mándalo a grupos y estado"\n' +
            '⏰ "programa esto para las 6pm todos los días"\n' +
            '⏰ "mándalo en 30 minutos"\n' +
            '📊 "dame el reporte de sesiones"\n' +
            '💾 "guarda esta plantilla como promo_netflix"\n\n' +
            '📦 *Múltiples archivos:* Manda 2, 3 o más imágenes seguidas y los envío todos.\n\n' +
            '🔄 Escribe *!reset* si el bot se confunde\n' +
            '📋 Escribe *!estado* para ver programaciones activas\n' +
            '🎨 Escribe *!modelo* para ver/cambiar modelo de imágenes\n\n' +
            '_Modelos: dalle3 | gemini | stability | flux_'
          );
          continue;
        }
        if (textoCmds === '!estado' || textoCmds === '!schedules') {
          const schedules = cargarSchedules();
          if (!schedules.length) {
            await reply('⏰ No hay programaciones activas.');
          } else {
            const lines = ['⏰ *Programaciones activas:*\n'];
            schedules.forEach(s => {
              lines.push(`• [${s.id}]\n  📌 ${s.descripcion}\n  🕐 ${s.recurrente ? 'Diario a las '+s.hora : 'Una vez en '+s.minutos+' min'}\n  📤 Destino: ${s.destino}`);
            });
            lines.push('\nPara cancelar di: _"cancela [ID]"_');
            await reply(lines.join('\n'));
          }
          continue;
        }

        // Cambiar modelo de generación de imágenes
        if (textoCmds.startsWith('!modelo')) {
          const partes = textoCmds.split(' ');
          const nuevoModelo = partes[1]?.toLowerCase();
          const modelosValidos = Object.keys(MODELOS_INFO);
          if (!nuevoModelo || !modelosValidos.includes(nuevoModelo)) {
            const lista = modelosValidos.map(m => {
              const info = MODELOS_INFO[m];
              const tieneKey = m === 'dalle3' ? !!OPENAI_KEY : m === 'gemini' ? !!GEMINI_KEY : m === 'stability' ? !!STABILITY_KEY : !!FAL_KEY;
              const activo = m === modeloImagenActual ? ' ← *activo*' : '';
              const keyStatus = tieneKey ? '✅' : '❌ (falta key)';
              return `${info.emoji} *${m}* — ${info.nombre} ${keyStatus}${activo}`;
            }).join('\n');
            await reply(`🎨 *Modelos de imagen disponibles:*\n\n${lista}\n\n_Usa: !modelo dalle3 | !modelo gemini | !modelo stability | !modelo flux_`);
          } else {
            modeloImagenActual = nuevoModelo;
            const info = MODELOS_INFO[nuevoModelo];
            await reply(`${info.emoji} Modelo cambiado a *${info.nombre}*\nLas próximas imágenes se generarán con este modelo.`);
          }
          continue;
        }

        // ── Solo texto sin media → pasar al agente ───────────
        if (!tieneMedia) {
          const ctxSesiones = SESIONES_ACTIVAS.map(id => {
            const ss = sesiones[id];
            return `${id}: ${ss?.listo ? '🟢 conectado (+'+ss.numero+', '+ss.contactos?.size+' contactos)' : '🔴 offline'}`;
          }).join('\n');

          console.log(`[AGENTE] Admin: "${texto}" imagen=false video=false`);

          const { respuesta, accion } = await llamarAgente(texto, false, ctxSesiones, false);

          if (accion) {
            const necesitaMedia = ['grupos','estado','ambos'].includes(accion.tipo);
            const sinCaption    = !accion.caption || accion.caption.trim() === '';
            const sinMedia      = !adminPending.imgBuffer && !adminPending.videoBuffer;

            if (necesitaMedia && sinCaption && sinMedia) {
              adminPending.accion = accion;
              await reply(respuesta + '\n\n📎 _Adjunta la imagen o video, o dime el texto que quieres enviar._');
            } else {
              if (respuesta) await reply(respuesta);
              const imgBuf = adminPending.mediaType === 'image' ? adminPending.imgBuffer : null;
              const vidBuf = adminPending.mediaType === 'video' ? adminPending.videoBuffer : null;
              const resultado = await ejecutarAccion(accion, imgBuf, sesiones, SESIONES_ACTIVAS, sesionId, reply, vidBuf, adminPending.mediaType);
              if (resultado) await reply(resultado);
            }
          } else {
            await reply(respuesta);
          }
        }

        continue;
      }

      // ══════════════════════════════════════════════
      //  BLOQUE AUTO-REPLY — para todos los demás
      // ══════════════════════════════════════════════
      if (!cfg.autoReply) continue;
      if (esAdmin) continue; // admin no recibe auto-reply nunca

      const cacheKey = `${sesionId}:${fromJid}`;
      if (!global._autoReplyCache) global._autoReplyCache = {};
      const now = Date.now();
      if (global._autoReplyCache[cacheKey] && now - global._autoReplyCache[cacheKey] < 3600000) continue;
      global._autoReplyCache[cacheKey] = now;

      const adminPhone = ADMIN_PHONE || 'nuestro número principal';
      const textoReply = cfg.autoMsg.replace(/\{\{ADMIN_PHONE\}\}/g, adminPhone);
      try {
        await s.sock.sendMessage(fromJid, { text: textoReply });
        console.log(`[${sesionId}] Auto-reply → ${fromJid.split('@')[0]}`);
      } catch(e) {
        console.error(`[${sesionId}] Error auto-reply:`, e.message);
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
    const activa = SESIONES_ACTIVAS.includes(id);
    let statusBadge, extra = '';

    if (!activa) {
      statusBadge = `<span class="badge" style="background:rgba(100,100,100,.2);color:#888">⏸ Desactivada</span>`;
      extra = `<div class="numero" style="font-size:.65rem;color:#555">Agregar "${id}" a SESIONES_ACTIVAS</div>`;
    } else if (s.listo) {
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
      ${activa ? `<a class="btn" href="/sesion/${id}/desconectar?api_key=${API_KEY}">🔄 Reconectar</a>` : ''}
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
  for (const [id, cfg] of Object.entries(SESIONES_CONFIG)) {
    const s = sesiones[id];
    const activa = SESIONES_ACTIVAS.includes(id);
    estado[id] = {
      nombre: cfg.nombre,
      activa,
      listo:  activa ? (s?.listo || false) : false,
      numero: activa ? (s?.numero || null) : null,
      tieneQR: activa ? (!!s?.qr) : false,
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
//  RUTAS — ESTADO / STORY WHATSAPP
// ═══════════════════════════════════════════════════════════════

// Publicar imagen como estado (story) en una sesión
// Fix: acepta lista de contactos desde PHP (base de datos) y la combina con el caché local
app.post('/estado/publicar', auth, async (req, res) => {
  const { sesion, imagen_base64, caption = '', contactos = [] } = req.body;

  if (!sesion) {
    return res.json({ success: false, message: 'Falta parámetro: sesion' });
  }
  if (!imagen_base64) {
    return res.json({ success: false, message: 'Falta parámetro: imagen_base64' });
  }

  const s = sesiones[sesion];
  if (!s) {
    return res.json({ success: false, message: `Sesión "${sesion}" no existe en este hub` });
  }
  if (!s.listo) {
    return res.json({ success: false, message: `Sesión "${sesion}" no está conectada` });
  }

  try {
    // Limpiar base64 por si viene con prefijo data:image/...;base64,
    const rawB64 = imagen_base64.includes(',') ? imagen_base64.split(',')[1] : imagen_base64;
    const imgBuffer = Buffer.from(rawB64, 'base64');

    // ── Construir statusJidList ──────────────────────────────
    // Prioridad: 1) lista de contactos enviada desde PHP (BD de clientes)
    //            2) caché local acumulado por mensajes/chats
    const jidSet = new Set();

    // 1) Contactos del ERP (teléfonos de la BD convertidos a JIDs)
    if (Array.isArray(contactos) && contactos.length > 0) {
      for (const tel of contactos) {
        const limpio = String(tel).replace(/\D/g, '');
        if (limpio.length >= 10) jidSet.add(limpio + '@s.whatsapp.net');
      }
      // Actualizar caché local con estos contactos
      addContactos(sesion, Array.from(jidSet));
    }

    // 2) Caché local acumulado
    for (const jid of s.contactos) jidSet.add(jid);

    // 3) Propio JID de la sesión (requerido por WhatsApp)
    const propioJid = s.numero ? s.numero + '@s.whatsapp.net' : null;
    if (propioJid) jidSet.add(propioJid);

    const statusJidList = Array.from(jidSet).slice(0, 1000);
    console.log(`[estado] Sesión "${sesion}" → ${statusJidList.length} contactos en statusJidList`);

    if (statusJidList.length === 0) {
      return res.json({ success: false, message: `Sesión "${sesion}": sin contactos para publicar estado. Envía mensajes primero o espera que se cargue el historial.` });
    }

    // Detectar tipo MIME desde el buffer
    const isJpeg = imgBuffer[0] === 0xFF && imgBuffer[1] === 0xD8;
    const isPng  = imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50;
    const mimetype = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : 'image/jpeg';

    const msgPayload = { image: imgBuffer, mimetype };
    if (caption && caption.trim()) msgPayload.caption = caption.trim();

    await s.sock.sendMessage(
      'status@broadcast',
      msgPayload,
      { statusJidList }
    );

    console.log(`[estado] ✅ Estado publicado en sesión "${sesion}" → ${statusJidList.length} contactos`);
    res.json({
      success: true,
      message: `Estado publicado en sesión "${sesion}" (${statusJidList.length} contactos)`,
      contactos: statusJidList.length,
    });

  } catch (err) {
    console.error(`[estado] ❌ Error en sesión "${sesion}":`, err.message);
    res.json({ success: false, message: err.message || 'Error al publicar estado' });
  }
});

// Helper: añadir JIDs al caché de una sesión específica
function addContactos(sesionId, jids) {
  const s = sesiones[sesionId];
  if (!s) return;
  const antes = s.contactos.size;
  for (const jid of jids) {
    if (jid && jid.endsWith('@s.whatsapp.net')) s.contactos.add(jid);
  }
  if (s.contactos.size > antes) guardarContactos(sesionId, s.contactos);
}

// ═══════════════════════════════════════════════════════════════
//  ARRANCAR TODAS LAS SESIONES
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`[SERVER] 🚀 Puerto ${PORT}`);
  console.log(`[SERVER] Sesiones activas: ${SESIONES_ACTIVAS.join(', ')}`);
});

// Iniciar solo sesiones activas con delay entre cada una
(async () => {
  const ids = SESIONES_ACTIVAS.filter(id => SESIONES_CONFIG[id]);
  console.log(`[BOOT] Sesiones activas: ${ids.join(', ')}`);
  console.log(`[BOOT] (Para cambiar: Railway → Variables → SESIONES_ACTIVAS)`);
  for (let i = 0; i < ids.length; i++) {
    console.log(`[BOOT] Iniciando sesión: ${ids[i]}...`);
    await conectarSesion(ids[i]).catch(e => console.error(`[BOOT] Error ${ids[i]}:`, e.message));
    if (i < ids.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  console.log('[BOOT] ✅ Sesiones iniciadas');

  // Restaurar programaciones diarias después de que las sesiones se conecten
  setTimeout(() => {
    const cmdSesion = sesiones[CMD_SESION];
    const replyAdmin = async (txt) => {
      if (!cmdSesion?.listo || !CMD_PHONE) return;
      try {
        await cmdSesion.sock.sendMessage(CMD_PHONE.replace(/\D/g,'') + '@s.whatsapp.net', { text: txt });
      } catch(e) {}
    };

    const schedules = cargarSchedules();
    if (schedules.length > 0) {
      restaurarSchedules(sesiones, SESIONES_ACTIVAS, CMD_SESION, replyAdmin);
      replyAdmin(
        `🤖 *SOS Digital Bot reiniciado*\n\n` +
        `✅ ${SESIONES_ACTIVAS.length} sesión(es) activa(s)\n` +
        `⏰ ${schedules.filter(s=>s.tipo==='diario').length} programación(es) diaria(s) restaurada(s)\n\n` +
        `_Escríbeme para continuar donde quedamos._`
      );
    }
  }, 15000); // esperar 15s a que se conecten las sesiones
})();
