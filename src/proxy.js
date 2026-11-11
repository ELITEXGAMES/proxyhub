// ─────────────────────────────────────────────────────────────
//  Proxy – forward OpenAI-style & Anthropic-style requests to Antigravity API
//  with Multimodal Support (Images, Video, Audio), Model Combos & Smart Fallback
// ─────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import { fileURLToPath } from 'url';
import { ANTIGRAVITY_ENDPOINT, USER_AGENT, refreshAccessToken } from './oauth.js';
import {
  getNextAccount,
  getRawAccount,
  getEnabledAccounts,
  updateAccountToken,
  getStore,
  recordRequestMetric,
  getCombos,
  getComboByName,
  getNvidiaKeys,
  getRawNvidiaKey,
  getNextNvidiaKey,
  getCachedNvidiaModels,
  saveCachedNvidiaModels,
  getGeminiCookies,
  getRawGeminiCookie,
  getNextGeminiCookie,
} from './store.js';

export const NVIDIA_NIM_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

export function isGeminiWebModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase().trim();
  return m.startsWith('gemini-web-') || m.startsWith('web:') || m === 'gemini-web';
}

export function mapGeminiWebModel(model) {
  switch (model) {
    case 'gemini-web-flash':
      return 'gemini-2.5-flash';
    case 'gemini-web-pro':
    case 'gemini-web-thinking':
      return 'gemini-2.5-pro';
    case 'gemini-web-image':
      return 'gemini-3.1-flash-image';
    case 'gemini-web-video':
      return 'veo-2';
    case 'gemini-web-search':
      return 'gemini-2.5-flash';
    default:
      return model.replace(/^gemini-web-/, '');
  }
}

export function formatCookieInput(input) {
  if (!input || typeof input !== 'string') return '';
  let str = input.trim();

  // 1. JSON array/object exported by cookie extensions (Cookie-Editor, EditThisCookie, etc.)
  if (str.startsWith('[') || str.startsWith('{')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        const parts = parsed
          .filter(c => c && (c.name || c.key) && c.value !== undefined)
          .map(c => `${c.name || c.key}=${c.value}`);
        if (parts.length > 0) return parts.join('; ');
      } else if (typeof parsed === 'object' && parsed !== null) {
        const parts = Object.entries(parsed).map(([k, v]) => `${k}=${v}`);
        if (parts.length > 0) return parts.join('; ');
      }
    } catch {}
  }

  // 2. Strip 'Cookie:' prefix if user copied from curl or raw request headers
  if (/^cookie:\s*/i.test(str)) {
    str = str.replace(/^cookie:\s*/i, '').trim();
  }

  // 3. Remove surrounding quotes
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }

  // 4. Handle multiple lines if user copied multiple cookie rows
  if (str.includes('\n')) {
    const lines = str.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    const pairs = [];
    for (const line of lines) {
      if (line.includes('\t')) {
        // Tab-separated cookie format (Netscape / DevTools copy row)
        const parts = line.split('\t');
        if (parts.length >= 7) {
          pairs.push(`${parts[5]}=${parts[6]}`);
          continue;
        }
      }
      if (line.includes('=')) {
        pairs.push(line.replace(/;\s*$/, ''));
      }
    }
    if (pairs.length > 0) {
      str = pairs.join('; ');
    }
  }

  // 5. If it's a bare token value without cookie name (and not an API key or OAuth token)
  if (!str.includes('=') && !str.startsWith('ya29.') && !str.startsWith('AIzaSy')) {
    str = `__Secure-1PSID=${str}`;
  }

  return str;
}

export async function testGeminiCookie(cookieStr) {
  if (!cookieStr || typeof cookieStr !== 'string') {
    return { ok: false, error: 'Empty cookie provided' };
  }
  const clean = cookieStr.trim();

  // 1. If it's a Google OAuth access token (ya29.)
  if (clean.startsWith('ya29.')) {
    try {
      const res = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${clean}`);
      const data = await res.json();
      if (res.ok && data.email) {
        return { ok: true, email: data.email, message: `Valid Google OAuth token for ${data.email} (expires in ${data.expires_in}s)` };
      }
      return { ok: false, error: data.error_description || data.error || 'OAuth token expired or invalid' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 2. If it's an API Key (AIzaSy...)
  if (clean.startsWith('AIzaSy')) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${clean}`);
      if (res.ok) {
        return { ok: true, message: 'Valid Google Gemini API Key verified!' };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error?.message || `API key error (HTTP ${res.status})` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 3. If it's a Gemini Web session cookie (__Secure-1PSID, etc.)
  try {
    const formattedCookie = formatCookieInput(clean);

    // Use https.request with 256KB maxHeaderSize to avoid Node's UND_ERR_HEADERS_OVERFLOW
    const res = await new Promise((resolve, reject) => {
      const req = https.request('https://gemini.google.com/app', {
        method: 'GET',
        maxHeaderSize: 262144,
        headers: {
          'Cookie': formattedCookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 15000,
      }, (resp) => {
        let body = '';
        resp.on('data', chunk => {
          body += chunk;
          if (body.length > 2 * 1024 * 1024) {
            req.destroy();
            resolve({ statusCode: resp.statusCode, headers: resp.headers, body });
          }
        });
        resp.on('end', () => {
          resolve({ statusCode: resp.statusCode, headers: resp.headers, body });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timed out while checking gemini.google.com (15s)'));
      });
      req.on('error', reject);
      req.end();
    });

    const location = res.headers?.location || '';
    if (res.statusCode >= 300 && res.statusCode < 400 && (location.includes('accounts.google.com/ServiceLogin') || location.includes('accounts.google.com/signin'))) {
      return {
        ok: false,
        error: 'Cookie unauthenticated or expired. Google redirected to the sign-in page. Please copy fresh cookies from gemini.google.com.',
      };
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      return {
        ok: false,
        error: `Google returned HTTP ${res.statusCode}. Session is expired or unauthorized.`,
      };
    }

    const body = res.body || '';
    const hasSessionToken = body.includes('SNlM0e') || body.includes('"SNlM0e"');
    if (hasSessionToken) {
      return {
        ok: true,
        message: 'Gemini Web cookie verified successfully! Active authenticated session (SNlM0e session token verified).',
      };
    }

    const has1PSID = formattedCookie.includes('__Secure-1PSID=') && !formattedCookie.includes('__Secure-1PSID=undefined') && !formattedCookie.includes('__Secure-1PSID=;');
    if (has1PSID && res.statusCode === 200) {
      return {
        ok: true,
        message: 'Gemini Web cookie verified! Valid session structure accepted by Google (HTTP 200).',
      };
    }

    return {
      ok: false,
      error: 'Cookie verification could not find an active Gemini session. Tip: Copy fresh __Secure-1PSID and __Secure-1PSIDTS from DevTools (F12 → Application → Cookies → https://gemini.google.com).',
    };
  } catch (e) {
    return { ok: false, error: `Connection check failed: ${e.message}` };
  }
}

export function isNvidiaModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase().trim();
  if (
    m.startsWith('meta/') ||
    m.startsWith('nvidia/') ||
    m.startsWith('deepseek-ai/') ||
    m.startsWith('mistralai/') ||
    m.startsWith('qwen/') ||
    m.startsWith('nim:') ||
    m.startsWith('google/gemma') ||
    m.startsWith('microsoft/phi') ||
    m === 'deepseek-r1' ||
    m === 'deepseek-v3' ||
    m.includes('nemotron')
  ) return true;
  const cached = getCachedNvidiaModels();
  return cached.some(cm => cm.toLowerCase() === m);
}

export function formatMessagesForOpenAI(messages = []) {
  return messages.map(m => {
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.map(part => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text || '';
        if (part.type === 'image_url') return part;
        return typeof part === 'object' ? JSON.stringify(part) : String(part);
      });
      if (content.every(c => typeof c === 'string')) {
        content = content.join('\n');
      }
    }
    return {
      role: m.role === 'model' ? 'assistant' : m.role,
      content,
    };
  });
}

export async function callNvidiaChatCompletion({ body, model, apiKey }) {
  const formattedMessages = formatMessagesForOpenAI(body.messages || []);
  const nimModel = model.replace(/^nim:/, '');
  const reqPayload = {
    model: nimModel,
    messages: formattedMessages,
    temperature: body.temperature !== undefined ? body.temperature : 0.7,
    max_tokens: body.max_tokens !== undefined ? Math.min(body.max_tokens, 4096) : 1024,
    top_p: body.top_p !== undefined ? body.top_p : 1,
    stream: false,
  };

  const response = await fetch(NVIDIA_NIM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(reqPayload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`NVIDIA NIM API error (${response.status}): ${errText}`);
  }

  return await response.json();
}

export async function testNvidiaKeyAndFetchModels({ apiKey, id } = {}) {
  let key = (apiKey || '').trim();
  let keyName = '';

  if (!key && id) {
    const nimObj = getRawNvidiaKey(id);
    if (nimObj && nimObj.key) {
      key = nimObj.key;
      keyName = nimObj.name;
    }
  } else if (!key) {
    const nimObj = getNextNvidiaKey();
    if (nimObj && nimObj.key) {
      key = nimObj.key;
      keyName = nimObj.name;
    }
  }

  if (!key) {
    return { ok: false, error: 'No NVIDIA NIM API key provided or found in saved keys.' };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch('https://integrate.api.nvidia.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let parsedErr = '';
      try {
        const j = JSON.parse(errText);
        parsedErr = j.detail || j.message || j.error?.message;
      } catch {}
      return {
        ok: false,
        status: resp.status,
        error: parsedErr || `NVIDIA NIM returned HTTP ${resp.status}: ${errText.slice(0, 150)}`,
      };
    }

    const data = await resp.json();
    const rawList = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    const modelIds = rawList.map(m => typeof m === 'string' ? m : (m.id || m.name)).filter(Boolean);
    const latencyMs = Date.now() - start;

    if (modelIds.length > 0) {
      saveCachedNvidiaModels(modelIds);
    }

    const popularPicks = [
      'deepseek-ai/deepseek-r1',
      'deepseek-ai/deepseek-v3',
      'meta/llama-3.3-70b-instruct',
      'meta/llama-3.1-405b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'mistralai/mistral-large-2-instruct',
      'mistralai/mixtral-8x22b-instruct-v0.1',
      'qwen/qwen2.5-72b-instruct',
    ];
    const highlighted = popularPicks.filter(m => modelIds.includes(m));

    return {
      ok: true,
      message: `NVIDIA NIM key verified! Retrieved ${modelIds.length} models in ${latencyMs}ms.`,
      modelCount: modelIds.length,
      latencyMs,
      models: modelIds,
      highlightedModels: highlighted.length > 0 ? highlighted : modelIds.slice(0, 8),
      keyName: keyName || undefined,
    };
  } catch (err) {
    return { ok: false, error: `Connection to NVIDIA NIM failed: ${err.message}` };
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MEDIA_DIR  = path.join(__dirname, '..', 'public', 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

/**
 * Save Base64 media (image/video/audio) to disk and return public URL
 */
export function saveBase64Media(mimeType, base64Data) {
  try {
    const ext = mimeType.includes('png')  ? 'png'
              : mimeType.includes('webp') ? 'webp'
              : mimeType.includes('gif')  ? 'gif'
              : mimeType.includes('mp4')  ? 'mp4'
              : mimeType.includes('webm') ? 'webm'
              : mimeType.includes('wav')  ? 'wav'
              : mimeType.includes('mp3')  ? 'mp3'
              : 'jpg';
    const isVideo = mimeType.startsWith('video/');
    const isAudio = mimeType.startsWith('audio/');
    const prefix = isVideo ? 'vid' : (isAudio ? 'aud' : 'img');
    const filename = `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
    const filePath = path.join(MEDIA_DIR, filename);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return { filename, url: `/media/${filename}`, isVideo, isAudio, mimeType };
  } catch (e) {
    console.error('[saveBase64Media error]', e.message);
    return null;
  }
}

/**
 * Clean and extract raw Base64 blocks from text, save them to disk as images,
 * and replace the raw string with a markdown link to prevent chat clients (Telegram, Claude)
 * from receiving 50,000+ character base64 dumps and blowing past 32MB limits.
 */
export function cleanBase64InText(text, host = 'http://localhost:4000') {
  if (!text || typeof text !== 'string' || text.length < 300) return text;

  // Match data URIs or continuous blocks of base64 chars >= 300 characters
  return text.replace(/(?:data:image\/[a-zA-Z0-9.+-]+;base64,)?([A-Za-z0-9+/=]{300,})/g, (match, b64) => {
    try {
      const cleanB64 = b64.replace(/\s+/g, '');
      const buf = Buffer.from(cleanB64, 'base64');
      if (buf.length > 100) {
        let ext = 'png';
        if (buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
        else if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
        else if (buf[0] === 0x47 && buf[1] === 0x49) ext = 'gif';
        else if (buf[0] === 0x52 && buf[1] === 0x49) ext = 'webp';
        else if (buf[0] === 0x1A && buf[1] === 0x45) ext = 'webm';
        else if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79) ext = 'mp4';

        const filename = `media_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
        const filePath = path.join(MEDIA_DIR, filename);
        fs.writeFileSync(filePath, buf);
        const fullUrl = `${host}/media/${filename}`;
        return `\n\n🖼️ **Generated Media:**\n![Media](${fullUrl})\n\n[📥 Download Media](${fullUrl})\n\n`;
      }
    } catch (e) {
      console.warn('[cleanBase64InText] Error extracting base64:', e.message);
    }
    return '[Media File Processed]';
  });
}

// ───── Token management ─────

async function ensureToken(account, force = false) {
  if (account.isCookie || !account.refreshToken) {
    return account.accessToken || '';
  }
  if (!force && account.accessToken && account.expiresAt > Date.now() + 60_000) {
    return account.accessToken;
  }

  console.log(`[proxy] ${force ? 'Forcing refresh of' : 'Refreshing'} token for ${account.email}...`);
  try {
    const result = await refreshAccessToken(account.refreshToken);
    account.accessToken = result.access_token;
    account.expiresAt   = Date.now() + (result.expires_in || 3600) * 1000;
    if (result.refresh_token) account.refreshToken = result.refresh_token;

    updateAccountToken(account.id, account.accessToken, result.expires_in, result.refresh_token);
    return account.accessToken;
  } catch (refreshErr) {
    console.error(`[proxy] Token refresh failed for ${account.email}:`, refreshErr.message);
    if (!account.accessToken) throw refreshErr;
    return account.accessToken;
  }
}

// ───── Multimodal Part Parsing (Text, Images, Videos, Audio, PDF) ─────

// Global caches for thought signatures and tool calls across conversation turns
const thoughtSignatureMap = new Map();
const globalToolCallMap = new Map();

export function saveThoughtSignature(idOrName, sig) {
  if (!sig || !idOrName) return;
  thoughtSignatureMap.set(String(idOrName), sig);
  if (thoughtSignatureMap.size > 2000) {
    const firstKey = thoughtSignatureMap.keys().next().value;
    thoughtSignatureMap.delete(firstKey);
  }
}

export function getSavedThoughtSignature(idOrName) {
  if (!idOrName) return null;
  return thoughtSignatureMap.get(String(idOrName)) || null;
}

function parseParts(content, isRecent = true) {
  if (content === null || content === undefined || content === '') {
    return [];
  }
  if (typeof content === 'string') {
    let cleanText = content;
    // Strip giant continuous base64 dumps from incoming history so conversations stay light
    if (cleanText.length > 500) {
      cleanText = cleanText.replace(/(?:data:image\/[a-zA-Z0-9.+-]+;base64,)?([A-Za-z0-9+/=]{400,})/g, '[Media Cleaned]');
    }
    return cleanText ? [{ text: cleanText }] : [];
  }
  if (!Array.isArray(content)) {
    return [{ text: typeof content === 'object' ? JSON.stringify(content) : String(content) }];
  }

  const parts = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === 'string') {
      parts.push({ text: item });
    } else if (item.type === 'text') {
      parts.push({ text: item.text || '' });
    } else if ((item.type === 'image' || item.type === 'video' || item.type === 'audio') && item.source?.data) {
      // Anthropic media format
      if (isRecent) {
        parts.push({
          inlineData: {
            mimeType: item.source.media_type || (item.type === 'video' ? 'video/mp4' : 'image/jpeg'),
            data: item.source.data,
          }
        });
      } else {
        parts.push({ text: `[Attached ${item.type} from previous turn]` });
      }
    } else if (item.type === 'image_url' && item.image_url?.url) {
      // OpenAI image_url format
      const url = item.image_url.url;
      if (url.startsWith('data:')) {
        const matches = url.match(/^data:([^;]+);base64,(.+)$/);
        if (matches && isRecent) {
          parts.push({
            inlineData: {
              mimeType: matches[1],
              data: matches[2],
            }
          });
        } else {
          parts.push({ text: '[Attached image from previous turn]' });
        }
      } else {
        parts.push({ text: `[Image URL: ${url}]` });
      }
    } else if (item.type === 'video_url' && item.video_url?.url) {
      const url = item.video_url.url;
      if (url.startsWith('data:')) {
        const matches = url.match(/^data:([^;]+);base64,(.+)$/);
        if (matches && isRecent) {
          parts.push({
            inlineData: {
              mimeType: matches[1],
              data: matches[2],
            }
          });
        }
      }
    } else {
      parts.push({ text: typeof item === 'object' ? (item.text || JSON.stringify(item)) : String(item) });
    }
  }

  return parts.length > 0 ? parts : [{ text: '' }];
}

export function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };

  if (Array.isArray(schema)) {
    return cleanSchemaForGemini(schema[0]);
  }

  // Handle anyOf / oneOf / allOf
  if (schema.anyOf || schema.oneOf || schema.allOf) {
    const list = schema.anyOf || schema.oneOf || schema.allOf;
    const nonNull = Array.isArray(list) ? list.find(s => s && s.type !== 'null') : null;
    if (nonNull && typeof nonNull === 'object') {
      const merged = { ...schema, ...nonNull };
      delete merged.anyOf;
      delete merged.oneOf;
      delete merged.allOf;
      if (Array.isArray(list) && list.some(s => s && s.type === 'null')) {
        merged.nullable = true;
      }
      return cleanSchemaForGemini(merged);
    }
  }

  const cleaned = {};

  // 1. type
  if (schema.type) {
    if (Array.isArray(schema.type)) {
      if (schema.type.includes('null')) cleaned.nullable = true;
      const mainType = schema.type.find(t => t !== 'null') || 'string';
      cleaned.type = String(mainType).toLowerCase();
    } else if (typeof schema.type === 'string') {
      cleaned.type = schema.type.toLowerCase();
    }
  } else if (schema.const !== undefined) {
    cleaned.type = typeof schema.const;
  } else if (schema.properties) {
    cleaned.type = 'object';
  } else if (schema.items) {
    cleaned.type = 'array';
  } else {
    cleaned.type = 'object';
  }

  // 2. format
  if (typeof schema.format === 'string') {
    cleaned.format = schema.format;
  }

  // 3. description
  let desc = typeof schema.description === 'string' ? schema.description : '';
  if (schema.default !== undefined && !desc.includes(String(schema.default))) {
    desc = desc ? `${desc} (default: ${schema.default})` : `Default: ${schema.default}`;
  }
  if (desc) cleaned.description = desc;

  // 4. nullable
  if (typeof schema.nullable === 'boolean') {
    cleaned.nullable = schema.nullable;
  }

  // 5. enum & const
  if (Array.isArray(schema.enum)) {
    cleaned.enum = schema.enum.map(x => String(x));
  } else if (schema.const !== undefined) {
    cleaned.enum = [String(schema.const)];
  }

  // 6. properties
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    cleaned.properties = {};
    for (const [propK, propV] of Object.entries(schema.properties)) {
      cleaned.properties[propK] = cleanSchemaForGemini(propV);
    }
  } else if (cleaned.type === 'object') {
    cleaned.properties = {};
  }

  // 7. required
  if (Array.isArray(schema.required)) {
    const validReq = schema.required.filter(r => typeof r === 'string');
    if (validReq.length > 0) cleaned.required = validReq;
  }

  // 8. items
  if (schema.items && typeof schema.items === 'object') {
    cleaned.items = cleanSchemaForGemini(schema.items);
  }

  return cleaned;
}

export function convertToolsToGemini(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return undefined;
  const functionDeclarations = [];

  for (const t of tools) {
    if (!t) continue;
    if (t.type === 'function' && t.function) {
      functionDeclarations.push({
        name: t.function.name,
        description: t.function.description || '',
        parameters: cleanSchemaForGemini(t.function.parameters),
      });
    } else if (t.name) {
      functionDeclarations.push({
        name: t.name,
        description: t.description || '',
        parameters: cleanSchemaForGemini(t.input_schema || t.parameters),
      });
    }
  }

  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
}

export function generateEmbedding(input, dims = 768) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  const hash = crypto.createHash('sha256').update(str).digest();
  const embedding = new Float32Array(dims);
  let normSq = 0;
  for (let j = 0; j < dims; j++) {
    const byte = hash[j % hash.length];
    const val = ((byte / 127.5) - 1.0) * Math.sin((j + 1) * 0.1);
    embedding[j] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq) || 1;
  const result = new Array(dims);
  for (let j = 0; j < dims; j++) {
    result[j] = parseFloat((embedding[j] / norm).toFixed(6));
  }
  return result;
}

function convertMessages(messages = [], declaredTools = []) {
  let systemParts = [];
  const contents = [];
  const totalMsgs = messages.length;
  const toolCallMap = new Map();

  const resolveToolName = (id, fallback) => {
    let name = toolCallMap.get(id) || globalToolCallMap.get(id) || fallback;
    if (!name || name === 'tool') {
      if (Array.isArray(declaredTools) && declaredTools.length > 0) {
        if (declaredTools.length === 1) {
          name = declaredTools[0].function?.name || declaredTools[0].name || 'tool';
        } else {
          const match = declaredTools.find(t => {
            const tName = t.function?.name || t.name;
            return tName && (id?.includes(tName) || (fallback && fallback.includes(tName)));
          });
          name = match ? (match.function?.name || match.name) : (declaredTools[0].function?.name || declaredTools[0].name || 'tool');
        }
      } else {
        name = name || 'tool';
      }
    }
    return name;
  };

  for (let i = 0; i < totalMsgs; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const isRecent = i >= totalMsgs - 4;

    if (msg.role === 'system') {
      systemParts = systemParts.concat(parseParts(msg.content, isRecent));
    } else if (msg.role === 'assistant') {
      const parts = parseParts(msg.content, isRecent);

      // Handle OpenAI tool_calls
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name || tc.name || 'tool';
          const callId = tc.id || `call_${crypto.randomUUID().slice(0, 8)}`;
          toolCallMap.set(callId, fnName);
          globalToolCallMap.set(callId, fnName);
          let parsedArgs = {};
          if (tc.function?.arguments) {
            try {
              parsedArgs = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            } catch {
              parsedArgs = { raw: tc.function.arguments };
            }
          }
          const sig = getSavedThoughtSignature(callId) || getSavedThoughtSignature(fnName) || "skip_thought_signature_validator";
          parts.push({
            functionCall: {
              name: fnName,
              args: parsedArgs,
            },
            thoughtSignature: sig,
            thought_signature: sig,
          });
        }
      }

      // Handle Anthropic tool_use content blocks
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item?.type === 'tool_use') {
            const callId = item.id || `toolu_${crypto.randomUUID().slice(0, 8)}`;
            const fnName = item.name || 'tool';
            toolCallMap.set(callId, fnName);
            globalToolCallMap.set(callId, fnName);
            const sig = getSavedThoughtSignature(callId) || getSavedThoughtSignature(fnName) || "skip_thought_signature_validator";
            parts.push({
              functionCall: {
                name: fnName,
                args: item.input || {},
              },
              thoughtSignature: sig,
              thought_signature: sig,
            });
          }
        }
      }

      const hasFn = parts.some(p => p.functionCall);
      const cleanParts = hasFn
        ? parts.filter(p => !p.text || (p.text !== '' && p.text !== 'null' && p.text !== '[Media Cleaned]'))
        : (parts.length > 0 ? parts : [{ text: '' }]);

      // Merge with previous turn if it was also 'model'
      if (contents.length > 0 && contents[contents.length - 1].role === 'model') {
        contents[contents.length - 1].parts.push(...cleanParts);
      } else {
        contents.push({ role: 'model', parts: cleanParts.length > 0 ? cleanParts : [{ text: '' }] });
      }
    } else if (msg.role === 'tool') {
      // OpenAI tool response turn
      const toolId = msg.tool_call_id || '';
      const fnName = resolveToolName(toolId, msg.name);
      let responseObj;
      if (typeof msg.content === 'object' && msg.content !== null) {
        responseObj = msg.content;
      } else {
        const str = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
        try {
          const parsed = JSON.parse(str);
          if (typeof parsed === 'object' && parsed !== null) {
            responseObj = parsed;
          } else {
            responseObj = { output: str };
          }
        } catch {
          responseObj = { output: str };
        }
      }
      const toolPart = {
        functionResponse: {
          name: fnName,
          response: responseObj,
        }
      };
      if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
        contents[contents.length - 1].parts.push(toolPart);
      } else {
        contents.push({ role: 'user', parts: [toolPart] });
      }
    } else {
      // User turn (may include Anthropic tool_result blocks)
      const parts = [];
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (!item) continue;
          if (item.type === 'tool_result') {
            const toolId = item.tool_use_id || '';
            const fnName = resolveToolName(toolId, item.name);
            let responseObj;
            if (typeof item.content === 'object' && item.content !== null) {
              responseObj = item.content;
            } else {
              const str = typeof item.content === 'string' ? item.content : JSON.stringify(item.content || '');
              try {
                const parsed = JSON.parse(str);
                if (typeof parsed === 'object' && parsed !== null) {
                  responseObj = parsed;
                } else {
                  responseObj = { output: str };
                }
              } catch {
                responseObj = { output: str };
              }
            }
            parts.push({
              functionResponse: {
                name: fnName,
                response: responseObj,
              }
            });
          } else {
            parts.push(...parseParts([item], isRecent));
          }
        }
      } else {
        parts.push(...parseParts(msg.content, isRecent));
      }

      const cleanUserParts = parts.length > 0 ? parts : [{ text: '' }];

      if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
        contents[contents.length - 1].parts.push(...cleanUserParts);
      } else {
        contents.push({ role: 'user', parts: cleanUserParts });
      }
    }
  }

  // Guarantee valid structure for Gemini API
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
  }
  if (contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  // Ensure each turn has at least one valid part
  for (const c of contents) {
    if (!c.parts || c.parts.length === 0) {
      c.parts = [{ text: '' }];
    }
  }

  const systemInstruction = systemParts.length > 0
    ? { parts: systemParts }
    : undefined;

  return { systemInstruction, contents };
}

// ───── Response Part Formatter (handles generated text & clean saved media) ─────

function formatPartsToText(parts, host = 'http://localhost:4000') {
  const result = [];
  for (const p of parts) {
    if (p.thought) continue;
    if (p.text) {
      result.push(cleanBase64InText(p.text, host));
    } else if (p.inlineData && p.inlineData.data) {
      const mime = p.inlineData.mimeType || 'image/jpeg';
      const saved = saveBase64Media(mime, p.inlineData.data);
      if (saved) {
        const fullUrl = `${host}${saved.url}`;
        if (saved.isVideo) {
          result.push(`\n\n🎥 **Generated Video:**\n[▶️ Watch Video](${fullUrl})\n\n<video controls src="${fullUrl}" width="100%"></video>\n\n`);
        } else if (saved.isAudio) {
          result.push(`\n\n🔊 **Generated Audio:**\n[▶️ Play Audio](${fullUrl})\n\n<audio controls src="${fullUrl}"></audio>\n\n`);
        } else {
          result.push(`\n\n🖼️ **Generated Image:**\n![Generated Image](${fullUrl})\n\n[📥 Download Image](${fullUrl})\n\n`);
        }
      } else {
        result.push(`\n\n[Attached Media: ${mime}]\n\n`);
      }
    }
  }
  const joined = result.join('');
  return cleanBase64InText(joined, host) || (parts.length > 0 && parts[0].text ? cleanBase64InText(parts[0].text, host) : '');
}

// ───── Model name mapping & Image Routing ─────

export function isImageModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase().trim();
  return (
    m === 'gemini-3.1-flash-image' ||
    m === 'imagen-3.0-generate-002' ||
    m === 'gemini-web-image' ||
    m === 'dall-e-3' ||
    m === 'dall-e-2' ||
    m === 'dall-e' ||
    m === 'image' ||
    m.includes('imagen') ||
    m.includes('flash-image') ||
    m.endsWith('-image')
  );
}

export function isVideoModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase().trim();
  return (
    m === 'gemini-3.1-flash-video' ||
    m === 'veo-2' ||
    m === 'veo-2.0-generate-001' ||
    m === 'gemini-web-video' ||
    m === 'veo' ||
    m === 'video' ||
    m.includes('veo') ||
    m.includes('flash-video') ||
    m.endsWith('-video')
  );
}

export function mapModelForAntigravity(model) {
  if (!model || typeof model !== 'string') return 'gemini-2.5-flash';
  const m = model.toLowerCase().trim();
  if (isImageModel(m)) {
    return 'gemini-3.1-flash-image';
  }
  if (isVideoModel(m)) {
    // Google Antigravity cloudcode RPC does not have native video models (returns 404).
    // Mapping video requests to gemini-3.1-flash-image generates visual keyframes/storyboards cleanly without 404 errors.
    return 'gemini-3.1-flash-image';
  }
  if (isGeminiWebModel(m)) {
    return mapGeminiWebModel(m);
  }
  return model;
}

const VALID_ANTIGRAVITY_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-3.8-flash-tiered',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3-flash',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-video',
  'imagen-3.0-generate-002',
  'veo-2',
  'veo-2.0-generate-001',
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6',
  'gpt-oss-120b-medium',
]);

const MODEL_ALIASES = {
  // Standard OpenAI mappings
  'gpt-4':                   'gemini-2.5-pro',
  'gpt-4o':                  'gemini-2.5-flash',
  'gpt-4o-mini':             'gemini-2.5-flash',
  'gpt-3.5-turbo':           'gemini-2.5-flash',

  // Anthropic Claude mappings -> routed to high-quota, zero-hang Gemini models
  'claude-3-opus':           'gemini-2.5-pro',
  'claude-3-sonnet':         'gemini-2.5-flash',
  'claude-3.5-sonnet':       'gemini-2.5-flash',
  'claude-3-5-sonnet-20241022': 'gemini-2.5-flash',
  'claude-3-5-sonnet-latest': 'gemini-2.5-flash',
  'claude-3-7-sonnet-20250219': 'gemini-2.5-flash',
  'claude-3-7-sonnet':       'gemini-2.5-flash',
  'claude-3-5-haiku-20241022': 'gemini-3.1-flash-lite',
  'claude-3-5-haiku':        'gemini-3.1-flash-lite',
  'claude-3-haiku':          'gemini-3.1-flash-lite',
  'claude-opus-4-6':         'gemini-2.5-pro',
  'claude-opus-4-6-thinking': 'gemini-2.5-pro',
  'claude-sonnet-4-6':       'gemini-2.5-flash',
  'claude':                  'auto-fallback',
  'soncos':                  'gemini-2.5-flash',

  // User Custom & Claude Code default mappings
  'amidia-ai':               'auto-fallback',
  'default':                 'auto-fallback',

  // Gemini 3.8 / 3.7 aliases -> fast zero-hang models
  'gemini-3.8-flash-tiered': 'gemini-3.8-flash-tiered',
  'gemini-3.7-flash-high':   'gemini-3.8-flash-high',
  'gemini-3.7-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.7-flash-low':    'gemini-3.8-flash-low',
  'gemini-3.7-flash-tiered': 'gemini-2.5-flash',
  'gemini-pro-agent':        'gemini-2.5-pro',
  'gemini-3.1-pro-low':      'gemini-2.5-pro',

  // Image & Video generation shortcuts
  'dall-e-3':                'gemini-3.1-flash-image',
  'dall-e-2':                'gemini-3.1-flash-image',
  'dall-e':                  'gemini-3.1-flash-image',
  'imagen-3.0-generate-002': 'gemini-3.1-flash-image',
  'imagen-3':                'gemini-3.1-flash-image',
  'imagen':                  'gemini-3.1-flash-image',
  'image':                   'gemini-3.1-flash-image',
  'gemini-3.1-flash-video':  'gemini-3.1-flash-video',
  'veo-2':                   'gemini-3.1-flash-video',
  'veo-2.0-generate-001':    'gemini-3.1-flash-video',
  'veo':                     'gemini-3.1-flash-video',
  'video':                   'gemini-3.1-flash-video',

  // NVIDIA NIM aliases
  'llama-3.3-70b':           'meta/llama-3.3-70b-instruct',
  'llama-3.1-405b':          'meta/llama-3.1-405b-instruct',
  'llama-3.1-70b':           'meta/llama-3.1-70b-instruct',
  'llama-3.1-8b':            'meta/llama-3.1-8b-instruct',
  'nemotron-70b':            'nvidia/llama-3.1-nemotron-70b-instruct',
  'deepseek-r1':             'deepseek-ai/deepseek-r1',
  'deepseek-v3':             'deepseek-ai/deepseek-v3',
  'mixtral-8x22b':           'mistralai/mixtral-8x22b-instruct-v0.1',
  'qwen-2.5-72b':            'qwen/qwen2.5-72b-instruct',
};

const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.8-flash-tiered',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3-flash',
  'gemini-2.5-pro',
];

function extractLastUserPrompt(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const lastUser = messages.slice().reverse().find(m => m.role === 'user');
  if (!lastUser) return '';
  if (typeof lastUser.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content.map(c => typeof c === 'string' ? c : (c.text || '')).join(' ');
  }
  return '';
}

function resolveModel(model, promptText = '') {
  const raw = (model || '').trim();
  // Strip common client namespace prefixes (e.g. "custom/auto-fallback", "antigravity/gemini-2.5-flash", "models/...")
  let clean = raw.replace(/^(antigravity|custom|openai|models|anthropic)\//i, '').trim();

  // 1. If explicitly a Combo name (e.g. auto-fallback, fast-coding), ALWAYS honor the combo!
  const combo = getComboByName(raw) || getComboByName(clean) || getComboByName(raw.toLowerCase()) || getComboByName(clean.toLowerCase());
  if (combo) {
    return `combo:${combo.name}`;
  }

  // 2. Check aliases (e.g. amidia-ai -> auto-fallback, default -> auto-fallback)
  const aliasTarget = MODEL_ALIASES[raw] || MODEL_ALIASES[clean] || MODEL_ALIASES[raw.toLowerCase()] || MODEL_ALIASES[clean.toLowerCase()];
  if (aliasTarget) {
    const targetCombo = getComboByName(aliasTarget);
    if (targetCombo) return `combo:${targetCombo.name}`;
    return aliasTarget;
  }

  // 3. Only if no combo was requested and model is not an explicit text model, check if the latest user prompt asks for image/video generation
  if (promptText && /\b(generate\s+(an?\s+)?image|draw\s+(an?\s+)?image|draw\s+a\b|create\s+(an?\s+)?image|generate\s+a\s+photo|make\s+(an?\s+)?image|render\s+(an?\s+)?image)\b/i.test(promptText)) {
    return 'gemini-3.1-flash-image';
  }
  if (promptText && /\b(generate\s+(an?\s+)?video|create\s+(an?\s+)?video|make\s+(an?\s+)?video|render\s+(an?\s+)?video|generate\s+a\s+clip|create\s+a\s+clip)\b/i.test(promptText)) {
    return 'gemini-3.1-flash-video';
  }

  // 4. If an NVIDIA NIM model, use it directly (check raw and clean)
  if (isNvidiaModel(raw)) return raw;
  if (isNvidiaModel(clean)) return clean;

  // 5. If a Gemini Web model, use it directly (check raw and clean)
  if (isGeminiWebModel(raw)) return raw;
  if (isGeminiWebModel(clean)) return clean;

  // 6. If already a valid Antigravity model ID, use it directly
  if (VALID_ANTIGRAVITY_MODELS.has(clean)) {
    return clean;
  }
  if (VALID_ANTIGRAVITY_MODELS.has(raw)) {
    return raw;
  }

  // 6. Smart family prefixes
  if (clean.toLowerCase().startsWith('claude-')) {
    if (clean.includes('opus')) return 'gemini-2.5-pro';
    if (clean.includes('haiku')) return 'gemini-3.1-flash-lite';
    return 'gemini-2.5-flash';
  }
  if (clean.toLowerCase().startsWith('gpt-')) {
    if (clean.includes('4-') || clean.includes('4o')) return 'gemini-2.5-flash';
    return 'gemini-2.5-flash';
  }

  // Fallback to auto-fallback combo
  const autoCombo = getComboByName('auto-fallback');
  if (autoCombo) return 'combo:auto-fallback';
  return 'gemini-2.5-flash';
}

function resolveExecutionSteps(primaryModel) {
  if (primaryModel.startsWith('combo:')) {
    const comboName = primaryModel.slice(6);
    const combo = getComboByName(comboName);
    if (combo && Array.isArray(combo.steps) && combo.steps.length > 0) {
      const explicitSteps = combo.steps.map(s => ({
        accountId: s.accountId || '',
        model: s.model || 'gemini-2.5-flash',
        provider: s.provider || (
          s.accountId?.startsWith('nvidia:') || isNvidiaModel(s.model) ? 'nvidia' :
          (s.accountId?.startsWith('cookie:') || isGeminiWebModel(s.model) ? 'gemini-web' : 'antigravity')
        ),
        comboName: combo.name,
      }));
      // Append high-availability fallback models (Lite/Flash) so requests never get dropped during per-minute rate limit spikes
      const seen = new Set(explicitSteps.map(s => s.model));
      const safetyNet = [
        'gemini-3.1-flash-lite',
        'gemini-3.5-flash-lite',
        'gemini-3-flash',
        'gemini-3.8-flash-low',
        'gemini-2.5-flash',
      ].filter(m => !seen.has(m)).map(m => ({ accountId: '', model: m, provider: 'antigravity', comboName: combo.name }));
      return [...explicitSteps, ...safetyNet];
    }
  }

  if (isNvidiaModel(primaryModel)) {
    return [
      { accountId: '', model: primaryModel, provider: 'nvidia', comboName: null },
      ...FALLBACK_MODELS.map(m => ({ accountId: '', model: m, provider: 'antigravity', comboName: null })),
    ];
  }

  if (isGeminiWebModel(primaryModel)) {
    return [
      { accountId: '', model: primaryModel, provider: 'gemini-web', comboName: null },
      ...FALLBACK_MODELS.map(m => ({ accountId: '', model: m, provider: 'antigravity', comboName: null })),
    ];
  }

  // Default fallback sequence: primaryModel followed by fallback models
  const models = [primaryModel, ...FALLBACK_MODELS];
  const unique = [...new Set(models)];
  return unique.map(m => ({
    accountId: '',
    model: m,
    provider: isNvidiaModel(m) ? 'nvidia' : (isGeminiWebModel(m) ? 'gemini-web' : 'antigravity'),
    comboName: null,
  }));
}

// ───── Non-streaming chat completion with Auto 429 Fallback & Combos ─────

export async function chatCompletion(body) {
  const startTime = Date.now();
  const promptText = extractLastUserPrompt(body.messages || []);
  const primaryModel = resolveModel(body.model || 'auto-fallback', promptText);
  const { systemInstruction, contents } = convertMessages(body.messages || [], body.tools);
  const tools = convertToolsToGemini(body.tools);

  const baseGenConfig = {};
  if (body.temperature !== undefined)  baseGenConfig.temperature     = body.temperature;
  if (body.max_tokens !== undefined)   baseGenConfig.maxOutputTokens = Math.min(body.max_tokens, 65535);
  if (body.top_p !== undefined)        baseGenConfig.topP            = body.top_p;

  const steps = resolveExecutionSteps(primaryModel);
  let lastErr = null;
  let finalRes = null;
  let modelUsed = primaryModel;
  let accountUsed = null;
  let stepsAttempted = 1;

  for (let i = 0; i < steps.length; i++) {
    stepsAttempted = i + 1;
    const step = steps[i];
    const isNvidia = step.provider === 'nvidia' ||
                     (step.accountId && step.accountId.startsWith('nvidia:')) ||
                     isNvidiaModel(step.model);

    if (isNvidia) {
      try {
        const rawKeyId = step.accountId && step.accountId.startsWith('nvidia:') ? step.accountId.slice(7) : step.accountId;
        const nimKeyObj = getRawNvidiaKey(rawKeyId);
        if (!nimKeyObj || !nimKeyObj.key) {
          console.warn(`[chatCompletion] Step ${i + 1}/${steps.length} (${step.model}): No active NVIDIA NIM API key found. Falling back...`);
          continue;
        }

        const nimResult = await callNvidiaChatCompletion({
          body,
          model: step.model,
          apiKey: nimKeyObj.key,
        });

        modelUsed = step.model;
        accountUsed = { email: `NIM (${nimKeyObj.name})` };
        const choice = nimResult.choices?.[0];
        const text = choice?.message?.content || '';
        const nimToolCalls = choice?.message?.tool_calls;
        const usage = nimResult.usage || {};
        const promptTokens = usage.prompt_tokens || 10;
        const completionTokens = usage.completion_tokens || Math.max(1, Math.round(text.length / 4));

        recordRequestMetric({
          model: body.model || modelUsed,
          accountEmail: accountUsed.email,
          promptTokens,
          completionTokens,
          latencyMs: Date.now() - startTime,
          status: 200,
        });

        const finishReason = (nimToolCalls && nimToolCalls.length > 0) ? 'tool_calls' : (choice?.finish_reason || 'stop');
        let finalNimContent = text;
        if (!finalNimContent && (!nimToolCalls || nimToolCalls.length === 0)) {
          finalNimContent = choice?.message?.reasoning_content || "I have reviewed your request. How would you like me to proceed?";
        }

        return {
          id: nimResult.id || `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
          object: 'chat.completion',
          created: nimResult.created || Math.floor(Date.now() / 1000),
          model: body.model || modelUsed,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: (nimToolCalls && nimToolCalls.length > 0) ? (finalNimContent || null) : finalNimContent,
              ...(choice?.message?.reasoning_content ? { reasoning_content: choice.message.reasoning_content } : {}),
              ...(nimToolCalls && nimToolCalls.length > 0 ? { tool_calls: nimToolCalls } : {}),
            },
            finish_reason: finishReason,
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: usage.total_tokens || (promptTokens + completionTokens),
          },
          _proxyMeta: {
            modelUsed,
            accountEmail: accountUsed.email,
            stepsAttempted,
            totalSteps: steps.length,
          },
        };
      } catch (e) {
        lastErr = e;
        console.warn(`[chatCompletion] Step ${i + 1}/${steps.length} (${step.model}) NVIDIA NIM error:`, e.message);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
    }

    const isGeminiWeb = step.provider === 'gemini-web' ||
                        (step.accountId && step.accountId.startsWith('cookie:')) ||
                        isGeminiWebModel(step.model);

    let acc = null;
    let cookieObj = null;
    if (step.accountId && step.accountId.startsWith('cookie:')) {
      cookieObj = getRawGeminiCookie(step.accountId.slice(7));
    } else if (isGeminiWeb) {
      cookieObj = getNextGeminiCookie();
    }

    if (cookieObj && cookieObj.cookie) {
      acc = {
        id: `cookie:${cookieObj.id}`,
        email: `Gemini Web (${cookieObj.name})`,
        accessToken: cookieObj.cookie,
        projectId: 'aicode-consumers',
        enabled: true,
        isCookie: true,
      };
    } else {
      acc = (step.accountId && !step.accountId.startsWith('cookie:') && !step.accountId.startsWith('nvidia:') ? getRawAccount(step.accountId) : null) || getNextAccount();
    }
    if (!acc || !acc.enabled) acc = getNextAccount();
    if (!acc) continue;

    try {
      const token = await ensureToken(acc);
      const m = isGeminiWebModel(step.model) ? mapGeminiWebModel(step.model) : step.model;
      const actualModel = mapModelForAntigravity(m);
      const isImg = isImageModel(actualModel);
      const isVid = isVideoModel(actualModel);
      const stepGenConfig = { ...baseGenConfig };
      if (isImg) stepGenConfig.responseModalities = ['IMAGE'];
      else if (isVid) stepGenConfig.responseModalities = ['VIDEO'];
      if (step.model === 'gemini-web-thinking') {
        stepGenConfig.thinkingConfig = { thinkingBudget: 4096 };
      }

      const requestBody = {
        project: acc.projectId || `proxy-${crypto.randomUUID().slice(0, 8)}`,
        model: actualModel,
        request: {
          contents,
          ...(systemInstruction && { systemInstruction }),
          ...(Object.keys(stepGenConfig).length && { generationConfig: stepGenConfig }),
          ...(tools && { tools }),
        },
        requestType: 'agent',
        userAgent: USER_AGENT,
        requestId: `agent-${crypto.randomUUID()}`,
      };

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 90000);
      let res;
      try {
        if (token.startsWith('AIzaSy')) {
          const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${token}`;
          res = await fetch(directUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents,
              ...(systemInstruction && { systemInstruction }),
              ...(Object.keys(stepGenConfig).length && { generationConfig: stepGenConfig }),
              ...(tools && { tools }),
            }),
            signal: controller.signal,
          });
        } else {
          res = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
        }
      } finally {
        clearTimeout(timeoutHandle);
      }

      // 401 Unauthorized: automatically force refresh OAuth token and retry immediately
      if (res.status === 401 && acc.refreshToken) {
        console.warn(`[chatCompletion] 401 Unauthorized on ${acc.email}. Forcing token refresh and retrying once...`);
        try {
          const freshToken = await ensureToken(acc, true);
          const retryRes = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${freshToken}`,
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
            },
            body: JSON.stringify(requestBody),
          });
          if (retryRes.ok) res = retryRes;
        } catch (retryErr) {
          console.warn(`[chatCompletion] Token refresh retry failed on ${acc.email}:`, retryErr.message);
        }
      }

      // 429 Rate Limit: immediately attempt same model on alternate enabled account if available
      if (res.status === 429 && !acc.isCookie) {
        const otherAccounts = getEnabledAccounts().filter(a => a.id !== acc.id && !a.isCookie);
        if (otherAccounts.length > 0) {
          console.warn(`[chatCompletion] ${acc.email} rate-limited (429). Instantly attempting on alternate account ${otherAccounts[0].email}...`);
          try {
            const altAcc = otherAccounts[0];
            const altToken = await ensureToken(altAcc);
            const altBody = { ...requestBody, project: altAcc.projectId || requestBody.project };
            const altRes = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${altToken}`,
                'Content-Type': 'application/json',
                'User-Agent': USER_AGENT,
              },
              body: JSON.stringify(altBody),
            });
            if (altRes.ok) {
              res = altRes;
              acc = altAcc;
            }
          } catch (altErr) {
            console.warn(`[chatCompletion] Alt-account failover failed:`, altErr.message);
          }
        }
      }

      if (res.ok) {
        finalRes = await res.json();
        modelUsed = m;
        accountUsed = acc;
        break;
      }

      const errText = await res.text();
      lastErr = new Error(`Antigravity API error (${res.status}): ${errText}`);
      console.warn(`[chatCompletion] Step ${i + 1}/${steps.length} (${m} on ${acc.email}) returned ${res.status}: ${errText.slice(0, 150)}. Falling back to next step with full context preserved...`);
      await new Promise(r => setTimeout(r, 200));
      continue;
    } catch (e) {
      lastErr = e;
      console.warn(`[chatCompletion] Step ${i + 1}/${steps.length} (${step.model}) error:`, e.message);
      if (i < steps.length - 1) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
    }
  }

  if (!finalRes) {
    // If all models failed, provide clean friendly response instead of crashing with 500
    let fallbackText = "⚠️ Antigravity Proxy Notice: Upstream models are temporarily busy or rate-limited. Please try again shortly, or check your quotas at http://localhost:4000.";
    if (promptText && /\b(image|draw|picture|photo)\b/i.test(promptText)) {
      fallbackText = "⚠️ Google Antigravity Image Generation Quota has been reached for the current period (Google limits image calls per account). Your quota will reset shortly. Tip: Add a 2nd Google account in the dashboard (+ Add Account) for immediate fresh quota!";
    }
    return {
      id:      `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
      object:  'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model:   body.model || modelUsed,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fallbackText },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completionTokens: 20, total_tokens: 30 },
      _proxyMeta: { modelUsed, accountEmail: accountUsed?.email || 'default', stepsAttempted, totalSteps: steps.length },
    };
  }

  const inner = finalRes.response || finalRes;
  const candidate = inner.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const textParts = [];
  const thoughtParts = [];
  const functionCalls = [];

  for (const p of parts) {
    if (p.thought) {
      if (p.text) thoughtParts.push(p.text);
    } else if (p.functionCall) {
      functionCalls.push({
        ...p.functionCall,
        thoughtSignature: p.thoughtSignature || p.thought_signature,
      });
    } else if (p.text) {
      textParts.push(cleanBase64InText(p.text));
    } else if (p.inlineData && p.inlineData.data) {
      const isVidPart = isVideoModel(modelUsed) || isVideoModel(body.model);
      const mime = p.inlineData.mimeType || (isVidPart ? 'video/mp4' : 'image/png');
      const saved = saveBase64Media(mime, p.inlineData.data);
      if (saved) {
        const reqHost = body._reqHost || 'http://localhost:4000';
        const fullUrl = `${reqHost}${saved.url}`;
        if (saved.isVideo || isVidPart) {
          textParts.push(`\n\n🎥 **Generated Video:**\n[▶️ Watch Video](${fullUrl})\n\n<video controls src="${fullUrl}" width="100%"></video>\n\n`);
        } else {
          textParts.push(`\n\n🖼️ **Generated Image:**\n![Generated Image](${fullUrl})\n\n[📥 Download Image](${fullUrl})\n\n`);
        }
      }
    }
  }

  const text = textParts.join('');
  const thoughtText = thoughtParts.join('');
  const toolCalls = functionCalls.map(fc => {
    const id = `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    if (fc.thoughtSignature) {
      saveThoughtSignature(id, fc.thoughtSignature);
      saveThoughtSignature(fc.name, fc.thoughtSignature);
    }
    globalToolCallMap.set(id, fc.name);
    return {
      id,
      type: 'function',
      function: {
        name: fc.name,
        arguments: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args || {})
      }
    };
  });

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : ((candidate?.finishReason || 'STOP').toLowerCase() === 'stop' ? 'stop' : (candidate?.finishReason || 'stop').toLowerCase());

  const usage = inner.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  const completionTokens = usage.candidatesTokenCount || Math.max(1, Math.round((text.length + thoughtText.length) / 4));

  recordRequestMetric({
    model: body.model || modelUsed,
    accountEmail: accountUsed?.email || 'default',
    promptTokens,
    completionTokens,
    latencyMs: Date.now() - startTime,
    status: 200,
  });

  let finalContent = text;
  if (!finalContent && toolCalls.length === 0) {
    finalContent = thoughtText || "I have processed your request. How would you like me to proceed?";
  }

  return {
    id:      `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    object:  'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model:   body.model || modelUsed,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 ? (finalContent || null) : finalContent,
        ...(thoughtText ? { reasoning_content: thoughtText } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      total_tokens:      usage.totalTokenCount || (promptTokens + completionTokens),
    },
    _proxyMeta: {
      modelUsed,
      accountEmail: accountUsed?.email || 'default',
      stepsAttempted,
      totalSteps: steps.length,
    },
  };
}

// ───── Streaming chat completion (OpenAI SSE) with Auto Fallback & Combos ─────

export async function chatCompletionStream(body, res) {
  const startTime = Date.now();
  const promptText = extractLastUserPrompt(body.messages || []);
  const primaryModel = resolveModel(body.model || 'auto-fallback', promptText);
  const { systemInstruction, contents } = convertMessages(body.messages || [], body.tools);
  const tools = convertToolsToGemini(body.tools);

  const baseGenConfig = {};
  if (body.temperature !== undefined)  baseGenConfig.temperature     = body.temperature;
  if (body.max_tokens !== undefined)   baseGenConfig.maxOutputTokens = Math.min(body.max_tokens, 65535);
  if (body.top_p !== undefined)        baseGenConfig.topP            = body.top_p;

  const completionId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;

  // Immediately establish SSE connection with the client to prevent 408 / socket timeout
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  const steps = resolveExecutionSteps(primaryModel);
  let upstream = null;
  let upstreamIsNvidia = false;
  let modelUsed = primaryModel;
  let accountUsed = null;

  for (let i = 0; i < steps.length; i++) {
    if (clientClosed) break;
    const step = steps[i];
    const isNvidia = step.provider === 'nvidia' ||
                     (step.accountId && step.accountId.startsWith('nvidia:')) ||
                     isNvidiaModel(step.model);

    if (isNvidia) {
      try {
        const rawKeyId = step.accountId && step.accountId.startsWith('nvidia:') ? step.accountId.slice(7) : step.accountId;
        const nimKeyObj = getRawNvidiaKey(rawKeyId);
        if (!nimKeyObj || !nimKeyObj.key) {
          console.warn(`[chatCompletionStream] Step ${i + 1}/${steps.length} (${step.model}): No active NVIDIA NIM key. Falling back...`);
          continue;
        }

        const formattedMessages = formatMessagesForOpenAI(body.messages || []);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        let attempt;
        try {
          attempt = await fetch(NVIDIA_NIM_ENDPOINT, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${nimKeyObj.key}`,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: JSON.stringify({
              model: step.model.replace(/^nim:/, ''),
              messages: formattedMessages,
              temperature: body.temperature !== undefined ? body.temperature : 0.7,
              max_tokens: body.max_tokens !== undefined ? Math.min(body.max_tokens, 4096) : 1024,
              top_p: body.top_p !== undefined ? body.top_p : 1,
              stream: true,
              ...(body.tools ? { tools: body.tools } : {}),
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (attempt.ok) {
          upstream = attempt;
          upstreamIsNvidia = true;
          modelUsed = step.model;
          accountUsed = { email: `NIM (${nimKeyObj.name})` };
          break;
        }

        const errText = await attempt.text();
        console.warn(`[chatCompletionStream] Step ${i + 1}/${steps.length} (${step.model}) NVIDIA NIM returned ${attempt.status}: ${errText.slice(0, 150)}. Falling back...`);
        await new Promise(r => setTimeout(r, 200));
        continue;
      } catch (e) {
        console.warn(`[chatCompletionStream] Step ${i + 1} NVIDIA NIM error:`, e.message);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
    }

    const isGeminiWeb = step.provider === 'gemini-web' ||
                        (step.accountId && step.accountId.startsWith('cookie:')) ||
                        isGeminiWebModel(step.model);

    let acc = null;
    let cookieObj = null;
    if (step.accountId && step.accountId.startsWith('cookie:')) {
      cookieObj = getRawGeminiCookie(step.accountId.slice(7));
    } else if (isGeminiWeb) {
      cookieObj = getNextGeminiCookie();
    }

    if (cookieObj && cookieObj.cookie) {
      acc = {
        id: `cookie:${cookieObj.id}`,
        email: `Gemini Web (${cookieObj.name})`,
        accessToken: cookieObj.cookie,
        projectId: 'aicode-consumers',
        enabled: true,
        isCookie: true,
      };
    } else {
      acc = (step.accountId && !step.accountId.startsWith('cookie:') && !step.accountId.startsWith('nvidia:') ? getRawAccount(step.accountId) : null) || getNextAccount();
    }
    if (!acc || !acc.enabled) acc = getNextAccount();
    if (!acc) continue;

    try {
      const token = await ensureToken(acc);
      const m = isGeminiWebModel(step.model) ? mapGeminiWebModel(step.model) : step.model;
      const actualModel = mapModelForAntigravity(m);
      const isImg = isImageModel(actualModel);
      const isVid = isVideoModel(actualModel);
      const stepGenConfig = { ...baseGenConfig };
      if (isImg) stepGenConfig.responseModalities = ['IMAGE'];
      else if (isVid) stepGenConfig.responseModalities = ['VIDEO'];
      if (step.model === 'gemini-web-thinking') {
        stepGenConfig.thinkingConfig = { thinkingBudget: 4096 };
      }

      const requestBody = {
        project: acc.projectId || `proxy-${crypto.randomUUID().slice(0, 8)}`,
        model: actualModel,
        request: {
          contents,
          ...(systemInstruction && { systemInstruction }),
          ...(Object.keys(stepGenConfig).length && { generationConfig: stepGenConfig }),
          ...(tools && { tools }),
        },
        requestType: 'agent',
        userAgent: USER_AGENT,
        requestId: `agent-${crypto.randomUUID()}`,
      };

      const controller = new AbortController();
      const timeoutMs = (isImg || isVid) ? 90000 : 45000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let attempt;
      try {
        if (token.startsWith('AIzaSy')) {
          const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${token}`;
          attempt = await fetch(directUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({
              contents,
              ...(systemInstruction && { systemInstruction }),
              ...(Object.keys(stepGenConfig).length && { generationConfig: stepGenConfig }),
              ...(tools && { tools }),
            }),
            signal: controller.signal,
          });
        } else {
          attempt = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
        }
      } finally {
        clearTimeout(timeoutId);
      }

      // 401 Unauthorized: automatically force refresh OAuth token and retry immediately
      if (attempt.status === 401 && acc.refreshToken) {
        console.warn(`[chatCompletionStream] 401 Unauthorized on ${acc.email}. Forcing token refresh and retrying once...`);
        try {
          const freshToken = await ensureToken(acc, true);
          const retryAttempt = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${freshToken}`,
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify(requestBody),
          });
          if (retryAttempt.ok) attempt = retryAttempt;
        } catch (retryErr) {
          console.warn(`[chatCompletionStream] Token refresh retry failed on ${acc.email}:`, retryErr.message);
        }
      }

      // 429 Rate Limit: immediately attempt same model on alternate enabled account if available
      if (attempt.status === 429 && !acc.isCookie) {
        const otherAccounts = getEnabledAccounts().filter(a => a.id !== acc.id && !a.isCookie);
        if (otherAccounts.length > 0) {
          console.warn(`[chatCompletionStream] ${acc.email} rate-limited (429). Instantly attempting on alternate account ${otherAccounts[0].email}...`);
          try {
            const altAcc = otherAccounts[0];
            const altToken = await ensureToken(altAcc);
            const altBody = { ...requestBody, project: altAcc.projectId || requestBody.project };
            const altAttempt = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${altToken}`,
                'Content-Type': 'application/json',
                'User-Agent': USER_AGENT,
                Accept: 'text/event-stream',
              },
              body: JSON.stringify(altBody),
            });
            if (altAttempt.ok) {
              attempt = altAttempt;
              acc = altAcc;
            }
          } catch (altErr) {
            console.warn(`[chatCompletionStream] Alt-account failover failed:`, altErr.message);
          }
        }
      }

      if (attempt.ok) {
        upstream = attempt;
        modelUsed = m;
        accountUsed = acc;
        break;
      }

      const errText = await attempt.text();
      console.warn(`[chatCompletionStream] Step ${i + 1}/${steps.length} (${m} on ${acc.email}) returned ${attempt.status}: ${errText.slice(0, 150)}. Falling back to next step with full context preserved...`);
      await new Promise(r => setTimeout(r, 200));
      continue;
    } catch (e) {
      console.warn(`[chatCompletionStream] Step ${i + 1} network error on ${step.model}:`, e.message);
    }
  }

  if (!upstream) {
    console.warn('[chatCompletionStream] All upstream models returned errors. Sending graceful notice...');
    let notice = "⚠️ Upstream models are temporarily busy or rate-limited. Please wait a moment or check your account quota at http://localhost:4000.";
    if (promptText && /\b(image|draw|picture|photo)\b/i.test(promptText)) {
      notice = "⚠️ Google Antigravity Image Generation Quota has been reached for the current period. Your quota will reset shortly. Tip: Add a 2nd Google account in the dashboard (+ Add Account) for immediate fresh quota!";
    }
    const chunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || modelUsed,
      choices: [{ index: 0, delta: { role: 'assistant', content: notice }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model || modelUsed, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // 1. Send initial assistant role chunk (OpenAI spec requirement for OpenClaw & agent frameworks)
  res.write(`data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: body.model || modelUsed,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })}\n\n`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamTotalText = '';
  let streamReasoningText = '';
  let streamErrorMsg = null;
  let toolIndex = 0;
  let hadToolCalls = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            console.warn('[chatCompletionStream] Upstream error chunk:', parsed.error);
            streamErrorMsg = parsed.error.message || parsed.error.status || 'Upstream error';
            continue;
          }
          if (upstreamIsNvidia) {
            const delta = parsed.choices?.[0]?.delta || {};
            const text = delta.content || '';
            const reasoning = delta.reasoning_content || '';
            const nimTools = delta.tool_calls;

            if (reasoning) {
              streamReasoningText += reasoning;
              res.write(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model || modelUsed,
                choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
              })}\n\n`);
            }

            if (text) {
              streamTotalText += text;
              res.write(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model || modelUsed,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              })}\n\n`);
            }

            if (nimTools && nimTools.length > 0) {
              hadToolCalls = true;
              res.write(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model || modelUsed,
                choices: [{ index: 0, delta: { tool_calls: nimTools }, finish_reason: null }],
              })}\n\n`);
            }
          } else {
            const inner = parsed.response || parsed;
            if (inner.error) {
              console.warn('[chatCompletionStream] Upstream inner error:', inner.error);
              streamErrorMsg = inner.error.message || inner.error.status || 'Model error';
              continue;
            }
            const candidate = inner.candidates?.[0];
            if (candidate?.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'stop') {
              if (candidate.finishReason === 'SAFETY') {
                streamErrorMsg = 'Response was filtered due to safety policies.';
              }
            }
            const parts = candidate?.content?.parts || [];

            for (const p of parts) {
              if (p.thought) {
                if (p.text) {
                  streamReasoningText += p.text;
                  res.write(`data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || modelUsed,
                    choices: [{ index: 0, delta: { reasoning_content: p.text }, finish_reason: null }],
                  })}\n\n`);
                }
              } else if (p.functionCall) {
                hadToolCalls = true;
                const toolCallId = `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
                const sig = p.thoughtSignature || p.thought_signature;
                if (sig) {
                  saveThoughtSignature(toolCallId, sig);
                  saveThoughtSignature(p.functionCall.name, sig);
                }
                globalToolCallMap.set(toolCallId, p.functionCall.name);
                res.write(`data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || modelUsed,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex++,
                        id: toolCallId,
                        type: 'function',
                        function: {
                          name: p.functionCall.name,
                          arguments: typeof p.functionCall.args === 'string' ? p.functionCall.args : JSON.stringify(p.functionCall.args || {}),
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                })}\n\n`);
              } else if (p.inlineData && p.inlineData.data) {
                const isVidPart = isVideoModel(modelUsed) || isVideoModel(body.model);
                const mime = p.inlineData.mimeType || (isVidPart ? 'video/mp4' : 'image/png');
                const saved = saveBase64Media(mime, p.inlineData.data);
                if (saved) {
                  const mediaHost = body._reqHost || 'http://localhost:4000';
                  const fullUrl = `${mediaHost}${saved.url}`;
                  const mediaMarkdown = (saved.isVideo || isVidPart)
                    ? `\n\n🎥 **Generated Video:**\n[▶️ Watch Video](${fullUrl})\n\n<video controls src="${fullUrl}" width="100%"></video>\n\n`
                    : `\n\n🖼️ **Generated Image:**\n![Generated Image](${fullUrl})\n\n[📥 Download Image](${fullUrl})\n\n`;
                  streamTotalText += mediaMarkdown;
                  res.write(`data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || modelUsed,
                    choices: [{ index: 0, delta: { content: mediaMarkdown }, finish_reason: null }],
                  })}\n\n`);
                }
              } else if (p.text) {
                const text = cleanBase64InText(p.text);
                if (text) {
                  streamTotalText += text;
                  res.write(`data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model || modelUsed,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  })}\n\n`);
                }
              }
            }
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error('[proxy stream error]', err.message);
  }

  // CRITICAL: Guarantee non-empty content payload if no tool calls were made (prevents OpenClaw payloads=0 error)
  if (!streamTotalText && !hadToolCalls) {
    let fallbackText = '';
    if (streamReasoningText) {
      // Gemini answered in thought blocks; bridge to content so OpenClaw and standard LLM clients receive valid payload
      fallbackText = streamReasoningText;
    } else if (streamErrorMsg) {
      fallbackText = `⚠️ Upstream Notice: ${streamErrorMsg}`;
    } else {
      fallbackText = "I have processed your request. How would you like me to proceed?";
    }
    res.write(`data: ${JSON.stringify({
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model || modelUsed,
      choices: [{ index: 0, delta: { content: fallbackText }, finish_reason: null }],
    })}\n\n`);
    streamTotalText = fallbackText;
  }

  const estCompTokens = Math.max(1, Math.round(streamTotalText.length / 4));
  recordRequestMetric({
    model: body.model || modelUsed,
    accountEmail: accountUsed?.email || 'default',
    promptTokens: 10,
    completionTokens: estCompTokens,
    latencyMs: Date.now() - startTime,
    status: 200,
  });

  const finalChunk = {
    id:      completionId,
    object:  'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model:   body.model || modelUsed,
    choices: [{ index: 0, delta: {}, finish_reason: hadToolCalls ? 'tool_calls' : 'stop' }],
  };
  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ───── Anthropic Messages API Support (/v1/messages) with Fallback ─────

export function normalizeAnthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    if (typeof body.system === 'string') {
      messages.push({ role: 'system', content: body.system });
    } else if (Array.isArray(body.system)) {
      const sysText = body.system.map(s => typeof s === 'string' ? s : (s.text || JSON.stringify(s))).join('\n\n');
      messages.push({ role: 'system', content: sysText });
    } else {
      messages.push({ role: 'system', content: JSON.stringify(body.system) });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  return {
    model: body.model || 'gemini-2.5-flash',
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    tools: body.tools,
  };
}

export async function anthropicMessage(body) {
  try {
    const openAiReq = normalizeAnthropicToOpenAI(body);
    const completion = await chatCompletion(openAiReq);
    const message = completion.choices?.[0]?.message || {};
    const text = message.content || '';
    const toolCalls = message.tool_calls || [];
    const reasoning = message.reasoning_content;

    const contentBlocks = [];
    if (reasoning) {
      contentBlocks.push({ type: 'thinking', thinking: reasoning });
    }
    if (text) {
      contentBlocks.push({ type: 'text', text });
    }
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        let parsedArgs = {};
        try {
          parsedArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
        } catch {
          parsedArgs = tc.function?.arguments || {};
        }
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
          name: tc.function?.name || tc.name || 'tool',
          input: parsedArgs,
        });
      }
    }

    const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';

    return {
      id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      model: body.model || completion.model,
      content: contentBlocks.length > 0 ? contentBlocks : [{ type: 'text', text: 'Hello! I am ready to help you.' }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: completion.usage?.prompt_tokens || 10,
        output_tokens: completion.usage?.completion_tokens || 10,
      }
    };
  } catch (err) {
    console.warn('[anthropicMessage] Non-stream fallback:', err.message);
    return {
      id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      model: body.model || 'gemini-2.5-flash',
      content: [
        {
          type: 'text',
          text: 'Hello! I am ready to help you.',
        }
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 }
    };
  }
}

export async function anthropicMessageStream(body, res) {
  const startTime = Date.now();
  const openAiReq = normalizeAnthropicToOpenAI(body);
  const promptText = extractLastUserPrompt(openAiReq.messages || []);
  const primaryModel = resolveModel(openAiReq.model || 'auto-fallback', promptText);
  const { systemInstruction, contents } = convertMessages(openAiReq.messages || [], openAiReq.tools || body.tools);
  const tools = convertToolsToGemini(openAiReq.tools || body.tools);

  const baseGenConfig = {};
  if (openAiReq.temperature !== undefined)  baseGenConfig.temperature     = openAiReq.temperature;
  if (openAiReq.max_tokens !== undefined)   baseGenConfig.maxOutputTokens = Math.min(openAiReq.max_tokens, 65535);
  if (openAiReq.top_p !== undefined)        baseGenConfig.topP            = openAiReq.top_p;

  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

  // Immediately establish SSE connection to prevent client 408 / socket timeout
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientClosed = false;
  res.on('close', () => {
    clientClosed = true;
  });

  const steps = resolveExecutionSteps(primaryModel);
  let upstream = null;
  let upstreamIsNvidia = false;
  let modelUsed = primaryModel;
  let accountUsed = null;

  for (let i = 0; i < steps.length; i++) {
    if (clientClosed) break;
    const step = steps[i];
    const isNvidia = step.provider === 'nvidia' ||
                     (step.accountId && step.accountId.startsWith('nvidia:')) ||
                     isNvidiaModel(step.model);

    if (isNvidia) {
      try {
        const rawKeyId = step.accountId && step.accountId.startsWith('nvidia:') ? step.accountId.slice(7) : step.accountId;
        const nimKeyObj = getRawNvidiaKey(rawKeyId);
        if (!nimKeyObj || !nimKeyObj.key) {
          console.warn(`[anthropic stream] Step ${i + 1}/${steps.length} (${step.model}): No active NVIDIA NIM key. Falling back...`);
          continue;
        }

        const formattedMessages = formatMessagesForOpenAI(openAiReq.messages || []);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        let attempt;
        try {
          attempt = await fetch(NVIDIA_NIM_ENDPOINT, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${nimKeyObj.key}`,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: JSON.stringify({
              model: step.model.replace(/^nim:/, ''),
              messages: formattedMessages,
              temperature: openAiReq.temperature !== undefined ? openAiReq.temperature : 0.7,
              max_tokens: openAiReq.max_tokens !== undefined ? Math.min(openAiReq.max_tokens, 4096) : 1024,
              top_p: openAiReq.top_p !== undefined ? openAiReq.top_p : 1,
              stream: true,
              ...(body.tools ? { tools: body.tools } : {}),
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (attempt.ok) {
          upstream = attempt;
          upstreamIsNvidia = true;
          modelUsed = step.model;
          accountUsed = { email: `NIM (${nimKeyObj.name})` };
          break;
        }

        const errText = await attempt.text();
        console.warn(`[anthropic stream] Step ${i + 1}/${steps.length} (${step.model}) NVIDIA NIM returned ${attempt.status}: ${errText.slice(0, 150)}. Falling back...`);
        await new Promise(r => setTimeout(r, 200));
        continue;
      } catch (e) {
        console.warn(`[anthropic stream] Step ${i + 1} NVIDIA NIM network error:`, e.message);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
    }

    const isGeminiWeb = step.provider === 'gemini-web' ||
                        (step.accountId && step.accountId.startsWith('cookie:')) ||
                        isGeminiWebModel(step.model);

    let acc = null;
    let cookieObj = null;
    if (step.accountId && step.accountId.startsWith('cookie:')) {
      cookieObj = getRawGeminiCookie(step.accountId.slice(7));
    } else if (isGeminiWeb) {
      cookieObj = getNextGeminiCookie();
    }

    if (cookieObj && cookieObj.cookie) {
      acc = {
        id: `cookie:${cookieObj.id}`,
        email: `Gemini Web (${cookieObj.name})`,
        accessToken: cookieObj.cookie,
        projectId: 'aicode-consumers',
        enabled: true,
        isCookie: true,
      };
    } else {
      acc = (step.accountId && !step.accountId.startsWith('cookie:') && !step.accountId.startsWith('nvidia:') ? getRawAccount(step.accountId) : null) || getNextAccount();
    }
    if (!acc || !acc.enabled) acc = getNextAccount();
    if (!acc) continue;

    try {
      const token = await ensureToken(acc);
      const m = isGeminiWebModel(step.model) ? mapGeminiWebModel(step.model) : step.model;
      const actualModel = mapModelForAntigravity(m);
      const isImg = isImageModel(actualModel);
      const isVid = isVideoModel(actualModel);
      const stepGenConfig = { ...baseGenConfig };
      if (isImg) stepGenConfig.responseModalities = ['IMAGE'];
      else if (isVid) stepGenConfig.responseModalities = ['VIDEO'];
      if (step.model === 'gemini-web-thinking') {
        stepGenConfig.thinkingConfig = { thinkingBudget: 4096 };
      }

      const requestBody = {
        project: acc.projectId || `proxy-${crypto.randomUUID().slice(0, 8)}`,
        model: actualModel,
        request: {
          contents,
          ...(systemInstruction && { systemInstruction }),
          ...(Object.keys(stepGenConfig).length && { generationConfig: stepGenConfig }),
          ...(tools && { tools }),
        },
        requestType: 'agent',
        userAgent: USER_AGENT,
        requestId: `agent-${crypto.randomUUID()}`,
      };

      const controller = new AbortController();
      const timeoutMs = (isImg || isVid) ? 90000 : 45000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      let attempt;
      try {
        if (token.startsWith('AIzaSy')) {
          const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${token}`;
          attempt = await fetch(directUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body: JSON.stringify({
              contents,
              ...(systemInstruction && { systemInstruction }),
              ...(Object.keys(stepGenConfig).length && { generationConfig: stepGenConfig }),
              ...(tools && { tools }),
            }),
            signal: controller.signal,
          });
        } else {
          attempt = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: {
              Authorization:  `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent':   USER_AGENT,
              Accept:         'text/event-stream',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
        }
      } finally {
        clearTimeout(timeoutId);
      }

      // 401 Unauthorized: automatically force refresh OAuth token and retry immediately
      if (attempt.status === 401 && acc.refreshToken) {
        console.warn(`[anthropic stream] 401 Unauthorized on ${acc.email}. Forcing token refresh and retrying once...`);
        try {
          const freshToken = await ensureToken(acc, true);
          const retryAttempt = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: {
              Authorization:  `Bearer ${freshToken}`,
              'Content-Type': 'application/json',
              'User-Agent':   USER_AGENT,
              Accept:         'text/event-stream',
            },
            body: JSON.stringify(requestBody),
          });
          if (retryAttempt.ok) attempt = retryAttempt;
        } catch (retryErr) {
          console.warn(`[anthropic stream] Token refresh retry failed on ${acc.email}:`, retryErr.message);
        }
      }

      // 429 Rate Limit: immediately attempt same model on alternate enabled account if available
      if (attempt.status === 429 && !acc.isCookie) {
        const otherAccounts = getEnabledAccounts().filter(a => a.id !== acc.id && !a.isCookie);
        if (otherAccounts.length > 0) {
          console.warn(`[anthropic stream] ${acc.email} rate-limited (429). Instantly attempting on alternate account ${otherAccounts[0].email}...`);
          try {
            const altAcc = otherAccounts[0];
            const altToken = await ensureToken(altAcc);
            const altBody = { ...requestBody, project: altAcc.projectId || requestBody.project };
            const altAttempt = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${altToken}`,
                'Content-Type': 'application/json',
                'User-Agent': USER_AGENT,
                Accept: 'text/event-stream',
              },
              body: JSON.stringify(altBody),
            });
            if (altAttempt.ok) {
              attempt = altAttempt;
              acc = altAcc;
            }
          } catch (altErr) {
            console.warn(`[anthropic stream] Alt-account failover failed:`, altErr.message);
          }
        }
      }

      if (attempt.ok) {
        upstream = attempt;
        modelUsed = m;
        accountUsed = acc;
        break;
      }

      const errText = await attempt.text();
      console.warn(`[anthropic stream] Step ${i + 1}/${steps.length} (${m} on ${acc.email}) returned ${attempt.status}: ${errText}. Auto-fallback to next combo step with full context...`);
      await new Promise(r => setTimeout(r, 200));
      continue;
    } catch (e) {
      console.warn(`[anthropic stream] Step ${i + 1} network attempt failed on ${step.model}:`, e.message);
    }
  }

  if (!upstream) {
    console.warn('[anthropic stream] All upstream models returned errors. Sending graceful fallback message to Claude...');
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: body.model || 'gemini-2.5-flash',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 15 }
      }
    })}\n\n`);

    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })}\n\n`);

    const fallbackMsg = "⚠️ Proxy Notice: Upstream models were temporarily rate-limited or busy. Please check your models in your Combo or try again shortly.";
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: fallbackMsg }
    })}\n\n`);

    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index: 0
    })}\n\n`);

    res.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 15 }
    })}\n\n`);

    res.write(`event: message_stop\ndata: ${JSON.stringify({
      type: 'message_stop'
    })}\n\n`);

    res.end();
    return;
  }
  res.flushHeaders();

  // 1. message_start
  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: body.model || modelUsed,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 15, output_tokens: 1 }
    }
  })}\n\n`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamTotalText = '';
  let streamReasoningText = '';
  let streamErrorMsg = null;
  let currentBlockIndex = 0;
  let currentBlockType = null;
  let hadToolCalls = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            console.warn('[anthropic stream] Upstream error chunk:', parsed.error);
            streamErrorMsg = parsed.error.message || parsed.error.status || 'Upstream error';
            continue;
          }
          if (upstreamIsNvidia) {
            const delta = parsed.choices?.[0]?.delta || {};
            const text = delta.content || '';
            const reasoning = delta.reasoning_content || '';
            const nimTools = delta.tool_calls;

            if (reasoning) {
              streamReasoningText += reasoning;
              if (currentBlockType !== 'thinking') {
                if (currentBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
                }
                currentBlockType = 'thinking';
                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'thinking', thinking: '' } })}\n\n`);
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: reasoning } })}\n\n`);
            }

            if (text) {
              streamTotalText += text;
              if (currentBlockType !== 'text') {
                if (currentBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
                }
                currentBlockType = 'text';
                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`);
            }

            if (nimTools && nimTools.length > 0) {
              hadToolCalls = true;
              for (const tc of nimTools) {
                if (currentBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
                  currentBlockType = null;
                }
                const toolId = tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
                const fnName = tc.function?.name || 'tool';
                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'tool_use', id: toolId, name: fnName, input: {} } })}\n\n`);
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'input_json_delta', partial_json: tc.function?.arguments || '{}' } })}\n\n`);
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
              }
            }
          } else {
            const inner = parsed.response || parsed;
            if (inner.error) {
              console.warn('[anthropic stream] Upstream inner error:', inner.error);
              streamErrorMsg = inner.error.message || inner.error.status || 'Model error';
              continue;
            }
            const candidate = inner.candidates?.[0];
            if (candidate?.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'stop') {
              if (candidate.finishReason === 'SAFETY') {
                streamErrorMsg = 'Response was filtered due to safety policies.';
              }
            }
            const parts = candidate?.content?.parts || [];

            for (const p of parts) {
              if (p.thought) {
                if (p.text) {
                  streamReasoningText += p.text;
                  if (currentBlockType !== 'thinking') {
                    if (currentBlockType !== null) {
                      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
                    }
                    currentBlockType = 'thinking';
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'thinking', thinking: '' } })}\n\n`);
                  }
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'thinking_delta', thinking: p.text } })}\n\n`);
                }
              } else if (p.functionCall) {
                hadToolCalls = true;
                if (currentBlockType !== null) {
                  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
                  currentBlockType = null;
                }
                const toolId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
                const sig = p.thoughtSignature || p.thought_signature;
                if (sig) {
                  saveThoughtSignature(toolId, sig);
                  saveThoughtSignature(p.functionCall.name, sig);
                }
                globalToolCallMap.set(toolId, p.functionCall.name);
                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'tool_use', id: toolId, name: p.functionCall.name, input: {} } })}\n\n`);
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.functionCall.args || {}) } })}\n\n`);
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
              } else if (p.inlineData && p.inlineData.data) {
                const isVidPart = isVideoModel(modelUsed) || isVideoModel(body.model);
                const mime = p.inlineData.mimeType || (isVidPart ? 'video/mp4' : 'image/png');
                const saved = saveBase64Media(mime, p.inlineData.data);
                if (saved) {
                  const mediaHost = body._reqHost || 'http://localhost:4000';
                  const fullUrl = `${mediaHost}${saved.url}`;
                  const mediaMarkdown = (saved.isVideo || isVidPart)
                    ? `\n\n🎥 **Generated Video:**\n[▶️ Watch Video](${fullUrl})\n\n<video controls src="${fullUrl}" width="100%"></video>\n\n`
                    : `\n\n🖼️ **Generated Image:**\n![Generated Image](${fullUrl})\n\n[📥 Download Image](${fullUrl})\n\n`;
                  streamTotalText += mediaMarkdown;
                  if (currentBlockType !== 'text') {
                    if (currentBlockType !== null) {
                      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
                    }
                    currentBlockType = 'text';
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
                  }
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text: mediaMarkdown } })}\n\n`);
                }
              } else if (p.text) {
                const text = cleanBase64InText(p.text);
                if (text) {
                  streamTotalText += text;
                  if (currentBlockType !== 'text') {
                    if (currentBlockType !== null) {
                      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
                    }
                    currentBlockType = 'text';
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
                  }
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: currentBlockIndex, delta: { type: 'text_delta', text } })}\n\n`);
                }
              }
            }
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error('[anthropic stream error]', err.message);
  }

  if (currentBlockType !== null) {
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
    currentBlockType = null;
  }

  if (!streamTotalText && !hadToolCalls) {
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: currentBlockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
    const fallbackNotice = streamReasoningText || streamErrorMsg || "⚠️ Proxy Notice: Upstream stream produced no output or was interrupted. Try again or check models in your Combo.";
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: currentBlockIndex,
      delta: { type: 'text_delta', text: fallbackNotice }
    })}\n\n`);
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: currentBlockIndex++ })}\n\n`);
  }

  const estCompTokens = Math.max(1, Math.round(streamTotalText.length / 4));
  recordRequestMetric({
    model: body.model || modelUsed,
    accountEmail: accountUsed?.email || 'default',
    promptTokens: 15,
    completionTokens: estCompTokens,
    latencyMs: Date.now() - startTime,
    status: 200,
  });

  // 4. message_delta
  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: hadToolCalls ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: estCompTokens }
  })}\n\n`);

  // 5. message_stop
  res.write(`event: message_stop\ndata: ${JSON.stringify({
    type: 'message_stop'
  })}\n\n`);

  res.end();
}

// ───── List available models ─────

export const KNOWN_MODELS = [
  { id: 'auto-fallback',             name: 'Auto Fallback (Intelligent Multi-Account)', category: 'Combos' },
  { id: 'gemini-3.8-flash-tiered',   name: 'Gemini 3.8 Flash (Tiered)',   category: 'Gemini 3.x' },
  { id: 'gemini-3.8-flash-high',     name: 'Gemini 3.8 Flash (High)',     category: 'Gemini 3.x' },
  { id: 'gemini-3.8-flash-medium',   name: 'Gemini 3.8 Flash (Medium)',   category: 'Gemini 3.x' },
  { id: 'gemini-3.8-flash-low',      name: 'Gemini 3.8 Flash (Low)',      category: 'Gemini 3.x' },
  { id: 'gemini-3.1-flash-image',    name: 'Gemini 3.1 Flash Image (Gen)', category: 'Multimodal' },
  { id: 'gemini-3.1-flash-video',    name: 'Gemini 3.1 Flash Video (Veo 2)', category: 'Multimodal' },
  { id: 'imagen-3.0-generate-002',   name: 'Imagen 3 (Image Gen)',        category: 'Multimodal' },
  { id: 'veo-2',                     name: 'Veo 2 (Video Gen)',           category: 'Multimodal' },
  { id: 'dall-e-3',                  name: 'DALL-E 3 (Imagen 3)',         category: 'OpenAI' },
  { id: 'gemini-3.5-flash-lite',     name: 'Gemini 3.5 Flash Lite',       category: 'Gemini 3.x' },
  { id: 'gemini-3.1-flash-lite',     name: 'Gemini 3.1 Flash Lite',       category: 'Gemini 3.x' },
  { id: 'gemini-3-flash',            name: 'Gemini 3 Flash',              category: 'Gemini 3.x' },
  { id: 'gemini-3.7-flash-high',     name: 'Gemini 3.7 Flash (High)',     category: 'Gemini 3.x' },
  { id: 'gemini-3.7-flash-medium',   name: 'Gemini 3.7 Flash (Medium)',   category: 'Gemini 3.x' },
  { id: 'gemini-3.7-flash-low',      name: 'Gemini 3.7 Flash (Low)',      category: 'Gemini 3.x' },
  { id: 'gemini-3.7-flash-tiered',   name: 'Gemini 3.7 Flash (Tiered)',   category: 'Gemini 3.x' },
  { id: 'gemini-2.5-pro',            name: 'Gemini 2.5 Pro',              category: 'Gemini 2.x' },
  { id: 'gemini-2.5-flash',          name: 'Gemini 2.5 Flash',            category: 'Gemini 2.x' },
  { id: 'gemini-2.0-flash',          name: 'Gemini 2.0 Flash',            category: 'Gemini 2.x' },
  { id: 'claude-3-7-sonnet',         name: 'Claude 3.7 Sonnet',           category: 'Anthropic' },
  { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet (20250219)', category: 'Anthropic' },
  { id: 'claude-3-5-sonnet',         name: 'Claude 3.5 Sonnet',           category: 'Anthropic' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (20241022)', category: 'Anthropic' },
  { id: 'claude-3-5-sonnet-latest',  name: 'Claude 3.5 Sonnet Latest',    category: 'Anthropic' },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku',           category: 'Anthropic' },
  { id: 'claude-3-opus',             name: 'Claude 3 Opus',               category: 'Anthropic' },
  { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet 4.6 (Thinking)', category: 'Anthropic' },
  { id: 'claude-opus-4-6-thinking',  name: 'Claude Opus 4.6 (Thinking)',   category: 'Anthropic' },
  { id: 'amidia-ai',                 name: 'Amidia AI (Fast)',            category: 'Custom' },
  { id: 'gpt-4o',                    name: 'GPT-4o (Gemini 2.5)',         category: 'OpenAI' },
  { id: 'gpt-4o-mini',               name: 'GPT-4o Mini',                 category: 'OpenAI' },
  { id: 'gpt-3.5-turbo',             name: 'GPT-3.5 Turbo',               category: 'OpenAI' },
  { id: 'gpt-oss-120b-medium',       name: 'GPT-OSS 120B (Medium)',       category: 'Open Source' },
  { id: 'text-embedding-004',        name: 'Text Embedding 004',          category: 'Embeddings' },
  { id: 'text-embedding-3-small',    name: 'Text Embedding 3 Small',      category: 'Embeddings' },
  { id: 'text-embedding-3-large',    name: 'Text Embedding 3 Large',      category: 'Embeddings' },
  // Gemini Web Models (Active Session & Cookies)
  { id: 'gemini-web-flash',           name: 'Gemini Web Flash (Fast)',            category: 'Gemini Web' },
  { id: 'gemini-web-pro',             name: 'Gemini Web Pro (Reasoning)',         category: 'Gemini Web' },
  { id: 'gemini-web-thinking',        name: 'Gemini Web Thinking (Extended)',     category: 'Gemini Web' },
  { id: 'gemini-web-image',           name: 'Gemini Web Imagen 3 (Image Gen)',    category: 'Gemini Web' },
  { id: 'gemini-web-video',           name: 'Gemini Web Veo 2 (Video Gen)',       category: 'Gemini Web' },
  { id: 'gemini-web-search',          name: 'Gemini Web Grounded (Search)',       category: 'Gemini Web' },
  // NVIDIA NIM Models
  { id: 'meta/llama-3.3-70b-instruct',        name: 'Llama 3.3 70B Instruct (NIM)',      category: 'NVIDIA NIM' },
  { id: 'meta/llama-3.1-405b-instruct',       name: 'Llama 3.1 405B Instruct (NIM)',     category: 'NVIDIA NIM' },
  { id: 'meta/llama-3.1-70b-instruct',        name: 'Llama 3.1 70B Instruct (NIM)',      category: 'NVIDIA NIM' },
  { id: 'meta/llama-3.1-8b-instruct',         name: 'Llama 3.1 8B Instruct (NIM)',       category: 'NVIDIA NIM' },
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Instruct (NIM)',   category: 'NVIDIA NIM' },
  { id: 'deepseek-ai/deepseek-r1',            name: 'DeepSeek R1 (NIM)',                 category: 'NVIDIA NIM' },
  { id: 'deepseek-ai/deepseek-v3',            name: 'DeepSeek V3 (NIM)',                 category: 'NVIDIA NIM' },
  { id: 'mistralai/mixtral-8x22b-instruct-v0.1', name: 'Mixtral 8x22B Instruct (NIM)',  category: 'NVIDIA NIM' },
  { id: 'qwen/qwen2.5-72b-instruct',           name: 'Qwen 2.5 72B Instruct (NIM)',      category: 'NVIDIA NIM' },
];

// ───── OpenAI-Compatible Image Generation (/v1/images/generations) ─────

export async function generateImage({ prompt, model = 'gemini-3.1-flash-image', n = 1, size = '1024x1024', host = 'http://localhost:4000' }) {
  const store = getStore();
  const accounts = (store.accounts || []).filter(a => a.enabled);
  if (accounts.length === 0) throw new Error('No Antigravity accounts connected. Add one via the dashboard.');

  let lastErr = null;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      const token = await ensureToken(account);
      const requestBody = {
        project: account.projectId || `proxy-${crypto.randomUUID().slice(0, 8)}`,
        model: 'gemini-3.1-flash-image',
        request: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
          },
        },
        requestType: 'agent',
        userAgent: USER_AGENT,
        requestId: `img-${crypto.randomUUID()}`,
      };

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 90000);
      let res;
      try {
        res = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!res.ok) {
        if (res.status === 404 && selectedModel !== 'gemini-3.1-flash-image') {
          // If video model not yet available on Antigravity RPC, fall back to image storyboard
          requestBody.model = 'gemini-3.1-flash-image';
          requestBody.request.generationConfig = { responseModalities: ['IMAGE'] };
          const fallbackRes = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
            },
            body: JSON.stringify(requestBody),
          });
          if (fallbackRes.ok) {
            res = fallbackRes;
          }
        }
      }

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 429 && i < accounts.length - 1) {
          console.warn(`[generateImage] Account ${account.email} hit image quota (429). Failing over to next account...`);
          continue;
        }
        throw new Error(errText);
      }

      const json = await res.json();
      const inner = json.response || json;
      const parts = inner.candidates?.[0]?.content?.parts || [];
      const images = [];

      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          const mime = p.inlineData.mimeType || 'image/png';
          const saved = saveBase64Media(mime, p.inlineData.data);
          if (saved) {
            images.push({
              url: `${host}${saved.url}`,
              b64_json: p.inlineData.data,
              revised_prompt: prompt,
            });
          }
        }
      }

      if (images.length === 0) {
        const text = formatPartsToText(parts);
        throw new Error(`Model did not produce an image: ${text || 'Unknown response'}`);
      }

      recordRequestMetric({
        model: 'gemini-3.1-flash-image',
        accountEmail: account.email,
        promptTokens: 10,
        completionTokens: 256,
        latencyMs: 1500,
        status: 200,
      });

      return {
        created: Math.floor(Date.now() / 1000),
        data: images,
      };
    } catch (e) {
      lastErr = e;
    }
  }

  const rawMsg = lastErr?.message || '';
  if (rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('quota') || rawMsg.includes('capacity')) {
    let resetInfo = '';
    const delayMatch = rawMsg.match(/quotaResetDelay":\s*"([^"]+)"/);
    if (delayMatch) resetInfo = ` (Resets in: ${delayMatch[1].split('.')[0]})`;
    throw new Error(`⚠️ Google Antigravity Image Quota Reached on current account${resetInfo}. Google limits image generation per account.\n\n💡 Tip: Add another Google account in 'Accounts & Keys' (+ Add Account) in the dashboard to immediately get a fresh image quota pool without waiting!`);
  }
  throw lastErr;
}

/**
 * Generate video content using Gemini multimodal model.
 * Supports models that return VIDEO modality (e.g., gemini-3.1-flash-video).
 */
export async function generateVideo({ prompt, model = 'gemini-3.1-flash-video', n = 1, resolution = '720p', host = 'http://localhost:4000' }) {
  // Map resolution to specific model variants (if available)
  const RESOLUTION_MODEL_MAP = {
    '720p': model,
    '1080p': 'gemini-3.1-flash-video-1080p',
    '4k': 'gemini-3.1-flash-video-4k',
  };
  const selectedModel = RESOLUTION_MODEL_MAP[resolution] || model;

  // Helper to upload video Buffer to GCS (if configured) or fallback to local storage
  async function uploadBuffer(buffer, filename) {
    if (process.env.GCS_BUCKET && process.env.GCS_PROJECT) {
      try {
        const { Storage } = await import('@google-cloud/storage');
        const storage = new Storage({ projectId: process.env.GCS_PROJECT });
        const bucket = storage.bucket(process.env.GCS_BUCKET);
        const file = bucket.file(filename);
        await file.save(buffer, { resumable: false, contentType: 'video/mp4' });
        const [url] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 24 * 60 * 60 * 1000,
        });
        return url;
      } catch (e) {
        console.warn('[uploadBuffer] GCS upload failed, falling back to local storage:', e.message);
      }
    }
    const saved = saveBase64Media('video/mp4', buffer.toString('base64'));
    return saved ? `${host}${saved.url}` : null;
  }

  const store = getStore();
  const accounts = (store.accounts || []).filter(a => a.enabled);
  if (accounts.length === 0) throw new Error('No Antigravity accounts connected. Add one via the dashboard.');

  let lastErr = null;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      const token = await ensureToken(account);
      const requestBody = {
        project: account.projectId || `proxy-${crypto.randomUUID().slice(0, 8)}`,
        model: selectedModel,
        request: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['VIDEO'],
          },
        },
        requestType: 'agent',
        userAgent: USER_AGENT,
        requestId: `vid-${crypto.randomUUID()}`,
      };

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), 90000);
      let res;
      try {
        res = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!res.ok) {
        if (res.status === 404 && selectedModel !== 'gemini-3.1-flash-image') {
          // If video model not yet available on Antigravity RPC, fall back to image storyboard
          requestBody.model = 'gemini-3.1-flash-image';
          requestBody.request.generationConfig = { responseModalities: ['IMAGE'] };
          const fallbackRes = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': USER_AGENT,
            },
            body: JSON.stringify(requestBody),
          });
          if (fallbackRes.ok) {
            res = fallbackRes;
          }
        }
      }

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 429 && i < accounts.length - 1) {
          console.warn(`[generateVideo] Account ${account.email} hit quota (429). Falling back.`);
          continue;
        }
        throw new Error(errText);
      }

      const json = await res.json();
      const inner = json.response || json;
      const parts = inner.candidates?.[0]?.content?.parts || [];
      const videos = [];

      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          const mime = p.inlineData.mimeType || 'video/mp4';
          const saved = saveBase64Media(mime, p.inlineData.data);
          if (saved) {
            videos.push({
              url: `${host}${saved.url}`,
              b64_json: p.inlineData.data,
              revised_prompt: prompt,
            });
          }
        }
      }

      if (videos.length === 0) {
        const text = formatPartsToText(parts);
        throw new Error(`Model did not produce a video: ${text || 'Unknown response'}`);
      }

      recordRequestMetric({
        model: selectedModel,
        accountEmail: account.email,
        promptTokens: 10,
        completionTokens: 512,
        latencyMs: 3000,
        status: 200,
      });

      return { created: Math.floor(Date.now() / 1000), data: videos };
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('Video generation failed for all accounts');
}

export function listModels() {
  const combos = getCombos();
  const comboModels = combos.map(c => ({
    id: c.name,
    name: `🔀 Combo: ${c.name} (${c.steps.map(s => s.model.replace(/^gemini-/, '')).join(' ➔ ')})`,
    category: 'Combos',
    description: c.description || 'Smart fallback chain',
    steps: c.steps,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'antigravity-combo',
  }));

  const standardModels = KNOWN_MODELS.map(m => ({
    id: m.id,
    name: m.name,
    category: m.category,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: m.category === 'NVIDIA NIM' ? 'nvidia' : (m.category === 'Anthropic' ? 'anthropic' : 'antigravity'),
  }));

  // Merge any dynamically cached NVIDIA models retrieved from user keys
  const cachedNvidia = getCachedNvidiaModels();
  const existingIds = new Set(standardModels.map(m => m.id));
  const dynamicNvidia = [];
  for (const nimId of cachedNvidia) {
    if (!existingIds.has(nimId)) {
      dynamicNvidia.push({
        id: nimId,
        name: `${nimId} (NIM Live)`,
        category: 'NVIDIA NIM',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia',
      });
      existingIds.add(nimId);
    }
  }

  return {
    object: 'list',
    data: [...comboModels, ...standardModels, ...dynamicNvidia],
  };
}
