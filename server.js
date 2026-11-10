// ─────────────────────────────────────────────────────────────
//  Express server – Antigravity proxy + dashboard
// ─────────────────────────────────────────────────────────────
import fs from 'fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Zero-dependency .env loader (safe, non-destructive, loads local .env if present)
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const k = trimmed.slice(0, eqIdx).trim();
          let v = trimmed.slice(eqIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (process.env[k] === undefined) {
            process.env[k] = v;
          }
        }
      }
    } catch {}
  }
}
loadEnv();

// Helper to sanitize error messages and logs so internal paths/tokens never leak
export function sanitizeErrorMessage(msg) {
  if (!msg || typeof msg !== 'string') return 'An internal server error occurred.';
  let clean = msg.replace(/([a-zA-Z]:\\[^:\n\r\t"]+)/g, '[internal path]')
                 .replace(/(\/[a-zA-Z0-9_\-\.\/]+)/g, (m) => m.startsWith('/v1') || m.startsWith('/api') ? m : '[internal path]');
  clean = clean.replace(/ya29\.[a-zA-Z0-9_\-]+/g, 'ya29.[REDACTED]')
               .replace(/AIzaSy[a-zA-Z0-9_\-]+/g, 'AIzaSy[REDACTED]')
               .replace(/agp-[a-zA-Z0-9_\-]+/g, 'agp-[REDACTED]')
               .replace(/nvapi-[a-zA-Z0-9_\-]+/g, 'nvapi-[REDACTED]');
  return clean;
}

// Daemon background logging support (preserves log descriptors across process exit)
if (process.env.AG_LOG_FILE) {
  try {
    const logDir = path.dirname(process.env.AG_LOG_FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logStream = fs.createWriteStream(process.env.AG_LOG_FILE, { flags: 'a' });
    const formatArg = (a) => typeof a === 'object' ? JSON.stringify(a) : String(a);
    console.log = (...args) => { try { logStream.write(args.map(formatArg).join(' ') + '\n'); } catch {} };
    console.error = (...args) => { try { logStream.write('[ERROR] ' + args.map(formatArg).join(' ') + '\n'); } catch {} };
    console.warn = (...args) => { try { logStream.write('[WARN] ' + args.map(formatArg).join(' ') + '\n'); } catch {} };
  } catch {}
}

import { buildAuthUrl, exchangeCode, fetchUserInfo, fetchProjectId, fetchAccountQuotaSummary } from './src/oauth.js';
import {
  getAccounts,
  getRawAccount,
  addAccount,
  removeAccount,
  toggleAccount,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  rotateApiKey,
  validateApiKey,
  getNvidiaKeys,
  addNvidiaKey,
  removeNvidiaKey,
  toggleNvidiaKey,
  getRawNvidiaKey,
  getNextNvidiaKey,
  getCachedNvidiaModels,
  getGeminiCookies,
  addGeminiCookie,
  removeGeminiCookie,
  toggleGeminiCookie,
  getRawGeminiCookie,
  getNextGeminiCookie,
  updateGeminiCookieStatus,
  getAnalytics,
  clearAnalytics,
  getCombos,
  saveCombo,
  deleteCombo,
  getComboByName,
} from './src/store.js';
import {
  chatCompletion,
  chatCompletionStream,
  listModels,
  anthropicMessage,
  anthropicMessageStream,
  generateImage,
  generateVideo,
  testGeminiCookie,
  testNvidiaKeyAndFetchModels,
  formatCookieInput,
  isGeminiWebModel,
  generateEmbedding,
} from './src/proxy.js';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(cookieParser());

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Sliding window in-memory rate limiter middleware
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_RPM, 10) || 120;
const ipRequestCounts = new Map();

function rateLimiter(req, res, next) {
  if (req.path === '/v1/health' || req.path.startsWith('/media') || (req.method === 'GET' && !req.path.startsWith('/api'))) {
    return next();
  }
  const ip = req.ip || req.connection?.remoteAddress || '127.0.0.1';
  const now = Date.now();
  const entry = ipRequestCounts.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  } else {
    entry.count++;
  }
  ipRequestCounts.set(ip, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({
      error: {
        message: 'Rate limit exceeded. Please slow down and try again shortly.',
        type: 'rate_limit_exceeded',
      },
    });
  }
  next();
}
app.use(rateLimiter);

// ---------- Cookie‑based auth middleware ----------
function cookieAuth(req, res, next) {
  const cookieToken = req.cookies?.ag_token;
  // If a Bearer token is not already present, use the cookie token.
  if (cookieToken && !req.headers['authorization']) {
    req.headers['authorization'] = `Bearer ${cookieToken}`;
  }
  next();
}
app.use(cookieAuth);
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Invalid JSON in request body', type: 'invalid_request_error' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: 'Request payload too large (max 50MB)', type: 'invalid_request_error' } });
  }
  next(err);
});

// Static assets with cache-busting for HTML
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.use('/media', express.static(path.join(__dirname, 'public', 'media')));

// Legal pages
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/acceptable-use', (req, res) => res.sendFile(path.join(__dirname, 'public', 'acceptable-use.html')));
app.get('/disclaimer', (req, res) => res.sendFile(path.join(__dirname, 'public', 'disclaimer.html')));

// ---------- Helper middleware ----------
function requireApiKey(req, res, next) {
  const auth = req.headers['authorization']
    || req.headers['x-api-key']
    || req.headers['anthropic-auth-token']
    || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (process.env.PROXY_API_KEY && token === process.env.PROXY_API_KEY) return next();
  if (validateApiKey(token)) return next();
  const host = req.headers['host'] || '';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return next();
  }
  res.status(401).json({ error: { message: 'Invalid or missing API key', type: 'invalid_request_error' } });
}

// Dashboard routes protected optionally by DASHBOARD_PASSWORD
function dashboardAuth(req, res, next) {
  if (process.env.DASHBOARD_PASSWORD) {
    const provided = req.headers['x-dashboard-password'] || req.cookies?.ag_dash_pwd;
    if (provided !== process.env.DASHBOARD_PASSWORD) {
      return res.status(401).json({ error: { message: 'Unauthorized dashboard access', type: 'authentication_error' } });
    }
  }
  return next();
}

// ---------- Health ----------
app.get('/v1/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ---------- Model list (OpenAI compatible) ----------
app.get('/v1/models', requireApiKey, async (req, res) => {
  try {
    const models = listModels();
    res.json(models);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: { message: sanitizeErrorMessage(e.message) } });
  }
});

// ---------- Chat completions (OpenAI compatible) ----------
app.post('/v1/chat/completions', requireApiKey, async (req, res) => {
  const stream = req.body.stream === true || req.body.stream === 'true';
  const reqHost = req.get('host') ? `${req.protocol}://${req.get('host')}` : 'http://localhost:4000';
  req.body._reqHost = reqHost;
  console.log(`[OpenAI Chat Request] model=${req.body.model} stream=${stream} from=${req.ip}`);
  try {
    if (stream) {
      await chatCompletionStream(req.body, res);
    } else {
      const result = await chatCompletion(req.body);
      res.json(result);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: { message: sanitizeErrorMessage(e.message), type: 'server_error' } });
  }
});

// ---------- Legacy Text Completions (OpenAI compatible) ----------
const handleLegacyCompletions = async (req, res) => {
  try {
    const prompt = req.body?.prompt || '';
    const stream = req.body?.stream === true || req.body?.stream === 'true';
    const chatBody = {
      model: req.body?.model || 'auto-fallback',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: req.body?.max_tokens,
      temperature: req.body?.temperature,
      top_p: req.body?.top_p,
      stream,
    };

    if (stream) {
      await chatCompletionStream(chatBody, res);
    } else {
      const result = await chatCompletion(chatBody);
      const text = result.choices?.[0]?.message?.content || '';
      res.json({
        id: result.id || `cmpl-${crypto.randomUUID().slice(0, 12)}`,
        object: 'text_completion',
        created: result.created || Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [{
          text,
          index: 0,
          logprobs: null,
          finish_reason: result.choices?.[0]?.finish_reason || 'stop',
        }],
        usage: result.usage,
      });
    }
  } catch (e) {
    console.error('[completions error]', e.message);
    res.status(500).json({ error: { message: e.message, type: 'server_error' } });
  }
};
app.post('/v1/completions', requireApiKey, handleLegacyCompletions);
app.post('/completions', requireApiKey, handleLegacyCompletions);

// ---------- Embeddings (OpenAI compatible) ----------
const handleEmbeddings = async (req, res) => {
  try {
    const input = req.body?.input;
    if (!input) {
      return res.status(400).json({ error: { message: 'Missing required field: input', type: 'invalid_request_error' } });
    }
    const model = req.body?.model || 'text-embedding-004';
    const items = Array.isArray(input) ? input : [input];
    const data = items.map((item, index) => ({
      object: 'embedding',
      index,
      embedding: generateEmbedding(item),
    }));
    const totalChars = items.reduce((sum, item) => sum + (typeof item === 'string' ? item.length : JSON.stringify(item).length), 0);
    const tokenEst = Math.max(1, Math.round(totalChars / 4));

    res.json({
      object: 'list',
      data,
      model,
      usage: {
        prompt_tokens: tokenEst,
        total_tokens: tokenEst,
      },
    });
  } catch (e) {
    console.error('[embeddings error]', e.message);
    res.status(500).json({ error: { message: e.message, type: 'server_error' } });
  }
};
app.post('/v1/embeddings', requireApiKey, handleEmbeddings);
app.post('/embeddings', requireApiKey, handleEmbeddings);

// ---------- Anthropic Messages API (Claude Code / Anthropic SDK compatible) ----------
const handleAnthropicMessages = async (req, res) => {
  const reqHost = req.get('host') ? `${req.protocol}://${req.get('host')}` : 'http://localhost:4000';
  req.body._reqHost = reqHost;
  console.log('[Claude Request Headers]:', JSON.stringify({
    'user-agent': req.headers['user-agent'],
    'anthropic-version': req.headers['anthropic-version'],
    'content-type': req.headers['content-type'],
  }));
  if (process.env.DEBUG_VERBOSE_LOGS === 'true') {
    console.log('[Claude Request Full Body]:', JSON.stringify({
      model: req.body?.model,
      stream: req.body?.stream,
      max_tokens: req.body?.max_tokens,
      system: req.body?.system,
      messages: req.body?.messages,
      tools: req.body?.tools ? req.body.tools.map(t => t.name) : undefined,
    }, null, 2));
  } else {
    console.log(`[Claude Request] model=${req.body?.model} stream=${req.body?.stream} messages=${Array.isArray(req.body?.messages) ? req.body.messages.length : 0}`);
  }

  const stream = req.body.stream === true || req.body.stream === 'true';
  try {
    if (stream) {
      await anthropicMessageStream(req.body, res);
    } else {
      const result = await anthropicMessage(req.body);
      res.json(result);
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({
      type: 'error',
      error: {
        type: 'api_error',
        message: sanitizeErrorMessage(e.message),
      }
    });
  }
};

app.post('/v1/messages', requireApiKey, handleAnthropicMessages);
app.post('/messages', requireApiKey, handleAnthropicMessages);

// ---------- OpenAI Video Generation API (/v1/videos/generations)
const handleVideoGeneration = async (req, res) => {
  try {
    const host = req.get('host') ? `${req.protocol}://${req.get('host')}` : 'http://localhost:4000';
    const prompt = req.body?.prompt || '';
    if (!prompt) return res.status(400).json({ error: { message: 'Prompt is required' } });
    const result = await generateVideo({
      prompt,
      model: req.body?.model || 'gemini-3.1-flash-video',
      n: req.body?.n || 1,
      host,
    });
    res.json(result);
  } catch (e) {
    console.error('[videos/generations error]', e.message);
    res.status(500).json({ error: { message: e.message, type: 'server_error' } });
  }
};

// existing image generation handler
const handleImageGeneration = async (req, res) => {
  try {
    const host = req.get('host') ? `${req.protocol}://${req.get('host')}` : 'http://localhost:4000';
    const prompt = req.body?.prompt || '';
    if (!prompt) return res.status(400).json({ error: { message: 'Prompt is required' } });
    const result = await generateImage({
      prompt,
      model: req.body?.model || 'gemini-3.1-flash-image',
      n: req.body?.n || 1,
      size: req.body?.size || '1024x1024',
      host,
    });
    res.json(result);
  } catch (e) {
    console.error('[images/generations error]', e.message);
    res.status(500).json({ error: { message: e.message, type: 'server_error' } });
  }
};

// ---------- Register routes (replace previous image handler definitions)
app.post('/v1/images/generations', requireApiKey, handleImageGeneration);
app.post('/images/generations', requireApiKey, handleImageGeneration);
app.post('/api/media/generate', dashboardAuth, handleImageGeneration);

// Register video endpoint
app.post('/v1/videos/generations', requireApiKey, handleVideoGeneration);
app.post('/videos/generations', requireApiKey, handleVideoGeneration);
app.post('/api/media/generate/video', dashboardAuth, handleVideoGeneration);

// ---------- OAuth flow ----------
app.get('/auth/login', (req, res) => {
  const redirectUri = `http://localhost:${PORT}/auth/callback`;
  const { url } = buildAuthUrl(redirectUri);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send('Missing code or state in OAuth callback');
  }
  const redirectUri = `http://localhost:${PORT}/auth/callback`;
  try {
    const tokenData = await exchangeCode(code, state, redirectUri);
    const userInfo = await fetchUserInfo(tokenData.access_token);
    let projectId = null;
    try {
      projectId = await fetchProjectId(tokenData.access_token);
    } catch (e) {
      console.warn('[oauth] Could not fetch project ID:', e.message);
    }
    addAccount({
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      refreshToken: tokenData.refresh_token,
      projectId,
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in,
    });
    res.redirect('/?login=success');
  } catch (e) {
    console.error('[oauth] Callback error:', e);
    res.redirect('/?login=error&msg=' + encodeURIComponent(e.message));
  }
});

// ---------- Dashboard API (no API key required – browser access) ----------
app.get('/api/accounts', dashboardAuth, (req, res) => {
  res.json(getAccounts());
});
app.delete('/api/accounts/:id', dashboardAuth, (req, res) => {
  removeAccount(req.params.id);
  res.json({ success: true });
});
app.post('/api/accounts/:id/toggle', dashboardAuth, (req, res) => {
  toggleAccount(req.params.id);
  res.json({ success: true });
});

app.get('/api/keys', dashboardAuth, (req, res) => {
  res.json(getApiKeys());
});
app.post('/api/keys', dashboardAuth, (req, res) => {
  const name = req.body?.name || '';
  const key = createApiKey(name);
  // Return the FULL key only on creation (never shown again)
  res.json({ id: key.id, key: key.key, name: key.name, createdAt: key.createdAt });
});
app.delete('/api/keys/:id', dashboardAuth, (req, res) => {
  deleteApiKey(req.params.id);
  res.json({ success: true });
});
app.post('/api/keys/:id/rotate', dashboardAuth, (req, res) => {
  const newKey = rotateApiKey(req.params.id);
  if (!newKey) return res.status(404).json({ error: { message: 'Key not found' } });
  res.json({ id: newKey.id, key: newKey.key, name: newKey.name, createdAt: newKey.createdAt });
});

// ---------- NVIDIA NIM API Keys Management ----------
app.get('/api/nvidia-keys', dashboardAuth, (req, res) => {
  res.json(getNvidiaKeys());
});

app.post('/api/nvidia-keys', dashboardAuth, (req, res) => {
  try {
    const { key, name } = req.body || {};
    const created = addNvidiaKey({ key, name });
    res.json({ ok: true, key: { id: created.id, name: created.name, key: created.key.slice(0, 10) + '...' + created.key.slice(-4), addedAt: created.addedAt } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/nvidia-keys/:id', dashboardAuth, (req, res) => {
  removeNvidiaKey(req.params.id);
  res.json({ ok: true });
});

app.post('/api/nvidia-keys/:id/toggle', dashboardAuth, (req, res) => {
  toggleNvidiaKey(req.params.id);
  res.json({ ok: true });
});

app.post('/api/nvidia-keys/test', dashboardAuth, async (req, res) => {
  const { key, id, model } = req.body || {};
  try {
    const result = await testNvidiaKeyAndFetchModels({ apiKey: key, id });
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/nvidia-keys/models', dashboardAuth, (req, res) => {
  res.json({ ok: true, models: getCachedNvidiaModels() });
});

// ---------- Gemini Web Cookies Management ----------
app.get('/api/cookies', dashboardAuth, (req, res) => {
  res.json(getGeminiCookies());
});

app.post('/api/cookies', dashboardAuth, (req, res) => {
  try {
    const { cookie, name } = req.body || {};
    const formatted = formatCookieInput(cookie);
    const created = addGeminiCookie({ cookie: formatted, name });
    res.json({ ok: true, cookie: { id: created.id, name: created.name, addedAt: created.addedAt } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/cookies/:id', dashboardAuth, (req, res) => {
  removeGeminiCookie(req.params.id);
  res.json({ ok: true });
});

app.post('/api/cookies/:id/toggle', dashboardAuth, (req, res) => {
  toggleGeminiCookie(req.params.id);
  res.json({ ok: true });
});

app.post(['/api/cookies/test', '/api/cookie/test'], dashboardAuth, async (req, res) => {
  let cookieVal = req.body?.cookie;
  const cookieId = req.body?.id;

  if (!cookieVal && cookieId) {
    const raw = getRawGeminiCookie(cookieId);
    if (raw) cookieVal = raw.cookie;
  }
  if (!cookieVal) {
    cookieVal = req.cookies?.ag_token;
  }

  if (!cookieVal) {
    return res.status(400).json({ ok: false, error: 'No cookie value or ID provided to test' });
  }

  const result = await testGeminiCookie(cookieVal);
  if (cookieId) {
    updateGeminiCookieStatus(cookieId, result.ok ? 'valid' : 'invalid', result.error || null);
  }
  res.json(result);
});

// ---------- Dashboard Model Testing API ----------
app.get('/api/models', dashboardAuth, (req, res) => {
  res.json(listModels());
});

app.post('/api/models/test', dashboardAuth, async (req, res) => {
  const model = req.body?.model || 'gemini-2.5-flash';
  const start = Date.now();
  try {
    const result = await chatCompletion({
      model,
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      max_tokens: 1024,
    });
    const latencyMs = Date.now() - start;
    const reply = result.choices?.[0]?.message?.content || '(No response text)';
    res.json({ ok: true, model, reply, latencyMs });
  } catch (err) {
    const latencyMs = Date.now() - start;
    res.json({ ok: false, model, error: err.message, latencyMs });
  }
});

// ---------- Combos API (Smart Fallback Routing Chains) ----------
app.get('/api/combos', dashboardAuth, (req, res) => {
  res.json(getCombos());
});

app.post('/api/combos', dashboardAuth, (req, res) => {
  try {
    const { id, name, description, steps } = req.body || {};
    const combo = saveCombo({ id, name, description, steps });
    res.json({ ok: true, combo });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/combos/:id', dashboardAuth, (req, res) => {
  deleteCombo(req.params.id);
  res.json({ ok: true });
});

app.post('/api/combos/test', dashboardAuth, async (req, res) => {
  const comboName = req.body?.name || 'auto-fallback';
  const start = Date.now();
  try {
    const result = await chatCompletion({
      model: comboName,
      messages: [{ role: 'user', content: 'Say "Combo test passed!" in one sentence.' }],
      max_tokens: 100,
    });
    const latencyMs = Date.now() - start;
    const reply = result.choices?.[0]?.message?.content || '(No response)';
    res.json({
      ok: true,
      combo: comboName,
      reply,
      latencyMs,
      modelUsed: result._proxyMeta?.modelUsed || result.model,
      accountEmail: result._proxyMeta?.accountEmail || 'default',
      stepsAttempted: result._proxyMeta?.stepsAttempted || 1,
      totalSteps: result._proxyMeta?.totalSteps || 1,
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    res.json({ ok: false, combo: comboName, error: err.message, latencyMs });
  }
});

// ---------- All Accounts Live Quota API ----------
app.get('/api/quotas', dashboardAuth, async (req, res) => {
  try {
    const accounts = getAccounts();
    const quotasByAccount = [];

    for (const acc of accounts) {
      const raw = getRawAccount(acc.id);
      if (!raw || !raw.refreshToken) continue;

      let token = raw.accessToken;
      if (!token || raw.expiresAt < Date.now() + 60_000) {
        try {
          const { refreshAccessToken } = await import('./src/oauth.js');
          const refreshed = await refreshAccessToken(raw.refreshToken);
          token = refreshed.access_token;
        } catch (e) {
          console.warn(`[quotas] Could not refresh token for ${acc.email}:`, e.message);
        }
      }

      if (!token) {
        quotasByAccount.push({
          account: acc,
          models: [],
          error: 'Token refresh failed',
        });
        continue;
      }

      const modelsSummary = await fetchAccountQuotaSummary(token, raw.projectId);
      quotasByAccount.push({
        account: acc,
        models: modelsSummary,
      });
    }

    res.json({ ok: true, accounts: quotasByAccount });
  } catch (e) {
    console.error('[api/quotas error]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Analytics API ----------
app.get('/api/analytics', dashboardAuth, (req, res) => {
  res.json(getAnalytics());
});
app.post('/api/analytics/clear', dashboardAuth, (req, res) => {
  res.json(clearAnalytics());
});

// ---------- Fallback for SPA ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`\n  ✅ Antigravity Proxy running at http://localhost:${PORT}`);
  console.log(`  📋 Dashboard:  http://localhost:${PORT}/`);
  console.log(`  🔗 API Base:   http://localhost:${PORT}/v1\n`);
});
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 300000;
