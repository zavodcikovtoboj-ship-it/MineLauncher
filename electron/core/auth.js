'use strict';

const crypto = require('crypto');

const DEVICE_CODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPE = 'XboxLive.signin offline_access';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function offlineAccount(username) {
  const name = String(username || '').trim().slice(0, 16) || 'Player';
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {
    type: 'offline',
    name,
    uuid,
    accessToken: crypto.randomUUID().replace(/-/g, ''),
    userType: 'legacy',
    xuid: '',
  };
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function xstsMessage(xerr) {
  const map = {
    2148916233: 'У аккаунта Microsoft нет профиля Xbox. Создайте его на xbox.com.',
    2148916235: 'Xbox Live недоступен в регионе аккаунта.',
    2148916236: 'Требуется проверка возраста Microsoft.',
    2148916237: 'Требуется проверка возраста Microsoft.',
    2148916238: 'Детский аккаунт: добавьте его в семейную группу Microsoft.',
  };
  return map[xerr] || `Ошибка Xbox Live (XErr ${xerr})`;
}

async function exchangeForMinecraft(msAccessToken) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msAccessToken}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });

  let xsts;
  try {
    xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    });
  } catch (err) {
    const xerr = err.data?.XErr;
    if (xerr) throw new Error(xstsMessage(xerr));
    throw err;
  }

  const xui = xsts.DisplayClaims?.xui?.[0] || {};
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${xui.uhs};${xsts.Token}`,
  });

  const profileRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  });
  if (profileRes.status === 404) {
    throw new Error('У этого аккаунта Microsoft нет лицензии Minecraft: Java Edition.');
  }
  if (!profileRes.ok) throw new Error(`Профиль Minecraft: HTTP ${profileRes.status}`);
  const profile = await profileRes.json();

  return {
    type: 'microsoft',
    name: profile.name,
    uuid: profile.id,
    accessToken: mc.access_token,
    expiresAt: Date.now() + (mc.expires_in || 86400) * 1000,
    refreshToken: null,
    userType: 'msa',
    xuid: xui.xid || '',
  };
}

/**
 * Device-code login. onDeviceCode gets { userCode, verificationUri, expiresIn }
 * so the UI can show the code while we poll.
 */
async function loginMicrosoft({ clientId, onDeviceCode, signal }) {
  if (!clientId) throw new Error('Не задан Azure Client ID для входа Microsoft.');

  const start = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: SCOPE,
  });
  if (!start.ok) {
    throw new Error(start.data.error_description || 'Не удалось начать вход Microsoft.');
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = start.data;
  onDeviceCode?.({
    userCode: user_code,
    verificationUri: verification_uri || 'https://microsoft.com/link',
    expiresIn: expires_in,
  });

  const deadline = Date.now() + expires_in * 1000;
  let pollInterval = Math.max(2, interval || 5);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Вход отменён.');
    await delay(pollInterval * 1000);
    const poll = await postForm(TOKEN_URL, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code,
    });
    const data = poll.data;

    if (data.access_token) {
      const account = await exchangeForMinecraft(data.access_token);
      account.refreshToken = data.refresh_token || '';
      return account;
    }
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      pollInterval += 5;
      continue;
    }
    if (data.error === 'expired_token') throw new Error('Код входа истёк. Попробуйте снова.');
    throw new Error(data.error_description || data.error || 'Ошибка входа Microsoft.');
  }

  throw new Error('Код входа истёк. Попробуйте снова.');
}

async function refreshMicrosoft({ clientId, refreshToken }) {
  if (!clientId || !refreshToken) throw new Error('Нет сохранённого токена Microsoft.');
  const res = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope: SCOPE,
  });
  if (!res.ok || !res.data.access_token) {
    throw new Error(res.data.error_description || 'Токен Microsoft истёк, войдите заново.');
  }
  const account = await exchangeForMinecraft(res.data.access_token);
  account.refreshToken = res.data.refresh_token || refreshToken;
  return account;
}

module.exports = { offlineAccount, loginMicrosoft, refreshMicrosoft };
