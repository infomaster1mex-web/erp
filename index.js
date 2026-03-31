// ═══════════════════════════════════════════════════════════════
// index.js — SOS Digital WhatsApp Multi-Bot (Baileys)
// Sesiones: avisos | campanas | grupos | respaldo1 | respaldo2 | personal
// FIX: publicación de estado en sesión personal usa sesión con más contactos
// FIX v2: soporte @lid + diagnóstico statusJidList
// ═══════════════════════════════════════════════════════════════
import {
  makeWASocket,
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

const timersActivos = new Map();
const adminChat = [];

const adminPending = {
  accion: null,
  imgBuffer: null,
  videoBuffer: null,
  mediaType: null,
};

const mediaBuffer = {
  items: [],
  texto: '',
  timer: null,
  DELAY_MS: 4500,
};

function resetMediaBuffer() {
  if (mediaBuffer.timer) clearTimeout(mediaBuffer.timer);
  mediaBuffer.items = [];
  mediaBuffer.texto = '';
  mediaBuffer.timer = null;
}

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
  if (adminChat.length > 20) adminChat.splice(0, adminChat.length - 20);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o',
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

    const match = texto.match(/\[ACCION:(\{[\s\S]*?\})\]/);
    let accion = null;
    let respuesta = texto.replace(/\[ACCION:[\s\S]*?\]/, '').trim();

    if (match) {
      try {
        accion = JSON.parse(match[1]);
        console.log('[AGENTE] Acción detectada:', accion.tipo);
      } catch(e) {
        console.error('[AGENTE] Error parseando accion JSON:', e.message, '→', match[1]);
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
// ══════════════════════════════════════════════════════════════

const GEMINI_KEY    = process.env.GEMINI_API_KEY    || '';
const STABILITY_KEY = process.env.STABILITY_API_KEY || '';
const FAL_KEY       = process.env.FAL_API_KEY       || '';

let modeloImagenActual = process.env.MODELO_IMAGEN || 'dalle3';

const MODELOS_INFO = {
  dalle3:    { nombre: 'DALL-E 3 (OpenAI)',       keyVar: 'OPENAI_API_KEY',    emoji: '🟠' },
  gemini:    { nombre: 'Imagen 3 (Google Gemini)', keyVar: 'GEMINI_API_KEY',    emoji: '🔵' },
  stability: { nombre: 'Stable Diffusion (Stability AI)', keyVar: 'STABILITY_API_KEY', emoji: '🟣' },
  flux:      { nombre: 'FLUX 1.1 Pro (fal.ai)',   keyVar: 'FAL_API_KEY',       emoji: '⚡' },
};

const PROMPT_BASE = 'WhatsApp marketing promotional image for Mexican streaming service reseller SOS Digital. Vibrant colors, bold modern design, professional quality. ';

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

async function generarConFlux(prompt) {
  if (!FAL_KEY) throw new Error('Falta FAL_API_KEY en Railway Variables');

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

// ══════════════════════════════════════════════════════════════
//  FIX v2: Helper para construir statusJidList robusto
//  Combina contactos @s.whatsapp.net + @lid de todas las sesiones
// ══════════════════════════════════════════════════════════════
function buildStatusJidList(sesionPublicadora, todasLasSesiones, SESIONES_ACTIVAS) {
  const jidSet = new Set();
  const lidSet = new Set();

  // Agregar contactos de la sesión que publica
  if (sesionPublicadora?.contactos) {
    for (const j of sesionPublicadora.contactos) {
      if (j.endsWith('@s.whatsapp.net')) jidSet.add(j);
      else if (j.endsWith('@lid')) lidSet.add(j);
    }
  }

  // Agregar contactos de TODAS las sesiones activas (no solo avisos)
  for (const sid of SESIONES_ACTIVAS) {
    const ss = todasLasSesiones[sid];
    if (!ss?.contactos) continue;
    for (const j of ss.contactos) {
      if (j.endsWith('@s.whatsapp.net')) jidSet.add(j);
      else if (j.endsWith('@lid')) lidSet.add(j);
    }
  }

  // JID propio de la sesión publicadora (obligatorio para verse a sí mismo)
  if (sesionPublicadora?.numero) {
    jidSet.add(sesionPublicadora.numero.replace(/\D/g,'') + '@s.whatsapp.net');
  }

  // Combinar ambos formatos — Baileys acepta @lid en versiones recientes
  const combined = [...Array.from(jidSet), ...Array.from(lidSet)].slice(0, 1000);

  console.log(`[STATUS-JID] @s.whatsapp.net: ${jidSet.size} | @lid: ${lidSet.size} | total: ${combined.length}`);
  if (combined.length <= 5) {
    console.log(`[STATUS-JID] Muestra:`, combined);
  } else {
    console.log(`[STATUS-JID] Primeros 5:`, combined.slice(0, 5));
  }

  return combined;
}

async function ejecutarAccion(accion, imgBuffer, sesiones, SESIONES_ACTIVAS, sesionId, replyFn, videoBuffer = null, mediaType = null) {

  if (!mediaType) {
    if (videoBuffer) mediaType = 'video';
    else if (imgBuffer) mediaType = 'image';
  }

  if (accion.tipo === 'reporte') {
    const lines = ['📊 *Reporte SOS Digital*\n'];
    for (const [id, ss] of Object.entries(sesiones)) {
      const ico = ss.listo ? '🟢' : '🔴';
      const waCount = ss.contactos ? Array.from(ss.contactos).filter(j => j.endsWith('@s.whatsapp.net')).length : 0;
      const lidCount = ss.contactos ? Array.from(ss.contactos).filter(j => j.endsWith('@lid')).length : 0;
      lines.push(`${ico} *${id}* — ${ss.listo ? '+'+ss.numero : 'Offline'} (${waCount} wa + ${lidCount} lid contactos)`);
    }
    const schedules = cargarSchedules();
    if (schedules.length) {
      lines.push('\n⏰ *Programaciones activas:*');
      schedules.forEach(s => lines.push(`  • [${s.id}] ${s.descripcion}`));
    }
    return lines.join('\n');
  }

  if (accion.tipo === 'guardar_plantilla') {
    guardarPlantilla(accion.nombre, accion.caption);
    return `📁 Plantilla "${accion.nombre}" guardada.`;
  }

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

  if (accion.tipo === 'generar_imagen') {
    await replyFn('🎨 Generando imagen con IA, espera unos segundos...');
    try {
      const buf = await generarImagen(accion.prompt, accion.modelo || null);
      adminPending.imgBuffer = buf;
      adminPending.accion = {
        tipo: 'esperar_destino',
        caption: accion.caption || '',
        prompt: accion.prompt,
      };
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

  if (accion.tipo === 'esperar_destino') {
    return '⚠️ Error interno: estado esperar_destino inesperado.';
  }

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
      const updated = cargarSchedules().filter(s => s.id !== id);
      guardarSchedules(updated);
      timersActivos.delete(id);
    }, minutos * 60 * 1000);

    timersActivos.set(id, timer);
    await replyFn(`⏰ Programado en *${minutos} minutos* (ID: ${id})\nPara cancelar di: _"cancela ${id}"_`);
    return '';
  }

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

  // ENVIAR A GRUPOS / ESTADO / AMBOS
  const caption = accion.caption || '';
  const destinos = accion.tipo === 'ambos' ? ['grupos','estado'] : [accion.tipo];
  const resultados = [];

  const grupoSesionId = process.env._GRUPO_OVERRIDE || 'grupos';
  const GROUP_SEND_TIMEOUT_MS = Number(process.env.GROUP_SEND_TIMEOUT_MS || 45000);
  const STATUS_SEND_TIMEOUT_MS = Number(process.env.STATUS_SEND_TIMEOUT_MS || 30000);
  const BOTH_FLOW_PAUSE_MS = Number(process.env.BOTH_FLOW_PAUSE_MS || 2500);

  // --- Función: enviar a grupos ---
  async function enviarGrupos() {
      const mediaBuffer = mediaType === 'video' ? videoBuffer : imgBuffer;
      if (!mediaBuffer && !caption) return '❌ Grupos: necesito al menos texto o imagen';
      const sg = sesiones[grupoSesionId] || sesiones['grupos'] || sesiones[sesionId];
      if (!sg?.listo || !sg?.sock?.sendMessage) return '❌ Grupos: sesión no conectada o socket muerto';
      try {
        const groups = await sg.sock.groupFetchAllParticipating();
        const gids = Object.keys(groups);
        if (!gids.length) return '❌ Grupos: no hay grupos';
        console.log(`[GRUPOS] 📋 ${gids.length} grupos encontrados:`, gids.map(g => `${groups[g]?.subject || g}`).join(', '));
        console.log(`[GRUPOS] 📦 Payload: mediaType=${mediaType}, bufferSize=${mediaBuffer?.length || 0}, caption=${caption?.length || 0} chars, timeout=${GROUP_SEND_TIMEOUT_MS}ms`);
        await replyFn(`📤 Enviando a ${gids.length} grupos...`);
        let ok = 0, fail = 0;
        let consecutiveFails = 0;

        for (const gid of gids) {
          if (consecutiveFails >= 3) {
            console.log(`[GRUPOS] 🛑 Circuit breaker: ${consecutiveFails} fallos consecutivos, abortando restantes`);
            fail += gids.length - ok - fail;
            break;
          }

          const maxRetries = 1;
          let sent = false;
          for (let attempt = 0; attempt <= maxRetries && !sent; attempt++) {
            try {
              let payload;
              if (mediaType === 'video' && mediaBuffer) {
                payload = { video: mediaBuffer, mimetype: 'video/mp4', ...(caption ? { caption } : {}) };
              } else if (mediaBuffer) {
                const isJpeg = mediaBuffer[0]===0xFF && mediaBuffer[1]===0xD8;
                payload = { image: mediaBuffer, mimetype: isJpeg ? 'image/jpeg' : 'image/png', ...(caption ? { caption } : {}) };
              } else {
                payload = { text: caption };
              }
              if (attempt > 0) console.log(`[GRUPOS] 🔄 Retry #${attempt} para ${groups[gid]?.subject || gid}...`);

              await Promise.race([
                sg.sock.sendMessage(gid, payload),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${Math.round(GROUP_SEND_TIMEOUT_MS/1000)}s`)), GROUP_SEND_TIMEOUT_MS))
              ]);

              ok++;
              sent = true;
              consecutiveFails = 0;
              await new Promise(r => setTimeout(r, 2500 + Math.random()*1500));
            } catch(e) {
              const errMsg = String(e?.message || e || 'Error desconocido');
              console.error(`[GRUPOS] ❌ Error en ${gid} (${groups[gid]?.subject || 'sin nombre'}) intento ${attempt}:`, errMsg);

              if ((errMsg.includes('senderMessageKeys') || errMsg.includes('Bad MAC')) && !sg._senderKeysFixed) {
                sg._senderKeysFixed = true;
                limpiarSenderKeys(grupoSesionId);
              }

              if (attempt < maxRetries) {
                const waitTime = errMsg.includes('Timeout') ? 6000 : (attempt + 1) * 4000;
                console.log(`[GRUPOS] ⏳ Esperando ${waitTime/1000}s antes de reintentar...`);
                await new Promise(r => setTimeout(r, waitTime));
              } else {
                fail++;
                consecutiveFails++;
              }
            }
          }
        }
        registrarPromoEnviada(caption, 'grupos', ok);
        return `✅ Grupos: ${ok} enviados, ${fail} fallidos de ${gids.length}`;
      } catch(e) { return '❌ Grupos: ' + (e?.message || e); }
  }

  // --- Función: publicar estado ---
  async function enviarEstado() {
      const mediaBuffer = mediaType === 'video' ? videoBuffer : imgBuffer;
      if (!mediaBuffer) return '❌ Estado: necesito la imagen o video';

      const excludeForStatus = new Set(['personal']);
      if (accion.tipo === 'ambos') excludeForStatus.add(grupoSesionId);

      const targets = SESIONES_ACTIVAS.filter(id => sesiones[id]?.listo && sesiones[id]?.sock && !excludeForStatus.has(id));
      if (!targets.length) return '❌ Estado: no hay sesiones activas (o sockets desconectados)';
      console.log(`[ESTADO] 🎯 Sesiones target: ${targets.join(', ')} (excluidas: ${SESIONES_ACTIVAS.filter(id => !targets.includes(id)).join(', ')})`);
      let ok = 0, fail = 0;
      for (const sid of targets) {
        try {
          const ss = sesiones[sid];
          if (!ss?.sock?.sendMessage) {
            console.error(`[ESTADO] ❌ "${sid}" socket null o desconectado, saltando`);
            fail++;
            continue;
          }
          const statusJidList = buildStatusJidList(ss, sesiones, SESIONES_ACTIVAS);
          if (!statusJidList.length) {
            console.error(`[ESTADO] ❌ "${sid}" sin contactos para statusJidList`);
            fail++;
            continue;
          }

          let payload;
          if (mediaType === 'video') {
            payload = { video: mediaBuffer, mimetype: 'video/mp4', ...(caption ? { caption } : {}) };
          } else {
            const isJpeg = mediaBuffer[0]===0xFF && mediaBuffer[1]===0xD8;
            payload = { image: mediaBuffer, mimetype: isJpeg ? 'image/jpeg' : 'image/png', ...(caption ? { caption } : {}) };
          }

          console.log(`[ESTADO] Publicando via sesión "${sid}" (${ss.numero}) con ${statusJidList.length} contactos`);
          await Promise.race([
            ss.sock.sendMessage('status@broadcast', payload, { statusJidList }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${Math.round(STATUS_SEND_TIMEOUT_MS/1000)}s`)), STATUS_SEND_TIMEOUT_MS))
          ]);
          console.log(`[ESTADO] ✅ Publicado en "${sid}"`);
          ok++;
          await new Promise(r => setTimeout(r, 800));
        } catch(e) {
          const errMsg = String(e?.message || e || 'Error desconocido');
          console.error(`[ESTADO] ❌ Error en "${sid}":`, errMsg);
          if (errMsg.includes('senderMessageKeys') || errMsg.includes('Bad MAC')) {
            const cleaned = limpiarSenderKeys(sid);
            if (cleaned) {
              try {
                const ss = sesiones[sid];
                if (!ss?.sock?.sendMessage) throw new Error('Socket desconectado');
                const statusJidList = buildStatusJidList(ss, sesiones, SESIONES_ACTIVAS);
                let retryPayload;
                if (mediaType === 'video') {
                  retryPayload = { video: mediaBuffer, mimetype: 'video/mp4', ...(caption ? { caption } : {}) };
                } else {
                  const isJpeg = mediaBuffer[0]===0xFF && mediaBuffer[1]===0xD8;
                  retryPayload = { image: mediaBuffer, mimetype: isJpeg ? 'image/jpeg' : 'image/png', ...(caption ? { caption } : {}) };
                }
                await Promise.race([
                  ss.sock.sendMessage('status@broadcast', retryPayload, { statusJidList }),
                  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${Math.round(STATUS_SEND_TIMEOUT_MS/1000)}s retry`)), STATUS_SEND_TIMEOUT_MS))
                ]);
                console.log(`[ESTADO] ✅ Retry exitoso en "${sid}" después de limpiar sender keys`);
                ok++;
                continue;
              } catch(e2) {
                console.error(`[ESTADO] ❌ Retry también falló en "${sid}":`, e2?.message || e2);
              }
            }
          }
          fail++;
        }
      }
      registrarPromoEnviada(caption, 'estado', ok);
      return `✅ Estado: ${ok} sesiones OK, ${fail} fallidas`;
  }

  if (accion.tipo === 'ambos') {
    const resGrupos = await enviarGrupos();
    resultados.push(resGrupos);
    await new Promise(r => setTimeout(r, BOTH_FLOW_PAUSE_MS));
    const resEstado = await enviarEstado();
    resultados.push(resEstado);
  } else {
    for (const dest of destinos) {
      if (dest === 'grupos') resultados.push(await enviarGrupos());
      if (dest === 'estado') resultados.push(await enviarEstado());
    }
  }

  return resultados.join('\n');
}

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

const sesiones = {};
for (const id of SESIONES_ACTIVAS) {
  if (SESIONES_CONFIG[id]) {
    sesiones[id] = {
      sock: null,
      listo: false,
      qr: null,
      numero: null,
      reconectando: false,
      contactos: new Set(),
    };
  }
}

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

// FIX: Limpia sender-key files corruptos (error "senderMessageKeys on number")
function limpiarSenderKeys(sesionId) {
  const authDir = path.join(__dirname, 'auth_info', sesionId);
  try {
    const files = fs.readdirSync(authDir);
    const senderFiles = files.filter(f => f.startsWith('sender-key-'));
    if (!senderFiles.length) return 0;
    for (const f of senderFiles) {
      fs.unlinkSync(path.join(authDir, f));
    }
    console.log(`[FIX] 🧹 Eliminados ${senderFiles.length} sender-key files de "${sesionId}"`);
    return senderFiles.length;
  } catch(e) {
    console.error(`[FIX] Error limpiando sender-keys de "${sesionId}":`, e.message);
    return 0;
  }
}

const NOMBRES_FILE = path.join(__dirname, 'auth_info', 'personal', 'nombres_cache.json');
let nombresCache = {};
try { if (fs.existsSync(NOMBRES_FILE)) nombresCache = JSON.parse(fs.readFileSync(NOMBRES_FILE, 'utf8')); } catch(e) {}

function guardarNombre(jid, nombre) {
  if (!nombre || !jid) return;
  const num = jid.replace('@s.whatsapp.net','').replace('@lid','').replace(/\D/g,'');
  if (!nombresCache[num] || nombresCache[num] !== nombre) {
    nombresCache[num] = nombre;
    try { fs.mkdirSync(path.dirname(NOMBRES_FILE), {recursive:true}); fs.writeFileSync(NOMBRES_FILE, JSON.stringify(nombresCache, null, 2)); } catch(e) {}
  }
}

function buscarContactoPorNombre(nombre) {
  const q = nombre.toLowerCase();
  for (const [num, nom] of Object.entries(nombresCache)) {
    if (nom.toLowerCase().includes(q)) return { num, nombre: nom };
  }
  return null;
}

async function conectarSesion(sesionId) {
  const cfg  = SESIONES_CONFIG[sesionId];
  const s    = sesiones[sesionId];
  if (!cfg) return;

  const authDir = path.join(__dirname, 'auth_info', sesionId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  s.contactos = cargarContactos(sesionId);
  console.log(`[${sesionId}] Contactos cargados del disco: ${s.contactos.size}`);

  // FIX v2: log de tipos de contactos al cargar
  const waCount = Array.from(s.contactos).filter(j => j.endsWith('@s.whatsapp.net')).length;
  const lidCount = Array.from(s.contactos).filter(j => j.endsWith('@lid')).length;
  console.log(`[${sesionId}] Desglose: ${waCount} @s.whatsapp.net + ${lidCount} @lid`);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version }          = await fetchLatestBaileysVersion();

  s.sock = makeWASocket({
    version,
    auth:   state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Chrome (Linux)', 'Chrome', '131.0.0.0'],
    syncFullHistory: false,
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
      s._retryCount = 0;
      s._logoutCount = 0;
      s.numero = s.sock.user?.id?.split(':')[0] || null;
      console.log(`[${sesionId}] ✅ Conectado: ${s.numero}`);

      // Forzar sync de historial para cargar contactos (especialmente para sesión personal)
      if (s.contactos.size < 10) {
        console.log(`[${sesionId}] ⏳ Pocos contactos (${s.contactos.size}), esperando sync de historial...`);
        // Baileys envía messaging-history.set automáticamente, pero puede tardar
        // Log periódico para monitorear la carga
        const syncCheck = setInterval(() => {
          if (s.contactos.size > 50) {
            console.log(`[${sesionId}] ✅ Contactos sincronizados: ${s.contactos.size}`);
            clearInterval(syncCheck);
          } else {
            console.log(`[${sesionId}] ⏳ Contactos hasta ahora: ${s.contactos.size}`);
          }
        }, 15000);
        // Dejar de checar después de 5 min
        setTimeout(() => clearInterval(syncCheck), 300000);
      }
    }

    if (connection === 'close') {
      s.listo = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconectar = code !== DisconnectReason.loggedOut;
      console.log(`[${sesionId}] Desconectado. Código: ${code}`);

      // Track retry attempts
      if (!s._retryCount) s._retryCount = 0;

      if (code === 515) {
        s._retryCount++;
        console.log(`[${sesionId}] Retry #${s._retryCount} por código 515`);
        if (s._retryCount >= 3) {
          console.log(`[${sesionId}] ⚠️ 3 intentos fallidos con 515, limpiando auth...`);
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
          s._retryCount = 0;
          setTimeout(() => conectarSesion(sesionId), 10000);
        } else {
          setTimeout(() => conectarSesion(sesionId), 5000 * s._retryCount);
        }
      } else if (code === 405) {
        // 405 = WA rechaza conexión (protocolo/rate limit/conflicto de sesión)
        s._retryCount++;
        const MAX_405_RETRIES = 5;
        // Backoff exponencial: 10s, 20s, 40s, 80s, 160s
        const delay405 = Math.min(10000 * Math.pow(2, s._retryCount - 1), 180000);
        console.log(`[${sesionId}] ⚠️ 405 Retry #${s._retryCount}/${MAX_405_RETRIES} — esperando ${Math.round(delay405/1000)}s`);
        if (s._retryCount >= MAX_405_RETRIES) {
          console.log(`[${sesionId}] ❌ Max reintentos 405 alcanzado. Sesión pausada — reconectar manualmente.`);
          s._retryCount = 0;
          s.reconectando = false;
          // No reconectar automáticamente, esperar intervención manual
        } else {
          s.reconectando = true;
          setTimeout(() => conectarSesion(sesionId), delay405);
        }
      } else if (reconectar && !s.reconectando) {
        s._retryCount = 0;
        s.reconectando = true;
        // Delay escalonado para evitar reconexión simultánea de todas las sesiones
        const staggerDelay = 5000 + (Object.keys(sesiones).indexOf(sesionId) * 3000);
        setTimeout(() => conectarSesion(sesionId), staggerDelay);
      } else if (!reconectar) {
        // 401 = loggedOut — WA expulsó la sesión
        if (!s._logoutCount) s._logoutCount = 0;
        s._logoutCount++;
        s._retryCount = 0;
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
        // Cooldown creciente para no hacer ciclos rápidos que WA penaliza
        const logoutDelay = Math.min(s._logoutCount * 30000, 300000); // 30s, 60s, 90s... max 5min
        console.log(`[${sesionId}] 🚫 LoggedOut #${s._logoutCount} — esperando ${Math.round(logoutDelay/1000)}s antes de generar QR nuevo`);
        if (s._logoutCount >= 5) {
          console.log(`[${sesionId}] ❌ Demasiados logouts seguidos. Sesión pausada — reconectar manualmente desde el Hub.`);
          s._logoutCount = 0;
          s.reconectando = false;
        } else {
          setTimeout(() => conectarSesion(sesionId), logoutDelay);
        }
      }
    }
  });

  // FIX v2: aceptar TANTO @s.whatsapp.net COMO @lid
  const addContactos = (jids) => {
    const antes = s.contactos.size;
    for (const jid of jids) {
      if (!jid) continue;
      if (jid.includes('status@broadcast')) continue;
      // Aceptar ambos formatos
      if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) {
        s.contactos.add(jid);
      }
    }
    if (s.contactos.size > antes) {
      guardarContactos(sesionId, s.contactos);
      const newWa = Array.from(s.contactos).filter(j => j.endsWith('@s.whatsapp.net')).length;
      const newLid = Array.from(s.contactos).filter(j => j.endsWith('@lid')).length;
      console.log(`[${sesionId}] contactos guardados: ${s.contactos.size} (${newWa} wa + ${newLid} lid)`);
    }
  };

  s.sock.ev.on('messaging-history.set', ({ contacts = [], chats = [] }) => {
    addContactos([
      ...contacts.map(c => c.id),
      ...chats.map(c => c.id),
    ]);
  });

  s.sock.ev.on('chats.upsert', (chats) => {
    addContactos(chats.map(c => c.id));
  });

  s.sock.ev.on('contacts.upsert', (contacts) => {
    addContactos(contacts.map(c => c.id || c.notify).filter(Boolean));
    if (sesionId === 'personal') {
      contacts.forEach(c => { if (c.id && (c.name || c.notify)) guardarNombre(c.id, c.name || c.notify); });
    }
  });

  s.sock.ev.on('messages.upsert', async ({ messages, type }) => {
    addContactos(messages.map(m => m.key?.remoteJid).filter(Boolean));
    if (sesionId === 'personal') {
      messages.forEach(m => { if (!m.key.fromMe && m.pushName && m.key.remoteJid) guardarNombre(m.key.remoteJid, m.pushName); });
    }

    for (const msg of messages) {
      // ══════════════════════════════════════════════
      //  SESIÓN PERSONAL
      // ══════════════════════════════════════════════
      if (msg.key.fromMe && sesionId === 'personal') {
        const tieneImagen = !!msg.message?.imageMessage;
        const tieneVideo  = !!msg.message?.videoMessage;
        const tieneTexto  = !!(msg.message?.conversation || msg.message?.extendedTextMessage?.text);

        if (type !== 'notify') { continue; }

        const propioNum = s.numero ? s.numero.replace(/\D/g,'') : null;
        const remoteJid = msg.key.remoteJid || '';
        // FIX v2: comparar tanto con @s.whatsapp.net como con @lid
        const remoteNum = remoteJid.replace('@s.whatsapp.net','').replace('@lid','').replace(/\D/g,'');
        const esMensajeASiMismo = (
          (propioNum && remoteNum === propioNum) ||
          remoteJid === (propioNum + '@s.whatsapp.net') ||
          remoteJid === (propioNum + '@lid')
        );
        if (!propioNum || !esMensajeASiMismo) { continue; }

        const msgId = msg.key.id;
        const msgTs = (msg.messageTimestamp || 0) * 1000;
        if (Date.now() - msgTs > 30000) { continue; }
        if (!s._processedIds) s._processedIds = new Set();
        if (s._processedIds.has(msgId)) { continue; }
        s._processedIds.add(msgId);
        if (s._processedIds.size > 200) s._processedIds.delete(s._processedIds.values().next().value);

        const selfJid = msg.key.remoteJid;

        // ── IMAGEN o VIDEO → preguntar qué hacer ──────────────────
        if (tieneImagen || tieneVideo) {
          try {
            const caption = tieneImagen
              ? (msg.message.imageMessage?.caption || '')
              : (msg.message.videoMessage?.caption || '');
            const mediaType = tieneVideo ? 'video' : 'image';
            const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
            const mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: pino({ level: 'silent' }),
              reuploadRequest: s.sock.updateMediaMessage
            });
            if (mediaBuffer && mediaBuffer.length > 1000) {
              if (!s._pendingImg) s._pendingImg = {};
              s._pendingImg = { buffer: mediaBuffer, caption, mediaType, ts: Date.now() };
              const emoji = tieneVideo ? '🎥' : '📸';
              const tipo = tieneVideo ? 'Video' : 'Imagen';
              await s.sock.sendMessage(selfJid, {
                text: `${emoji} ${tipo} listo. ¿Qué hago con ${tieneVideo ? 'él' : 'ella'}?\n\n1️⃣ *Estado* — publicar en mi estado de WhatsApp\n2️⃣ *Grupos* — mandar a todos los grupos\n3️⃣ *Ambos* — estado y grupos\n4️⃣ *Persona* — mandarla a alguien específico\n\nResponde con una opción 🤖`
              });
              console.log(`[personal] ${emoji} ${tipo} recibido (${mediaBuffer.length} bytes), esperando instrucción`);
            }
          } catch(e) { console.error('[personal] ❌ Error media:', e.message); }
        }

        // ── TEXTO ───────────────────────────────────────────────
        if (tieneTexto && OPENAI_KEY) {
          const texto = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
          if (!texto) { continue; }

          // ── Detección directa de respuesta a imagen pendiente ─────
          if (s._pendingImg && Date.now() - s._pendingImg.ts < 300000) {
            const t = texto.toLowerCase();
            let destino = null;
            if (t.includes('ambos') || t.includes('todo') || t.includes('los dos')) destino = 'ambos';
            else if (t.includes('grupo')) destino = 'grupos';
            else if (t.includes('estado')) destino = 'estado';

            if (destino) {
              const img = s._pendingImg;
              s._pendingImg = null;
              try {
                if (destino === 'estado' || destino === 'ambos') {
                  // ════════════════════════════════════════════════════
                  // FIX v2: usar buildStatusJidList robusto
                  // ════════════════════════════════════════════════════
                  const statusJidList = buildStatusJidList(s, sesiones, SESIONES_ACTIVAS);

                  if (statusJidList.length === 0) {
                    await s.sock.sendMessage(selfJid, { text: '⚠️ Sin contactos cargados todavía. Espera un momento y vuelve a intentarlo. 🤖' });
                    continue;
                  }
                  console.log(`[personal] Publicando estado en cuenta PERSONAL con ${statusJidList.length} contactos (${s.numero})`);
                  let payload;
                  if (img.mediaType === 'video') {
                    payload = { video: img.buffer, mimetype: 'video/mp4', ...(img.caption ? { caption: img.caption } : {}) };
                  } else {
                    const isJpeg1 = img.buffer[0]===0xFF && img.buffer[1]===0xD8;
                    payload = { image: img.buffer, mimetype: isJpeg1 ? 'image/jpeg' : 'image/png', ...(img.caption ? { caption: img.caption } : {}) };
                  }
                  await s.sock.sendMessage('status@broadcast', payload, { statusJidList });
                  console.log(`[personal] ✅ Estado publicado en PERSONAL (${statusJidList.length} contactos)`);
                }
                if (destino === 'grupos' || destino === 'ambos') {
                  const sg = sesiones[process.env._GRUPO_OVERRIDE || 'grupos'] || sesiones['avisos'];
                  if (sg?.listo) {
                    const groups = await sg.sock.groupFetchAllParticipating();
                    const gids = Object.keys(groups);
                    let ok = 0;
                    for (const gid of gids) {
                      try {
                        let gPayload;
                        if (img.mediaType === 'video') {
                          gPayload = { video: img.buffer, mimetype: 'video/mp4', ...(img.caption ? { caption: img.caption } : {}) };
                        } else {
                          gPayload = { image: img.buffer, mimetype: 'image/jpeg', ...(img.caption ? { caption: img.caption } : {}) };
                        }
                        await sg.sock.sendMessage(gid, gPayload);
                        ok++;
                        await new Promise(r => setTimeout(r, 2000 + Math.random()*2000));
                      } catch(e) {}
                    }
                    console.log(`[personal] ✅ Media enviado a ${ok} grupos`);
                  }
                }
                await s.sock.sendMessage(selfJid, { text: `✅ Listo, publicado en ${destino}. 🤖` });
              } catch(e) {
                console.error(`[personal] ❌ Error publicando estado:`, e.message, e.stack?.split('\n')[1]);
                await s.sock.sendMessage(selfJid, { text: `❌ Error: ${e.message} 🤖` });
              }
              continue;
            }
          }

          try {
            const AGENTE_FILE = path.join(__dirname, 'auth_info', 'agente_personal.json');
            let agente = { historial: [], memoria: [], recordatorios: [] };
            try { if (fs.existsSync(AGENTE_FILE)) agente = JSON.parse(fs.readFileSync(AGENTE_FILE, 'utf8')); } catch(e) {}

            const ahoraMX = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City', dateStyle: 'full', timeStyle: 'short' });

            const contactosConocidos = Object.entries(nombresCache).slice(0, 50)
              .map(([num, nom]) => `${nom}: ${num}`).join('\n');
            const contactosStr = contactosConocidos ? `\n\nContactos conocidos:\n${contactosConocidos}` : '';
            const pendingImgStr = (s._pendingImg && Date.now() - s._pendingImg.ts < 300000)
              ? `\n\n⚠️ HAY ${s._pendingImg.mediaType === 'video' ? 'UN VIDEO' : 'UNA IMAGEN'} PENDIENTE esperando instrucción. Si el usuario dice "estado", "grupos", "ambos" o menciona una persona, responde con {"accion":"usar_imagen","destino":"estado|grupos|ambos|persona"} inmediatamente.`
              : '';

            const ahora = Date.now();
            const recordatoriosVencidos = agente.recordatorios.filter(r => !r.enviado && r.timestamp <= ahora);
            for (const r of recordatoriosVencidos) {
              try {
                await s.sock.sendMessage(selfJid, { text: `⏰ *Recordatorio:* ${r.texto}` });
                r.enviado = true;
              } catch(e) {}
            }
            if (recordatoriosVencidos.length > 0) {
              fs.writeFileSync(AGENTE_FILE, JSON.stringify(agente, null, 2));
            }

            const histReciente = agente.historial.slice(-15);
            const memoriaStr = agente.memoria.length > 0
              ? '\n\nLo que sé de ti:\n' + agente.memoria.map(m => `• ${m}`).join('\n')
              : '';
            const recordatoriosStr = agente.recordatorios.filter(r => !r.enviado).length > 0
              ? '\n\nRecordatorios pendientes:\n' + agente.recordatorios.filter(r=>!r.enviado).map(r => `• ${r.texto} (${new Date(r.timestamp).toLocaleString('es-MX',{timeZone:'America/Mexico_City'})})`).join('\n')
              : '';

            const systemPrompt = `Eres un agente IA personal de Cristian, dueño de Infomaster/SOS Digital en México. 
Fecha y hora actual: ${ahoraMX}
Eres su asistente personal de confianza: respondes con claridad, eres directo, usas español informal.
Siempre termina tus respuestas con el emoji 🤖 al final.
Puedes ayudar con: recordatorios, notas, ideas, análisis, redacción, dudas técnicas, lo que sea.

═══ CAPACIDADES ESPECIALES ═══
✅ Puedes SUBIR ESTADOS (stories) de WhatsApp cuando el usuario te mande una imagen o video.
✅ Puedes ENVIAR a todos los GRUPOS cuando el usuario te mande una imagen o video.
✅ Puedes hacer AMBOS (estado + grupos) a la vez.
✅ Puedes ENVIAR MENSAJES a contactos específicos.
El flujo es: el usuario manda imagen/video → tú le preguntas a dónde (estado/grupos/ambos/persona) → se ejecuta.
Si el usuario pregunta "qué funciones tienes" o similar, SIEMPRE menciona publicar estados y enviar a grupos.

═══ ACCIONES (responde con JSON al final) ═══

Cuando el usuario pida un recordatorio (algo que le debes AVISAR a él), responde con JSON al final así:
{"accion":"recordatorio","texto":"descripción del recordatorio","minutos":N}

Cuando el usuario quiera que recuerdes algo de él, responde con JSON al final así:
{"accion":"memoria","dato":"lo que hay que recordar"}

Cuando el usuario pida MANDARLE un mensaje a otra persona (ahora o programado), usa SIEMPRE enviar_mensaje:
{"accion":"enviar_mensaje","telefono":"521XXXXXXXXXX","mensaje":"texto exacto a enviar","minutos":0}
Si pide enviarlo en X minutos, pon minutos=X. Si no tienes el teléfono, búscalo en los contactos conocidos. Si no está, pregunta.
NUNCA uses "recordatorio" para mensajes a terceros, siempre usa "enviar_mensaje".

Cuando el usuario mande una imagen/video o responda qué hacer con la imagen pendiente (estado/grupos/ambos/persona), responde con JSON al final así:
{"accion":"usar_imagen","destino":"estado|grupos|ambos|persona","telefono":"521XXXXXXXXXX (solo si destino=persona)"}

Cuando el usuario pida CANCELAR un mensaje programado, responde con JSON al final así:
{"accion":"cancelar_mensaje","id":null}
(id null cancela el último pendiente)

Cuando el usuario pida ver sus recordatorios o memoria, muéstralos.
${memoriaStr}${recordatoriosStr}${contactosStr}${pendingImgStr}`;

            const messages = [
              { role: 'system', content: systemPrompt },
              ...histReciente.map(h => ({ role: h.rol, content: h.texto })),
              { role: 'user', content: texto }
            ];

            const res = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
              body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 600 })
            });
            const data = await res.json();
            let respuesta = data.choices?.[0]?.message?.content || '❌ Sin respuesta';
            console.log(`[personal] 🧠 GPT raw: ${respuesta.substring(0, 200)}`);

            let jsonMatch = null;
            try {
              const jsonRegex = /\{(?:[^{}]|\{[^{}]*\})*"accion"\s*:\s*"(recordatorio|memoria|enviar_mensaje|cancelar_mensaje|usar_imagen)"(?:[^{}]|\{[^{}]*\})*\}/gs;
              const matches = [...respuesta.matchAll(jsonRegex)];
              if (matches.length > 0) jsonMatch = [matches[0][0], matches[0][1]];
            } catch(e) {}
            if (jsonMatch) {
              try {
                const accion = JSON.parse(jsonMatch[0]);
                if (accion.accion === 'recordatorio' && accion.minutos) {
                  agente.recordatorios.push({
                    id: Date.now(),
                    texto: accion.texto,
                    timestamp: Date.now() + accion.minutos * 60000,
                    enviado: false
                  });
                  setTimeout(async () => {
                    try {
                      const ag = JSON.parse(fs.readFileSync(AGENTE_FILE, 'utf8'));
                      const r = ag.recordatorios.find(r => r.id === accion.id && !r.enviado);
                      if (r) {
                        await s.sock.sendMessage(selfJid, { text: `⏰ *Recordatorio:* ${accion.texto}` });
                        r.enviado = true;
                        fs.writeFileSync(AGENTE_FILE, JSON.stringify(ag, null, 2));
                      }
                    } catch(e) {}
                  }, accion.minutos * 60000);
                } else if (accion.accion === 'memoria' && accion.dato) {
                  if (!agente.memoria.includes(accion.dato)) agente.memoria.push(accion.dato);
                } else if (accion.accion === 'enviar_mensaje' && accion.telefono && accion.mensaje) {
                  const destJid = accion.telefono.replace(/\D/g,'') + '@s.whatsapp.net';
                  const mins = parseInt(accion.minutos) || 0;
                  const timerId = `msg_${Date.now()}`;
                  const enviar = async () => {
                    timersActivos.delete(timerId);
                    try {
                      await s.sock.sendMessage(destJid, { text: accion.mensaje + ' 🤖' });
                      await s.sock.sendMessage(selfJid, { text: `✅ Mensaje enviado a ${accion.telefono}${mins > 0 ? ` (programado ${mins} min)` : ''}` });
                      console.log(`[personal] 📤 Mensaje enviado a ${accion.telefono}`);
                    } catch(e) {
                      await s.sock.sendMessage(selfJid, { text: `❌ Error enviando a ${accion.telefono}: ${e.message}` });
                    }
                  };
                  if (mins > 0) {
                    const t = setTimeout(enviar, mins * 60000);
                    timersActivos.set(timerId, t);
                    if (!agente.pendientes) agente.pendientes = [];
                    agente.pendientes.push({ id: timerId, telefono: accion.telefono, mensaje: accion.mensaje, expira: Date.now() + mins * 60000 });
                  } else await enviar();
                } else if (accion.accion === 'usar_imagen') {
                  const img = s._pendingImg;
                  if (!img || Date.now() - img.ts > 300000) {
                    respuesta = 'No hay imagen pendiente (expiró o no se envió). Manda la imagen de nuevo. 🤖';
                  } else {
                    const dest = accion.destino || 'estado';
                    if (dest === 'estado' || dest === 'ambos') {
                      try {
                        // FIX v2: usar buildStatusJidList robusto
                        const statusJidList = buildStatusJidList(s, sesiones, SESIONES_ACTIVAS);

                        if (statusJidList.length === 0) {
                          respuesta = '⚠️ Sin contactos cargados. Espera y vuelve a intentarlo. 🤖';
                        } else {
                          console.log(`[personal] Publicando estado (usar_imagen) en cuenta PERSONAL con ${statusJidList.length} contactos (${s.numero})`);
                          let uPayload;
                          if (img.mediaType === 'video') {
                            uPayload = { video: img.buffer, mimetype: 'video/mp4', ...(img.caption ? { caption: img.caption } : {}) };
                          } else {
                            const isJpeg2 = img.buffer[0]===0xFF && img.buffer[1]===0xD8;
                            uPayload = { image: img.buffer, mimetype: isJpeg2 ? 'image/jpeg' : 'image/png', ...(img.caption ? { caption: img.caption } : {}) };
                          }
                          await s.sock.sendMessage('status@broadcast', uPayload, { statusJidList });
                          console.log(`[personal] ✅ Estado publicado en PERSONAL (${statusJidList.length} contactos)`);
                        }
                      } catch(e) {
                        console.error('[personal] ❌ Error estado:', e.message, e.stack?.split('\n')[1]);
                      }
                    }
                    if (dest === 'grupos' || dest === 'ambos') {
                      try {
                        const sg = sesiones[process.env._GRUPO_OVERRIDE || 'grupos'] || sesiones['avisos'];
                        if (sg?.listo) {
                          const groups = await sg.sock.groupFetchAllParticipating();
                          const gids = Object.keys(groups);
                          let ok = 0;
                          for (const gid of gids) {
                            try {
                              let gp;
                              if (img.mediaType === 'video') {
                                gp = { video: img.buffer, mimetype: 'video/mp4', ...(img.caption ? { caption: img.caption } : {}) };
                              } else {
                                gp = { image: img.buffer, mimetype: 'image/jpeg', ...(img.caption ? { caption: img.caption } : {}) };
                              }
                              await sg.sock.sendMessage(gid, gp);
                              ok++;
                              await new Promise(r => setTimeout(r, 2000 + Math.random()*2000));
                            } catch(e) {}
                          }
                          console.log(`[personal] ✅ Media enviado a ${ok} grupos`);
                        }
                      } catch(e) { console.error('[personal] ❌ Error grupos:', e.message); }
                    }
                    if (dest === 'persona' && accion.telefono) {
                      try {
                        const destJid = accion.telefono.replace(/\D/g,'') + '@s.whatsapp.net';
                        let pp;
                        if (img.mediaType === 'video') {
                          pp = { video: img.buffer, mimetype: 'video/mp4', ...(img.caption ? { caption: img.caption } : {}) };
                        } else {
                          pp = { image: img.buffer, mimetype: 'image/jpeg', ...(img.caption ? { caption: img.caption } : {}) };
                        }
                        await s.sock.sendMessage(destJid, pp);
                      } catch(e) { console.error('[personal] ❌ Error persona:', e.message); }
                    }
                    s._pendingImg = null;
                  }
                } else if (accion.accion === 'cancelar_mensaje') {
                  if (!agente.pendientes) agente.pendientes = [];
                  const pendiente = accion.id
                    ? agente.pendientes.find(p => p.id === accion.id)
                    : agente.pendientes[agente.pendientes.length - 1];
                  if (pendiente && timersActivos.has(pendiente.id)) {
                    clearTimeout(timersActivos.get(pendiente.id));
                    timersActivos.delete(pendiente.id);
                    agente.pendientes = agente.pendientes.filter(p => p.id !== pendiente.id);
                  }
                }
                respuesta = respuesta
                  .replace(jsonMatch[0], '')
                  .replace(/```json[\s\S]*?```/g, '')
                  .replace(/```[\s\S]*?```/g, '')
                  .replace(/\bjson\b\s*/gi, '')
                  .trim();
              } catch(e) {}
            }

            agente.historial.push({ rol: 'user', texto });
            agente.historial.push({ rol: 'assistant', texto: respuesta });
            if (agente.historial.length > 100) agente.historial = agente.historial.slice(-100);
            fs.mkdirSync(path.dirname(AGENTE_FILE), { recursive: true });
            fs.writeFileSync(AGENTE_FILE, JSON.stringify(agente, null, 2));

            await s.sock.sendMessage(selfJid, { text: respuesta });
            console.log(`[personal] 🤖 Agente respondió a: "${texto.substring(0,50)}"`);

          } catch(e) {
            console.error('[personal] ❌ Error agente:', e.message);
            try { await s.sock.sendMessage(selfJid, { text: '❌ Error del agente: ' + e.message }); } catch(_) {}
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

        if (bufferDescargado) {
          mediaBuffer.items.push({ buffer: bufferDescargado, mediaType: mediaTypeDescargado });
          if (texto) mediaBuffer.texto = texto;

          if (mediaBuffer.timer) clearTimeout(mediaBuffer.timer);

          const conteo = mediaBuffer.items.length;
          if (conteo === 1) {
            if (!texto) {
              await reply(`📎 Archivo recibido. Si vas a mandar más, espera... los acumulo todos juntos.\n_Tengo ${conteo} archivo(s)_`);
            }
          } else {
            await reply(`📎 _Acumulando... ${conteo} archivo(s) recibidos. Esperando más..._`);
          }

          mediaBuffer.timer = setTimeout(async () => {
            const items = [...mediaBuffer.items];
            const textoBuffer = mediaBuffer.texto;
            resetMediaBuffer();

            if (!items.length) return;

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
              const item = items[0];
              if (textoBuffer) {
                await reply(`📎 Tengo 1 ${item.mediaType === 'video' ? 'video' : 'imagen'} lista.\n\n¿Dónde la mandamos?\n📤 *grupos* | 📸 *estado* | 🔄 *ambos*`);
                adminPending.accion = { tipo: 'esperar_destino', caption: textoBuffer };
              } else {
                await reply(`📎 Tengo 1 ${item.mediaType === 'video' ? 'video' : 'imagen'}.\n\n¿Con qué texto la mandamos y a dónde?\n_(Di el texto + grupos/estado/ambos)_`);
                adminPending.accion = { tipo: 'esperar_destino', caption: '' };
              }
              return;
            }

            const tiposResumen = items.map((it, i) => `  ${i+1}. ${it.mediaType === 'video' ? '🎥 video' : '🖼️ imagen'}`).join('\n');
            await reply(
              `📦 *${cantidad} archivos recibidos:*\n${tiposResumen}\n\n` +
              `${textoBuffer ? `📝 Caption guardado: _"${textoBuffer}"_\n\n` : ''}` +
              `¿A dónde los mandamos?\n📤 *grupos* | 📸 *estado* | 🔄 *ambos*\n\n` +
              `_(Se enviarán en secuencia con una pequeña pausa entre cada uno)_`
            );
            adminPending.accion = {
              tipo: 'esperar_destino_multiple',
              caption: textoBuffer,
              items,
            };
          }, mediaBuffer.DELAY_MS);

          continue;
        }

        // ═══ COMANDOS ! — siempre se procesan primero, antes de estados pendientes o IA ═══
        if (!tieneMedia && texto && texto.startsWith('!')) {
          const textoCmds = texto.toLowerCase().trim();
          
          if (textoCmds === '!reset' || textoCmds === '!reiniciar') {
            adminChat.length = 0;
            adminPending.accion = null;
            resetMediaBuffer();
            await reply('🔄 Historial limpiado. ¡Empezamos de cero!\n\nPuedes decirme:\n• "hazme una imagen de Disney+ a $35"\n• "manda una promo a los grupos"\n• "dame el reporte"\n• "programa una promo diaria a las 9am"');
            continue;
          }
          if (textoCmds === '!fix' || textoCmds === '!fix-grupos') {
            let totalCleaned = 0;
            const results = [];
            for (const sid of SESIONES_ACTIVAS) {
              const cleaned = limpiarSenderKeys(sid);
              totalCleaned += cleaned;
              if (cleaned) results.push(`🧹 *${sid}*: ${cleaned} archivos limpiados`);
            }
            if (totalCleaned) {
              await reply(`🔧 *Sender keys reparadas*\n\n${results.join('\n')}\n\n_Intenta enviar de nuevo._`);
            } else {
              await reply('✅ No se encontraron sender keys corruptas. Todo limpio.');
            }
            continue;
          }
          if (textoCmds === '!test-grupos' || textoCmds === '!test') {
            // Probar con TODAS las sesiones para encontrar cuál puede enviar a grupos
            const sesionesAProbar = ['grupos', ...SESIONES_ACTIVAS.filter(id => id !== 'grupos' && id !== 'personal')];
            let algunoFunciono = false;
            
            for (const testSid of sesionesAProbar) {
              const sg = sesiones[testSid];
              if (!sg?.listo) continue;
              
              try {
                const groups = await sg.sock.groupFetchAllParticipating();
                const gids = Object.keys(groups);
                if (!gids.length) continue;
                
                const testGid = gids[0];
                const testName = groups[testGid]?.subject || testGid;
                await reply(`🧪 Probando con sesión *${testSid}* (${sg.numero}) → *${testName}*...`);
                
                try {
                  await sg.sock.sendMessage(testGid, { text: '🧪 Test — SOS Digital Bot' });
                  await reply(`✅ *${testSid}*: TEXTO OK en *${testName}*`);
                  algunoFunciono = true;
                  
                  // Si hay imagen, probar también
                  if (adminPending.imgBuffer) {
                    await new Promise(r => setTimeout(r, 3000));
                    try {
                      const isJpeg = adminPending.imgBuffer[0]===0xFF && adminPending.imgBuffer[1]===0xD8;
                      await sg.sock.sendMessage(testGid, { 
                        image: adminPending.imgBuffer, 
                        mimetype: isJpeg ? 'image/jpeg' : 'image/png',
                        caption: '🧪 Test imagen'
                      });
                      await reply(`✅ *${testSid}*: IMAGEN OK`);
                    } catch(e2) {
                      await reply(`❌ *${testSid}*: imagen falló: ${e2.message}`);
                    }
                  }
                  
                  // Si encontramos una que funciona y no es 'grupos', sugerir cambio
                  if (testSid !== 'grupos') {
                    await reply(`💡 La sesión *${testSid}* SÍ puede enviar a grupos. Para usarla, manda:\n*!usar-sesion ${testSid}*`);
                  }
                  break; // Ya encontramos una que funciona
                } catch(e1) {
                  await reply(`❌ *${testSid}*: ${e1.message}`);
                }
              } catch(e) {
                continue; // Esta sesión no tiene grupos
              }
            }
            
            if (!algunoFunciono) {
              await reply('❌ Ninguna sesión pudo enviar a grupos. Opciones:\n1. Espera 10-15 min más (la sesión puede estar sincronizando)\n2. Manda un mensaje manual desde el teléfono a un grupo\n3. *!reauth-grupos* para re-vincular');
            }
            continue;
          }
          if (textoCmds.startsWith('!usar-sesion')) {
            const nuevaSesion = textoCmds.split(' ')[1]?.trim();
            if (!nuevaSesion || !sesiones[nuevaSesion]) {
              await reply('❌ Uso: *!usar-sesion avisos* (o cualquier sesión activa)');
              continue;
            }
            // Cambiar la sesión preferida para grupos en runtime
            process.env._GRUPO_OVERRIDE = nuevaSesion;
            await reply(`✅ Grupos ahora se enviarán via sesión *${nuevaSesion}* (${sesiones[nuevaSesion]?.numero || '?'})`);
            continue;
          }
          if (textoCmds === '!reauth' || textoCmds === '!reauth-grupos') {
            const targetSesion = textoCmds.includes('grupos') ? 'grupos' : sesionId;
            await reply(`⚠️ Borrando auth de "${targetSesion}" y reconectando...\nTendrás que escanear QR de nuevo en el panel web.`);
            const ts = sesiones[targetSesion];
            if (ts) {
              try { if (ts.sock) { ts.sock.end(); ts.sock = null; } } catch(e) {}
              ts.listo = false; ts.qr = null; ts.numero = null;
              const authDir = path.join(__dirname, 'auth_info', targetSesion);
              // Guardar contacts_cache antes de borrar
              const contactsFile = path.join(authDir, 'contacts_cache.json');
              let savedContacts = null;
              try { if (fs.existsSync(contactsFile)) savedContacts = fs.readFileSync(contactsFile, 'utf8'); } catch(e) {}
              try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
              // Restaurar contacts_cache
              if (savedContacts) {
                try {
                  fs.mkdirSync(authDir, { recursive: true });
                  fs.writeFileSync(contactsFile, savedContacts);
                } catch(e) {}
              }
              setTimeout(() => conectarSesion(targetSesion), 2000);
              await reply(`🔄 Sesión "${targetSesion}" reiniciándose. Escanea el QR en:\nhttps://erp-production-24ab.up.railway.app/`);
            }
            continue;
          }
          if (textoCmds === '!ayuda' || textoCmds === '!help') {
            await reply(
              '🤖 *Agente de Marketing SOS Digital*\n\n' +
              '📌 *Ejemplos de lo que puedes pedirme:*\n\n' +
              '🎨 "hazme una imagen de Disney+ a $35"\n' +
              '📤 "manda esta promo a los grupos"\n' +
              '📸 "súbelo como estado/story"\n' +
              '🔄 "mándalo a grupos y estado"\n' +
              '⏰ "programa esto para las 6pm todos los días"\n' +
              '📊 "dame el reporte de sesiones"\n\n' +
              '📦 *Múltiples archivos:* Manda 2+ imágenes seguidas.\n\n' +
              '🔧 *Comandos:*\n' +
              '• *!test* — probar envío a 1 grupo\n' +
              '• *!fix* — reparar sender keys corruptas\n' +
              '• *!reauth-grupos* — re-escanear QR de grupos\n' +
              '• *!reset* — limpiar historial del bot\n' +
              '• *!contactos* — diagnóstico de contactos\n' +
              '• *!estado* — ver programaciones activas\n' +
              '• *!modelo* — ver/cambiar modelo de imágenes'
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
          if (textoCmds === '!contactos' || textoCmds === '!diagnostico') {
            const lines = ['🔍 *Diagnóstico de contactos:*\n'];
            for (const sid of SESIONES_ACTIVAS) {
              const ss = sesiones[sid];
              if (!ss) continue;
              const waC = ss.contactos ? Array.from(ss.contactos).filter(j => j.endsWith('@s.whatsapp.net')).length : 0;
              const lidC = ss.contactos ? Array.from(ss.contactos).filter(j => j.endsWith('@lid')).length : 0;
              lines.push(`${ss.listo?'🟢':'🔴'} *${sid}*: ${waC} wa + ${lidC} lid = ${ss.contactos?.size || 0} total`);
            }
            const testJidList = buildStatusJidList(sesiones['personal'] || sesiones[SESIONES_ACTIVAS[0]], sesiones, SESIONES_ACTIVAS);
            lines.push(`\n📊 *statusJidList combinado:* ${testJidList.length} contactos`);
            await reply(lines.join('\n'));
            continue;
          }
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
              await reply(`${info.emoji} Modelo cambiado a *${info.nombre}*`);
            }
            continue;
          }
          // Comando ! no reconocido — dejar que la IA lo maneje
        }

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

        if (!tieneMedia && mediaBuffer.items.length > 0) {
          mediaBuffer.texto = texto;
          await reply(`📝 Caption guardado: _"${texto}"_\nSiguiendo con los archivos...`);
          continue;
        }

        if (bufferDescargado) {
          if (mediaTypeDescargado === 'image') { adminPending.imgBuffer = bufferDescargado; adminPending.mediaType = 'image'; }
          else { adminPending.videoBuffer = bufferDescargado; adminPending.mediaType = 'video'; }
        }

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

        const textoCmds = texto.toLowerCase().trim();
        // "reset" y "ayuda" sin ! también funcionan
        if (textoCmds === 'reset') {
          adminChat.length = 0;
          adminPending.accion = null;
          resetMediaBuffer();
          await reply('🔄 Historial limpiado. ¡Empezamos de cero!');
          continue;
        }
        if (textoCmds === 'ayuda') {
          await reply('🤖 Escribe *!ayuda* para ver todos los comandos y ejemplos.');
          continue;
        }

        if (!tieneMedia) {
          const ctxSesiones = SESIONES_ACTIVAS.map(id => {
            const ss = sesiones[id];
            const waC = ss?.contactos ? Array.from(ss.contactos).filter(j => j.endsWith('@s.whatsapp.net')).length : 0;
            const lidC = ss?.contactos ? Array.from(ss.contactos).filter(j => j.endsWith('@lid')).length : 0;
            return `${id}: ${ss?.listo ? '🟢 conectado (+'+ss.numero+', '+waC+' wa + '+lidC+' lid contactos)' : '🔴 offline'}`;
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
      //  BLOQUE AUTO-REPLY
      // ══════════════════════════════════════════════
      if (!cfg.autoReply) continue;
      if (esAdmin) continue;

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
      const waC = s.contactos ? Array.from(s.contactos).filter(j => j.endsWith('@s.whatsapp.net')).length : 0;
      const lidC = s.contactos ? Array.from(s.contactos).filter(j => j.endsWith('@lid')).length : 0;
      statusBadge = `<span class="badge badge-on">✅ Conectado</span>`;
      extra = `<div class="numero">+${s.numero || '—'} (${waC} wa + ${lidC} lid)</div>`;
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

app.get('/sos/ping', (req, res) => {
  const sesionId = req.query.sesion || 'grupos';
  const s = sesiones[sesionId];
  if (!s) {
    return res.json({ ok: false, estado: 'desconectado', error: `Sesión "${sesionId}" no existe en este hub` });
  }
  res.json({ ok: s.listo, estado: s.listo ? 'conectado' : 'desconectado', numero: s.numero || null, sesion: sesionId });
});

app.get('/sesion/:id/status', (req, res) => {
  const s = sesiones[req.params.id];
  if (!s) return res.json({ ok: false, error: 'Sesión no existe' });
  res.json({ ok: s.listo, numero: s.numero, tieneQR: !!s.qr });
});

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

// Reconectar suave (sin borrar auth) — para recovery de 405
app.get('/sesion/:id/reconectar-soft', auth, async (req, res) => {
  const id = req.params.id;
  const s = sesiones[id];
  if (!s) return res.json({ ok: false, error: 'Sesión no existe' });

  try {
    if (s.sock) { try { s.sock.end(); } catch(e) {} s.sock = null; }
    s.listo = false; s.qr = null; s.reconectando = false; s._retryCount = 0;
    console.log(`[${id}] 🔄 Reconexión suave solicitada manualmente`);
    setTimeout(() => conectarSesion(id), 2000);
    res.redirect('/');
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS — ENVÍO
// ═══════════════════════════════════════════════════════════════
app.post('/sos/enviar', auth, async (req, res) => {
  let { telefono, mensaje, sesion } = req.body;
  const sesionId = sesion || 'avisos';
  const s = sesiones[sesionId];

  if (!s) return res.json({ ok: false, error: `Sesión ${sesionId} no existe` });
  if (!telefono || !mensaje) return res.json({ ok: false, error: 'Faltan campos: telefono, mensaje' });
  if (!s.listo) return res.json({ ok: false, error: `Bot ${sesionId} no conectado` });

  const telLimpio = String(telefono).replace(/\D/g, '');

  try {
    // PASO 1: Verificar que el número existe en WhatsApp y obtener JID real
    let jidReal = toJid(telLimpio);
    let jidInfo = null;
    try {
      const resultado = await s.sock.onWhatsApp(telLimpio);
      const existe = resultado && resultado[0];
      if (!existe || !existe.exists) {
        console.log(`[${sesionId}] ⚠️ Número NO existe en WA: ${telLimpio}`);
        return res.json({ ok: false, error: `El número ${telLimpio} no está registrado en WhatsApp` });
      }
      jidReal = existe.jid || jidReal;
      jidInfo = existe.jid;
      console.log(`[${sesionId}] 📞 Verificado: ${telLimpio} → ${jidReal}`);
    } catch (verErr) {
      // Si onWhatsApp falla, intentar con JID construido
      console.log(`[${sesionId}] ⚠️ onWhatsApp falló (${verErr.message}), enviando con JID por defecto`);
    }

    // PASO 2: Enviar mensaje
    const sentMsg = await s.sock.sendMessage(jidReal, { text: mensaje });
    const msgId = sentMsg?.key?.id || null;

    console.log(`[${sesionId}] 📤 Aceptado por bot → ${telLimpio} (jid=${jidReal}, msgId=${msgId})`);
    res.json({
      ok: true,
      telefono: telLimpio,
      sesion: sesionId,
      jid: jidInfo,
      messageId: msgId,
      nota: 'Mensaje aceptado por el bot. No equivale a entrega confirmada.',
    });

  } catch (err) {
    console.error(`[${sesionId}] ❌ Error → ${telLimpio}:`, err.message);
    res.json({ ok: false, error: err.message });
  }
});

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

// Diagnóstico de envío — prueba sin enviar mensaje real
app.post('/sos/diagnostico', auth, async (req, res) => {
  const { telefono, sesion } = req.body;
  const sesionId = sesion || 'grupos';
  const s = sesiones[sesionId];
  const diag = { sesion: sesionId, telefono, pasos: [] };

  if (!s) {
    diag.pasos.push({ paso: 'sesion_existe', ok: false, error: 'No existe' });
    return res.json({ ok: false, diagnostico: diag });
  }
  diag.pasos.push({ paso: 'sesion_existe', ok: true });

  if (!s.listo) {
    diag.pasos.push({ paso: 'sesion_conectada', ok: false, error: 'No conectada' });
    return res.json({ ok: false, diagnostico: diag });
  }
  diag.pasos.push({ paso: 'sesion_conectada', ok: true, numero: s.numero });

  if (telefono) {
    try {
      const tel = String(telefono).replace(/\D/g, '');
      const resultado = await s.sock.onWhatsApp(tel);
      const existe = resultado && resultado[0];
      diag.pasos.push({
        paso: 'numero_en_whatsapp',
        ok: !!existe?.exists,
        jid: existe?.jid || null,
        input: tel,
      });
    } catch (err) {
      diag.pasos.push({ paso: 'numero_en_whatsapp', ok: false, error: err.message });
    }
  }

  diag.sesiones = {};
  for (const [id, ss] of Object.entries(sesiones)) {
    diag.sesiones[id] = { listo: ss.listo, numero: ss.numero, contactos: ss.contactos?.size || 0 };
  }

  res.json({ ok: true, diagnostico: diag });
});

// ═══════════════════════════════════════════════════════════════
//  RUTAS — CAMPAÑAS
// ═══════════════════════════════════════════════════════════════

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
        await s.sock.sendMessage(toJid(limpio), { image: { url: imagen_url }, caption: mensaje });
      } else if (imagen_url) {
        await s.sock.sendMessage(toJid(limpio), { image: { url: imagen_url } });
      } else {
        await s.sock.sendMessage(toJid(limpio), { text: mensaje });
      }
      resultados.push({ telefono: limpio, ok: true });
      exitosos++;
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
    } catch (err) {
      resultados.push({ telefono: limpio, ok: false, error: err.message });
    }
  }

  console.log(`[campana] ${exitosos}/${numeros.length} enviados`);
  res.json({ ok: true, total: numeros.length, exitosos, fallidos: numeros.length - exitosos, resultados });
});

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

app.post('/estado/publicar', auth, async (req, res) => {
  const { sesion, imagen_base64, caption = '', contactos = [] } = req.body;

  if (!sesion) return res.json({ success: false, message: 'Falta parámetro: sesion' });
  if (!imagen_base64) return res.json({ success: false, message: 'Falta parámetro: imagen_base64' });

  const s = sesiones[sesion];
  if (!s) return res.json({ success: false, message: `Sesión "${sesion}" no existe en este hub` });
  if (!s.listo) return res.json({ success: false, message: `Sesión "${sesion}" no está conectada` });

  try {
    const rawB64 = imagen_base64.includes(',') ? imagen_base64.split(',')[1] : imagen_base64;
    const imgBuffer = Buffer.from(rawB64, 'base64');

    const jidSet = new Set();

    if (Array.isArray(contactos) && contactos.length > 0) {
      for (const tel of contactos) {
        const limpio = String(tel).replace(/\D/g, '');
        if (limpio.length >= 10) jidSet.add(limpio + '@s.whatsapp.net');
      }
      addContactos(sesion, Array.from(jidSet));
    }

    // FIX v2: incluir ambos formatos desde contactos
    for (const jid of s.contactos) jidSet.add(jid);

    const propioJid = s.numero ? s.numero + '@s.whatsapp.net' : null;
    if (propioJid) jidSet.add(propioJid);

    const statusJidList = Array.from(jidSet).slice(0, 1000);
    console.log(`[estado] Sesión "${sesion}" → ${statusJidList.length} contactos en statusJidList`);

    if (statusJidList.length === 0) {
      return res.json({ success: false, message: `Sesión "${sesion}": sin contactos para publicar estado. Envía mensajes primero o espera que se cargue el historial.` });
    }

    const isJpeg = imgBuffer[0] === 0xFF && imgBuffer[1] === 0xD8;
    const isPng  = imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50;
    const mimetype = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : 'image/jpeg';

    const msgPayload = { image: imgBuffer, mimetype };
    if (caption && caption.trim()) msgPayload.caption = caption.trim();

    await s.sock.sendMessage('status@broadcast', msgPayload, { statusJidList });

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

function addContactos(sesionId, jids) {
  const s = sesiones[sesionId];
  if (!s) return;
  const antes = s.contactos.size;
  for (const jid of jids) {
    // FIX v2: aceptar ambos formatos
    if (jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) s.contactos.add(jid);
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

(async () => {
  const ids = SESIONES_ACTIVAS.filter(id => SESIONES_CONFIG[id]);
  console.log(`[BOOT] Sesiones activas: ${ids.join(', ')}`);
  console.log(`[BOOT] (Para cambiar: Railway → Variables → SESIONES_ACTIVAS)`);
  for (let i = 0; i < ids.length; i++) {
    console.log(`[BOOT] Iniciando sesión: ${ids[i]}...`);
    await conectarSesion(ids[i]).catch(e => console.error(`[BOOT] Error ${ids[i]}:`, e.message));
    if (i < ids.length - 1) {
      const stagger = 5000 + Math.random() * 3000;
      console.log(`[BOOT] ⏳ Esperando ${Math.round(stagger/1000)}s antes de siguiente sesión...`);
      await new Promise(r => setTimeout(r, stagger));
    }
  }
  console.log('[BOOT] ✅ Sesiones iniciadas');

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
  }, 15000);
})();
