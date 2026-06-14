const crypto = require('crypto');

// Service account JWT (fallback)
async function getTokenFromServiceAccount(serviceAccountJson) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const c = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');
  const toSign = `${h}.${c}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(toSign);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = `${toSign}.${sig}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SA auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

// Cache du token au niveau du module (réutilisé tant que l'instance reste chaude)
let _cachedToken = null; // { token, expiresAt }

// OAuth2 refresh token (preferred for Search Console — uses admin account)
async function getTokenFromRefreshToken(clientId, clientSecret, refreshToken) {
  if (_cachedToken && _cachedToken.expiresAt > Date.now()) {
    return _cachedToken.token;
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('OAuth2 refresh failed: ' + JSON.stringify(d));
  const ttl = ((d.expires_in || 3600) - 60) * 1000;
  _cachedToken = { token: d.access_token, expiresAt: Date.now() + ttl };
  return d.access_token;
}

module.exports = async function handler(req, res) {
  const siteUrl      = process.env.SEARCH_CONSOLE_SITE_URL;
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const saJson       = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  const hasOAuth = clientId && clientSecret && refreshToken;
  const hasSA    = !!saJson;

  if (!siteUrl || (!hasOAuth && !hasSA)) {
    return res.status(500).json({
      error: 'Search Console not configured — voir guide de configuration (SEARCH_CONSOLE_SITE_URL + identifiants OAuth2 requis)',
    });
  }

  let token;
  try {
    token = hasOAuth
      ? await getTokenFromRefreshToken(clientId, clientSecret, refreshToken)
      : await getTokenFromServiceAccount(saJson);
  } catch (e) {
    return res.status(500).json({ error: 'Auth error: ' + e.message });
  }

  const type = req.query.type;

  try {
    if (type === 'top') {
      // Search Console data lags ~3 days
      const endD = new Date();
      endD.setUTCDate(endD.getUTCDate() - 3);
      const startD = new Date(endD);
      startD.setUTCDate(startD.getUTCDate() - 27); // last 28 days
      const fmt = d => d.toISOString().slice(0, 10);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let r;
      try {
        r = await fetch(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              startDate: fmt(startD),
              endDate: fmt(endD),
              dimensions: ['query'],
              rowLimit: 1000,
              startRow: 0,
            }),
            signal: controller.signal,
          }
        );
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('Search Console timeout (20s) — la requête a pris trop de temps');
        throw e;
      } finally {
        clearTimeout(timeout);
      }

      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Search Console ${r.status}: ${t}`);
      }

      const data = await r.json();
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        rows: data.rows || [],
        period: { start: fmt(startD), end: fmt(endD) },
      });
    }

    if (type === 'trends') {
      // Search Console data lags ~3 days
      const endD = new Date();
      endD.setUTCDate(endD.getUTCDate() - 3);
      const curStart = new Date(endD);
      curStart.setUTCDate(curStart.getUTCDate() - 27); // 28 derniers jours
      const prevEnd = new Date(curStart);
      prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
      const prevStart = new Date(prevEnd);
      prevStart.setUTCDate(prevStart.getUTCDate() - 27); // 28 jours précédents
      const fmt = d => d.toISOString().slice(0, 10);

      async function fetchQueries(startDate, endDate) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        let r;
        try {
          r = await fetch(
            `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                startDate: fmt(startDate),
                endDate: fmt(endDate),
                dimensions: ['query'],
                rowLimit: 1000,
                startRow: 0,
              }),
              signal: controller.signal,
            }
          );
        } catch (e) {
          if (e.name === 'AbortError') throw new Error('Search Console timeout (20s) — la requête a pris trop de temps');
          throw e;
        } finally {
          clearTimeout(timeout);
        }
        if (!r.ok) {
          const t = await r.text();
          throw new Error(`Search Console ${r.status}: ${t}`);
        }
        const data = await r.json();
        return data.rows || [];
      }

      const [curRows, prevRows] = await Promise.all([
        fetchQueries(curStart, endD),
        fetchQueries(prevStart, prevEnd),
      ]);

      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        current: { rows: curRows, period: { start: fmt(curStart), end: fmt(endD) } },
        previous: { rows: prevRows, period: { start: fmt(prevStart), end: fmt(prevEnd) } },
      });
    }

    return res.status(400).json({ error: `Unknown type: ${type}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
