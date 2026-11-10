// ─────────────────────────────────────────────────────────────
//  Persistent store – accounts + API keys (JSON file backed)
// ─────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  if (process.env.AG_DATA_DIR) {
    return path.resolve(process.env.AG_DATA_DIR);
  }

  const userHomeDir = path.join(os.homedir(), '.antigravity-proxy');
  const localDir = path.join(__dirname, '..', 'data');
  const userStoreFile = path.join(userHomeDir, 'store.json');
  const localStoreFile = path.join(localDir, 'store.json');

  // 1. If user home store exists, use it
  if (fs.existsSync(userStoreFile)) {
    return userHomeDir;
  }

  // 2. If local store exists (e.g. initial dev checkout), seed user home directory
  if (fs.existsSync(localStoreFile)) {
    try {
      if (!fs.existsSync(userHomeDir)) {
        fs.mkdirSync(userHomeDir, { recursive: true });
      }
      fs.copyFileSync(localStoreFile, userStoreFile);
      return userHomeDir;
    } catch {
      return localDir;
    }
  }

  // 3. Fallback to user home directory
  return userHomeDir;
}

export const DATA_DIR = resolveDataDir();
export const STORE_FILE = path.join(DATA_DIR, 'store.json');

// Default state
const DEFAULT_ANALYTICS = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  modelUsage: {},      // { [model]: { requests, promptTokens, completionTokens, totalTokens } }
  accountUsage: {},    // { [email]: { requests, tokens } }
  recentRequests: [],  // last 50 requests
};

const DEFAULT_STORE = {
  accounts:      [],    // { id, email, name, picture, refreshToken, projectId, accessToken, expiresAt, addedAt, enabled, lastUsed }
  apiKeys:       [],    // { id, key, name, createdAt, lastUsed }
  nvidiaKeys:    [],    // { id, key, name, addedAt, enabled, lastUsed }
  geminiCookies: [],    // { id, cookie, name, addedAt, enabled, lastUsed, status, error }
  combos:        [],    // { id, name, description, steps: [{ accountId, model, provider }] }
  cachedNvidiaModels: [], // Cached array of model IDs retrieved from NVIDIA NIM API
  activeAccountIndex: 0,
  activeNvidiaKeyIndex: 0,
  activeGeminiCookieIndex: 0,
  analytics: DEFAULT_ANALYTICS,
};

let store = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (fs.existsSync(STORE_FILE)) {
    try {
      store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      // Ensure all fields exist
      store.accounts           = store.accounts           || [];
      store.apiKeys            = store.apiKeys            || [];
      store.nvidiaKeys         = store.nvidiaKeys         || [];
      store.geminiCookies      = store.geminiCookies      || [];
      store.cachedNvidiaModels = store.cachedNvidiaModels || [];
      if (store.activeAccountIndex === undefined) store.activeAccountIndex = 0;
      if (store.activeNvidiaKeyIndex === undefined) store.activeNvidiaKeyIndex = 0;
      if (store.activeGeminiCookieIndex === undefined) store.activeGeminiCookieIndex = 0;
    } catch {
      store = { ...DEFAULT_STORE };
    }
  } else {
    store = { ...DEFAULT_STORE };
  }
}

function save() {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

export function getStore() {
  if (!store) load();
  return store;
}

// ───── Accounts ─────

export function getAccounts() {
  const s = getStore();
  return s.accounts.map(a => ({
    id:        a.id,
    email:     a.email,
    name:      a.name,
    picture:   a.picture,
    projectId: a.projectId,
    addedAt:   a.addedAt,
    enabled:   a.enabled,
    lastUsed:  a.lastUsed,
    hasToken:  !!a.accessToken && a.expiresAt > Date.now(),
  }));
}

export function addAccount({ email, name, picture, refreshToken, projectId, accessToken, expiresIn }) {
  const s = getStore();
  // Deduplicate by email
  const existing = s.accounts.findIndex(a => a.email === email);
  const account = {
    id:           crypto.randomUUID(),
    email,
    name:         name || email,
    picture:      picture || '',
    refreshToken,
    projectId:    projectId || '',
    accessToken:  accessToken || '',
    expiresAt:    accessToken ? Date.now() + (expiresIn || 3600) * 1000 : 0,
    addedAt:      Date.now(),
    enabled:      true,
    lastUsed:     0,
  };

  if (existing >= 0) {
    // Update existing
    account.id      = s.accounts[existing].id;
    account.addedAt = s.accounts[existing].addedAt;
    s.accounts[existing] = account;
  } else {
    s.accounts.push(account);
  }

  save();
  return account;
}

export function removeAccount(id) {
  const s = getStore();
  s.accounts = s.accounts.filter(a => a.id !== id);
  if (s.activeAccountIndex >= s.accounts.length) s.activeAccountIndex = 0;
  save();
}

export function toggleAccount(id) {
  const s = getStore();
  const acc = s.accounts.find(a => a.id === id);
  if (acc) { acc.enabled = !acc.enabled; save(); }
}

export function getRawAccount(identifier) {
  const s = getStore();
  if (!identifier) return getNextAccount();
  return s.accounts.find(a => a.id === identifier || a.email === identifier) || getNextAccount();
}

export function updateAccountToken(id, accessToken, expiresIn, newRefreshToken) {
  const s = getStore();
  const acc = s.accounts.find(a => a.id === id);
  if (acc) {
    acc.accessToken = accessToken;
    acc.expiresAt   = Date.now() + (expiresIn || 3600) * 1000;
    if (newRefreshToken) acc.refreshToken = newRefreshToken;
    save();
  }
}

/**
 * Pick the next enabled account (round-robin rotation).
 * Returns the raw account object or null.
 */
export function getNextAccount() {
  const s = getStore();
  const enabled = s.accounts.filter(a => a.enabled);
  if (enabled.length === 0) return null;

  // Round-robin index
  let idx = s.activeAccountIndex % enabled.length;
  const acc = enabled[idx];
  acc.lastUsed = Date.now();

  // Advance for next call
  s.activeAccountIndex = (idx + 1) % enabled.length;
  save();
  return acc;
}

// ───── API Keys ─────

export function getApiKeys() {
  const s = getStore();
  return s.apiKeys.map(k => ({
    id:        k.id,
    key:       k.key.slice(0, 8) + '...' + k.key.slice(-4),   // masked
    name:      k.name,
    createdAt: k.createdAt,
    lastUsed:  k.lastUsed,
  }));
}

export function createApiKey(name) {
  const s = getStore();
  const key = 'agp-' + crypto.randomBytes(32).toString('hex');
  const entry = {
    id:        crypto.randomUUID(),
    key,
    name:      name || `Key ${s.apiKeys.length + 1}`,
    createdAt: Date.now(),
    lastUsed:  0,
  };
  s.apiKeys.push(entry);
  save();
  return { ...entry };   // return with full key (only shown once)
}

export function deleteApiKey(id) {
  const s = getStore();
  s.apiKeys = s.apiKeys.filter(k => k.id !== id);
  save();
}

export function rotateApiKey(id) {
  const s = getStore();
  const entry = s.apiKeys.find(k => k.id === id);
  if (!entry) return null;
  const newKey = 'agp-' + crypto.randomBytes(32).toString('hex');
  entry.key = newKey;
  entry.createdAt = Date.now();
  save();
  return { ...entry };
}

/**
 * Validate an incoming API key. Returns true if valid.
 * Also updates lastUsed.
 */
export function validateApiKey(key) {
  const s = getStore();
  // If no keys exist, allow unauthenticated (localhost only)
  if (s.apiKeys.length === 0) return true;
  const entry = s.apiKeys.find(k => k.key === key);
  if (entry) { entry.lastUsed = Date.now(); save(); return true; }
  return false;
}

// ───── NVIDIA NIM API Keys ─────

export function getNvidiaKeys() {
  const s = getStore();
  s.nvidiaKeys = s.nvidiaKeys || [];
  return s.nvidiaKeys.map(k => ({
    id:        k.id,
    key:       k.key ? (k.key.slice(0, 10) + '...' + k.key.slice(-4)) : '',
    name:      k.name,
    addedAt:   k.addedAt,
    enabled:   k.enabled !== false,
    lastUsed:  k.lastUsed || 0,
  }));
}

export function addNvidiaKey({ key, name }) {
  const s = getStore();
  s.nvidiaKeys = s.nvidiaKeys || [];
  const cleanKey = (key || '').trim();
  if (!cleanKey) throw new Error('NVIDIA NIM API key is required');

  const existing = s.nvidiaKeys.find(k => k.key === cleanKey);
  if (existing) {
    if (name) existing.name = name;
    existing.enabled = true;
    save();
    return existing;
  }

  const newKey = {
    id:       crypto.randomUUID(),
    key:      cleanKey,
    name:     name || `NIM Key ${s.nvidiaKeys.length + 1}`,
    addedAt:  Date.now(),
    enabled:  true,
    lastUsed: 0,
  };
  s.nvidiaKeys.push(newKey);
  save();
  return newKey;
}

export function removeNvidiaKey(id) {
  const s = getStore();
  s.nvidiaKeys = (s.nvidiaKeys || []).filter(k => k.id !== id);
  save();
}

export function toggleNvidiaKey(id) {
  const s = getStore();
  const k = (s.nvidiaKeys || []).find(item => item.id === id);
  if (k) {
    k.enabled = !k.enabled;
    save();
  }
}

export function getRawNvidiaKey(identifier) {
  const s = getStore();
  s.nvidiaKeys = s.nvidiaKeys || [];
  if (identifier && identifier !== 'auto') {
    const found = s.nvidiaKeys.find(k => k.id === identifier || k.name === identifier || k.key === identifier);
    if (found && found.enabled !== false) return found;
  }
  return getNextNvidiaKey();
}

export function getNextNvidiaKey() {
  const s = getStore();
  s.nvidiaKeys = s.nvidiaKeys || [];
  const enabled = s.nvidiaKeys.filter(k => k.enabled !== false);
  if (enabled.length === 0) return null;

  s.activeNvidiaKeyIndex = s.activeNvidiaKeyIndex || 0;
  let idx = s.activeNvidiaKeyIndex % enabled.length;
  const k = enabled[idx];
  k.lastUsed = Date.now();
  s.activeNvidiaKeyIndex = (idx + 1) % enabled.length;
  save();
  return k;
}

export function getCachedNvidiaModels() {
  const s = getStore();
  return s.cachedNvidiaModels || [];
}

export function saveCachedNvidiaModels(models) {
  const s = getStore();
  if (Array.isArray(models)) {
    s.cachedNvidiaModels = Array.from(new Set(models));
    save();
  }
  return s.cachedNvidiaModels || [];
}

// ───── Gemini Web Cookies ─────

function maskCookie(cookie = '') {
  if (!cookie) return '';
  if (cookie.length <= 16) return cookie.slice(0, 4) + '...' + cookie.slice(-4);
  return cookie.slice(0, 10) + '...' + cookie.slice(-6);
}

export function getGeminiCookies() {
  const s = getStore();
  s.geminiCookies = s.geminiCookies || [];
  return s.geminiCookies.map(c => ({
    id:        c.id,
    name:      c.name,
    cookie:    maskCookie(c.cookie),
    addedAt:   c.addedAt,
    enabled:   c.enabled !== false,
    lastUsed:  c.lastUsed || 0,
    status:    c.status || 'untested',
    error:     c.error || null,
  }));
}

export function addGeminiCookie({ cookie, name }) {
  const s = getStore();
  s.geminiCookies = s.geminiCookies || [];
  const cleanCookie = (cookie || '').trim();
  if (!cleanCookie) throw new Error('Cookie value is required');

  const existing = s.geminiCookies.find(c => c.cookie === cleanCookie);
  if (existing) {
    if (name) existing.name = name;
    existing.enabled = true;
    save();
    return existing;
  }

  const newEntry = {
    id:        crypto.randomUUID(),
    cookie:    cleanCookie,
    name:      name || `Gemini Web Cookie ${s.geminiCookies.length + 1}`,
    addedAt:   Date.now(),
    enabled:   true,
    lastUsed:  0,
    status:    'untested',
    error:     null,
  };
  s.geminiCookies.push(newEntry);
  save();
  return newEntry;
}

export function removeGeminiCookie(id) {
  const s = getStore();
  s.geminiCookies = (s.geminiCookies || []).filter(c => c.id !== id);
  save();
}

export function toggleGeminiCookie(id) {
  const s = getStore();
  const c = (s.geminiCookies || []).find(item => item.id === id);
  if (c) {
    c.enabled = !c.enabled;
    save();
  }
}

export function updateGeminiCookieStatus(id, status, error = null) {
  const s = getStore();
  const c = (s.geminiCookies || []).find(item => item.id === id);
  if (c) {
    c.status = status;
    c.error = error;
    save();
  }
}

export function getRawGeminiCookie(identifier) {
  const s = getStore();
  s.geminiCookies = s.geminiCookies || [];
  if (identifier && identifier !== 'auto') {
    const found = s.geminiCookies.find(c => c.id === identifier || c.name === identifier);
    if (found && found.enabled !== false) return found;
  }
  return getNextGeminiCookie();
}

export function getNextGeminiCookie() {
  const s = getStore();
  s.geminiCookies = s.geminiCookies || [];
  const enabled = s.geminiCookies.filter(c => c.enabled !== false);
  if (enabled.length === 0) return null;

  s.activeGeminiCookieIndex = s.activeGeminiCookieIndex || 0;
  let idx = s.activeGeminiCookieIndex % enabled.length;
  const c = enabled[idx];
  c.lastUsed = Date.now();
  s.activeGeminiCookieIndex = (idx + 1) % enabled.length;
  save();
  return c;
}

// ───── Analytics ─────

export function recordRequestMetric({ model, accountEmail, promptTokens = 0, completionTokens = 0, latencyMs = 0, status = 200, error = null }) {
  const s = getStore();
  if (!s.analytics) {
    s.analytics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      modelUsage: {},
      accountUsage: {},
      recentRequests: [],
    };
  }

  const a = s.analytics;
  a.totalRequests = (a.totalRequests || 0) + 1;
  if (status >= 200 && status < 300) {
    a.successfulRequests = (a.successfulRequests || 0) + 1;
  } else {
    a.failedRequests = (a.failedRequests || 0) + 1;
  }

  const pTok = Number(promptTokens) || 0;
  const cTok = Number(completionTokens) || 0;
  const totTokens = pTok + cTok;
  a.totalPromptTokens = (a.totalPromptTokens || 0) + pTok;
  a.totalCompletionTokens = (a.totalCompletionTokens || 0) + cTok;
  a.totalTokens = (a.totalTokens || 0) + totTokens;

  // Model breakdown
  a.modelUsage = a.modelUsage || {};
  if (!a.modelUsage[model]) {
    a.modelUsage[model] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  a.modelUsage[model].requests += 1;
  a.modelUsage[model].promptTokens += pTok;
  a.modelUsage[model].completionTokens += cTok;
  a.modelUsage[model].totalTokens += totTokens;

  // Account breakdown
  if (accountEmail) {
    a.accountUsage = a.accountUsage || {};
    if (!a.accountUsage[accountEmail]) {
      a.accountUsage[accountEmail] = { requests: 0, tokens: 0 };
    }
    a.accountUsage[accountEmail].requests += 1;
    a.accountUsage[accountEmail].tokens += totTokens;
  }

  // Recent requests log (keep last 50)
  a.recentRequests = a.recentRequests || [];
  a.recentRequests.unshift({
    id: crypto.randomUUID().slice(0, 8),
    timestamp: Date.now(),
    model: model || 'unknown',
    accountEmail: accountEmail || 'unknown',
    promptTokens: pTok,
    completionTokens: cTok,
    totalTokens: totTokens,
    latencyMs: Math.round(latencyMs) || 0,
    status: status || 200,
    error: error ? String(error).slice(0, 120) : null,
  });
  if (a.recentRequests.length > 50) a.recentRequests.length = 50;

  save();
}

export function getAnalytics() {
  const s = getStore();
  if (!s.analytics) {
    s.analytics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      modelUsage: {},
      accountUsage: {},
      recentRequests: [],
    };
    save();
  }
  return s.analytics;
}

export function clearAnalytics() {
  const s = getStore();
  s.analytics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    modelUsage: {},
    accountUsage: {},
    recentRequests: [],
  };
  save();
  return s.analytics;
}

// ───── Model Combos (Smart Fallback Routing) ─────

const DEFAULT_COMBOS = [
  {
    id: 'combo-auto-fallback',
    name: 'auto-fallback',
    description: 'Smart fallback: 2.5 Flash -> Tiered -> 3.8 High -> 2.5 Pro',
    steps: [
      { accountId: '', model: 'gemini-2.5-flash' },
      { accountId: '', model: 'gemini-3.8-flash-tiered' },
      { accountId: '', model: 'gemini-3.8-flash-high' },
      { accountId: '', model: 'gemini-2.5-pro' },
    ],
  },
  {
    id: 'combo-fast-coding',
    name: 'fast-coding',
    description: 'Lightning fast chain for coding and code generation',
    steps: [
      { accountId: '', model: 'gemini-2.5-flash' },
      { accountId: '', model: 'gemini-3.8-flash-high' },
      { accountId: '', model: 'gemini-3.1-flash-lite' },
    ],
  },
  {
    id: 'combo-heavy-reasoning',
    name: 'heavy-reasoning',
    description: 'Maximum depth reasoning chain',
    steps: [
      { accountId: '', model: 'gemini-2.5-pro' },
      { accountId: '', model: 'gemini-3.8-flash-high' },
      { accountId: '', model: 'gemini-2.5-flash' },
    ],
  },
  {
    id: 'combo-image-gen',
    name: 'image-gen',
    description: 'Image Generation chain: Flash Image -> Imagen 3 -> Gemini Web Image',
    steps: [
      { accountId: '', model: 'gemini-3.1-flash-image' },
      { accountId: '', model: 'imagen-3.0-generate-002' },
      { accountId: '', model: 'gemini-web-image' },
    ],
  },
  {
    id: 'combo-video-gen',
    name: 'video-gen',
    description: 'Video Generation chain: Flash Video -> Veo 2 -> Gemini Web Video',
    steps: [
      { accountId: '', model: 'gemini-3.1-flash-video' },
      { accountId: '', model: 'veo-2' },
      { accountId: '', model: 'gemini-web-video' },
    ],
  },
];

export function getCombos() {
  const s = getStore();
  s.combos = s.combos || [];
  let updated = false;
  for (const def of DEFAULT_COMBOS) {
    if (!s.combos.some(c => c.name.toLowerCase() === def.name.toLowerCase())) {
      s.combos.push(def);
      updated = true;
    }
  }
  if (updated) save();
  return s.combos;
}

export function saveCombo({ id, name, description, steps }) {
  const s = getStore();
  s.combos = s.combos || [];
  const cleanName = (name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!cleanName) throw new Error('Combo name cannot be empty');

  const existingIdx = s.combos.findIndex(c => c.id === id || c.name.toLowerCase() === cleanName);
  const combo = {
    id: id || `combo-${crypto.randomUUID().slice(0, 8)}`,
    name: cleanName,
    description: description || '',
    steps: Array.isArray(steps) ? steps.map(st => ({
      accountId: st.accountId || '',
      model: st.model || 'gemini-2.5-flash',
      provider: st.provider || (
        st.accountId?.startsWith('nvidia:') ? 'nvidia' :
        (st.accountId?.startsWith('cookie:') || (st.model && st.model.startsWith('gemini-web-')) ? 'gemini-web' : undefined)
      ),
    })) : [],
    updatedAt: Date.now(),
  };

  if (existingIdx >= 0) {
    combo.id = s.combos[existingIdx].id;
    s.combos[existingIdx] = combo;
  } else {
    s.combos.push(combo);
  }

  save();
  return combo;
}

export function deleteCombo(id) {
  const s = getStore();
  s.combos = (s.combos || []).filter(c => c.id !== id && c.name !== id);
  save();
}

export function getComboByName(name) {
  if (!name) return null;
  const s = getStore();
  const clean = name.trim().toLowerCase().replace(/^antigravity\//, '');
  return (s.combos || []).find(c => c.name.toLowerCase() === clean || c.id === clean);
}

