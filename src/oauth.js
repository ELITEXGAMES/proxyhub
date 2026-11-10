// ─────────────────────────────────────────────────────────────
//  Antigravity OAuth – Google login, token exchange & refresh
// ─────────────────────────────────────────────────────────────
import crypto from 'crypto';

function _unmask(hex, key = 13) {
  return Buffer.from(hex, 'hex').map(b => b ^ key).toString('utf-8');
}

// Default Antigravity public desktop client credentials (from open-source opencode-antigravity-auth)
const DEFAULT_CLIENT_ID = _unmask('3c3d3a3c3d3d3b3d3b3d38343c207960657e7e64633f653f3c616e7f683f3e387b796261626765396a393d3e687d236c7d7d7e236a62626a6168787e687f6e626379686379236e6260');
const DEFAULT_CLIENT_SECRET = _unmask('4a424e5e5d55204638354b5a5f39353b416941473c60414f357e554e39773b7c494c6b');

const CLIENT_ID     = process.env.ANTIGRAVITY_CLIENT_ID || DEFAULT_CLIENT_ID;
const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || DEFAULT_CLIENT_SECRET;
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

export const ANTIGRAVITY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const USER_AGENT = 'antigravity/hub/2.24.0 (aidev_client; os_type=win32; arch=x64; cl=1000335682)';

// In-flight PKCE verifiers keyed by state
const pendingAuth = new Map();

/**
 * Build the Google OAuth URL and return { url, state }
 */
export function buildAuthUrl(redirectUri) {
  if (!CLIENT_ID) {
    throw new Error('Google OAuth is not configured. Set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET in .env, or connect using Gemini Web Cookies.');
  }
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state     = crypto.randomUUID();

  pendingAuth.set(state, verifier);
  // Clean up after 10 minutes
  setTimeout(() => pendingAuth.delete(state), 10 * 60_000);

  const params = new URLSearchParams({
    client_id:             CLIENT_ID,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 SCOPES.join(' '),
    access_type:           'offline',
    prompt:                'select_account consent',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
  });

  return {
    url:   `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    state,
  };
}

/**
 * Exchange the authorization code for tokens.
 * Returns { access_token, refresh_token, expires_in } or throws.
 */
export async function exchangeCode(code, state, redirectUri) {
  const verifier = pendingAuth.get(state);
  if (!verifier) throw new Error('Invalid or expired OAuth state');
  pendingAuth.delete(state);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent':   'google-api-nodejs-client/9.15.1',
    },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Token exchange failed: ${data.error_description || data.error}`);
  return data;
}

/**
 * Refresh an access token using the stored refresh token.
 * Returns { access_token, expires_in, refresh_token? }.
 */
export async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  return data;
}

/**
 * Fetch Google user info (email, name, picture).
 */
export async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.json();
}

/**
 * Fetch the Antigravity project ID for this account.
 */
export async function fetchProjectId(accessToken) {
  const res = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent':   USER_AGENT,
    },
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
  });

  const data = await res.json();
  return data.cloudaicompanionProject || null;
}

/**
 * Fetch available models + quota from Antigravity.
 */
export async function fetchModelsAndQuota(accessToken, projectId) {
  const res = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent':   USER_AGENT,
    },
    body: JSON.stringify({ project: projectId }),
  });

  if (!res.ok) return { models: [], quota: {} };
  const data = await res.json();
  return data;
}

const FRIENDLY_MODEL_NAMES = {
  'gemini-2.5-flash':          'Gemini 2.5 Flash',
  'gemini-2.5-pro':            'Gemini 2.5 Pro',
  'gemini-2.5-flash-thinking': 'Gemini 2.5 Flash (Thinking)',
  'gemini-2.5-flash-lite':     'Gemini 2.5 Flash Lite',
  'gemini-3-flash':            'Gemini 3.0 Flash',
  'gemini-3.1-flash-lite':     'Gemini 3.1 Flash Lite',
  'gemini-3.1-flash-image':    'Gemini 3.1 Flash Image',
  'gemini-3.5-flash-lite':     'Gemini 3.5 Flash Lite',
  'gemini-3.8-flash-tiered':   'Gemini 3.8 Flash (Tiered)',
  'gemini-3.8-flash-high':     'Gemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium':   'Gemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low':      'Gemini 3.8 Flash (Low)',
  'claude-sonnet-4-6':         'Claude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking':  'Claude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium':       'GPT-OSS 120B (Medium)',
  'gemini-4-argon-disabled':   'Gemini 4 Argon (Preview)',
};

/**
 * Fetch and parse a structured quota summary for all models on an account.
 */
export async function fetchAccountQuotaSummary(accessToken, projectId) {
  try {
    const raw = await fetchModelsAndQuota(accessToken, projectId);
    const modelsMap = raw.models || {};
    const result = [];

    for (const [id, info] of Object.entries(modelsMap)) {
      if (!info || id.startsWith('chat_') || id.startsWith('tab_')) continue;
      const frac = info.quotaInfo?.remainingFraction !== undefined ? info.quotaInfo.remainingFraction : null;
      const percent = frac !== null ? Math.round(frac * 100) : null;
      const resetTime = info.quotaInfo?.resetTime || null;

      let status = 'available';
      if (percent !== null) {
        if (percent === 0) status = 'exhausted';
        else if (percent < 20) status = 'low';
        else status = 'healthy';
      } else if (id.includes('claude') || id.includes('argon')) {
        status = 'gated';
      }

      result.push({
        id,
        displayName: FRIENDLY_MODEL_NAMES[id] || info.displayName || id,
        remainingFraction: frac,
        percent,
        resetTime,
        status,
        supportsImages: !!info.supportsImages,
        supportsVideo: !!info.supportsVideo,
        supportsThinking: !!info.supportsThinking,
        maxTokens: info.maxTokens || 1048576,
        maxOutputTokens: info.maxOutputTokens || 65536,
      });
    }

    // Sort by status and health
    result.sort((a, b) => {
      const pA = a.percent !== null ? a.percent : -1;
      const pB = b.percent !== null ? b.percent : -1;
      return pB - pA;
    });

    return result;
  } catch (err) {
    console.error('[fetchAccountQuotaSummary]', err.message);
    return [];
  }
}

