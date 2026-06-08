const crypto = require('crypto');

async function getGoogleToken(serviceAccountJson, scope) {
  const sa = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const c = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope,
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
  if (!d.access_token) throw new Error('Auth failed: ' + JSON.stringify(d));
  return d.access_token;
}

export default async function handler(req, res) {
  const saJson   = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const siteUrl  = process.env.SEARCH_CONSOLE_SITE_URL;

  if (!saJson || !siteUrl) {
    return res.status(500).json({
      error: 'Search Console not configured (GOOGLE_SERVICE_ACCOUNT_JSON or SEARCH_CONSOLE_SITE_URL missing)',
    });
  }

  let token;
  try {
    token = await getGoogleToken(saJson, 'https://www.googleapis.com/auth/webmasters.readonly');
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

      const body = {
        startDate: fmt(startD),
        endDate: fmt(endD),
        dimensions: ['query'],
        rowLimit: 1000,
        startRow: 0,
      };

      const r = await fetch(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );

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

    return res.status(400).json({ error: `Unknown type: ${type}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
