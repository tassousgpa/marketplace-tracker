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

async function runReport(token, propertyId, body) {
  const r = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GA4 ${r.status}: ${t}`);
  }
  return r.json();
}

function parseRows(data) {
  return (data.rows || []).map(row => ({
    dims: (row.dimensionValues || []).map(v => v.value),
    mets: (row.metricValues || []).map(v => parseFloat(v.value) || 0),
  }));
}

// Aggregate totals from rows (when no dimensions requested, GA4 may return single row)
function sumMetrics(data, metIdx) {
  return (data.rows || []).reduce((sum, row) => {
    return sum + (parseFloat(row.metricValues?.[metIdx]?.value) || 0);
  }, 0);
}

const ORGANIC_FILTER = {
  filter: {
    fieldName: 'sessionDefaultChannelGroup',
    stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
  },
};

const PAID_FILTER = {
  filter: {
    fieldName: 'sessionDefaultChannelGroup',
    stringFilter: { matchType: 'EXACT', value: 'Paid Search' },
  },
};

// Last completed calendar week Mon–Sun
function lastWeek() {
  const now = new Date();
  const dow = now.getUTCDay() || 7; // 1=Mon … 7=Sun
  const lastSun = new Date(now);
  lastSun.setUTCDate(now.getUTCDate() - dow);
  const lastMon = new Date(lastSun);
  lastMon.setUTCDate(lastSun.getUTCDate() - 6);
  const fmt = d => d.toISOString().slice(0, 10);
  // ISO week number
  const jan1 = new Date(Date.UTC(lastMon.getUTCFullYear(), 0, 1));
  const wn = Math.ceil(((lastMon - jan1) / 86400000 + jan1.getUTCDay() + 1) / 7);
  return { start: fmt(lastMon), end: fmt(lastSun), label: `S${wn} ${lastMon.getUTCFullYear()}` };
}

function lastWeekN1() {
  const wk = lastWeek();
  const s = new Date(wk.start); s.setUTCFullYear(s.getUTCFullYear() - 1);
  const e = new Date(wk.end);   e.setUTCFullYear(e.getUTCFullYear() - 1);
  return { start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) };
}

async function getTokenFromRefreshToken(clientId, clientSecret, refreshToken) {
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
  return d.access_token;
}

module.exports = async function handler(req, res) {
  const propertyId   = process.env.GA4_PROPERTY_ID;
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const saJson       = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  const hasOAuth = clientId && clientSecret && refreshToken;
  const hasSA    = !!saJson;

  if (!propertyId || (!hasOAuth && !hasSA)) {
    return res.status(500).json({
      error: 'GA4 not configured — GA4_PROPERTY_ID + identifiants OAuth2 requis',
    });
  }

  let token;
  try {
    token = hasOAuth
      ? await getTokenFromRefreshToken(clientId, clientSecret, refreshToken)
      : await getGoogleToken(saJson, 'https://www.googleapis.com/auth/analytics.readonly');
  } catch (e) {
    return res.status(500).json({ error: 'Auth error: ' + e.message });
  }

  const type = req.query.type;

  try {
    // ── KPIs : last completed week vs N-1 ──────────────────────────
    if (type === 'kpi') {
      const wk  = lastWeek();
      const wkN1 = lastWeekN1();
      const metrics = [
        { name: 'sessions' },
        { name: 'transactions' },
        { name: 'sessionConversionRate' },
      ];
      const [curData, n1Data] = await Promise.all([
        runReport(token, propertyId, {
          dateRanges: [{ startDate: wk.start, endDate: wk.end }],
          metrics,
          dimensionFilter: ORGANIC_FILTER,
        }),
        runReport(token, propertyId, {
          dateRanges: [{ startDate: wkN1.start, endDate: wkN1.end }],
          metrics,
          dimensionFilter: ORGANIC_FILTER,
        }),
      ]);
      const getTotal = (data, idx) => {
        // No dimensions → single row with aggregate, or in totals
        const t = data.totals?.[0]?.metricValues?.[idx];
        if (t) return parseFloat(t.value) || 0;
        return sumMetrics(data, idx);
      };
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        current: {
          sessions: getTotal(curData, 0),
          transactions: getTotal(curData, 1),
          conversionRate: getTotal(curData, 2),
        },
        n1: {
          sessions: getTotal(n1Data, 0),
          transactions: getTotal(n1Data, 1),
          conversionRate: getTotal(n1Data, 2),
        },
        weekLabel: wk.label,
        week: wk,
        weekN1: wkN1,
      });
    }

    // ── Sessions par jour — 7 derniers jours ──────────────────────
    if (type === 'daily') {
      const data = await runReport(token, propertyId, {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: ORGANIC_FILTER,
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });
      const rows = parseRows(data);
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        days: rows.map(r => ({ date: r.dims[0], sessions: r.mets[0] })),
      });
    }

    // ── Distribution horaire — 7 derniers jours ───────────────────
    if (type === 'hourly') {
      const data = await runReport(token, propertyId, {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'hour' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: ORGANIC_FILTER,
        orderBys: [{ dimension: { dimensionName: 'hour' } }],
      });
      const rows = parseRows(data);
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        hours: rows.map(r => ({ hour: parseInt(r.dims[0], 10), sessions: r.mets[0] })),
      });
    }

    // ── Évolution hebdomadaire — 52 dernières semaines ────────────
    if (type === 'evolution') {
      const data = await runReport(token, propertyId, {
        dateRanges: [{ startDate: '364daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'yearWeek' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: ORGANIC_FILTER,
        orderBys: [{ dimension: { dimensionName: 'yearWeek' } }],
      });
      const rows = parseRows(data);
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        weeks: rows.map(r => ({ yearWeek: r.dims[0], sessions: r.mets[0] })),
      });
    }

    // ── SEA KPIs : last completed week vs N-1 ─────────────────────
    if (type === 'sea_kpi') {
      const wk   = lastWeek();
      const wkN1 = lastWeekN1();
      const metrics = [
        { name: 'sessions' },
        { name: 'transactions' },
        { name: 'sessionConversionRate' },
      ];
      const [curData, n1Data] = await Promise.all([
        runReport(token, propertyId, {
          dateRanges: [{ startDate: wk.start, endDate: wk.end }],
          metrics,
          dimensionFilter: PAID_FILTER,
        }),
        runReport(token, propertyId, {
          dateRanges: [{ startDate: wkN1.start, endDate: wkN1.end }],
          metrics,
          dimensionFilter: PAID_FILTER,
        }),
      ]);
      const getTotal = (data, idx) => {
        const t = data.totals?.[0]?.metricValues?.[idx];
        if (t) return parseFloat(t.value) || 0;
        return sumMetrics(data, idx);
      };
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        current: { sessions: getTotal(curData, 0), transactions: getTotal(curData, 1), conversionRate: getTotal(curData, 2) },
        n1:      { sessions: getTotal(n1Data, 0), transactions: getTotal(n1Data, 1), conversionRate: getTotal(n1Data, 2) },
        weekLabel: wk.label,
        week: wk,
      });
    }

    // ── SEA sessions par jour — 7 derniers jours ──────────────────
    if (type === 'sea_daily') {
      const data = await runReport(token, propertyId, {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: PAID_FILTER,
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      });
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        days: parseRows(data).map(r => ({ date: r.dims[0], sessions: r.mets[0] })),
      });
    }

    // ── SEA évolution hebdomadaire — 52 semaines ──────────────────
    if (type === 'sea_evolution') {
      const data = await runReport(token, propertyId, {
        dateRanges: [{ startDate: '364daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'yearWeek' }],
        metrics: [{ name: 'sessions' }],
        dimensionFilter: PAID_FILTER,
        orderBys: [{ dimension: { dimensionName: 'yearWeek' } }],
      });
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        weeks: parseRows(data).map(r => ({ yearWeek: r.dims[0], sessions: r.mets[0] })),
      });
    }

    // ── SEA par campagne — 28 derniers jours ──────────────────────
    if (type === 'sea_campaigns') {
      const endD = new Date(); endD.setUTCDate(endD.getUTCDate() - 1);
      const startD = new Date(endD); startD.setUTCDate(startD.getUTCDate() - 27);
      const fmt = d => d.toISOString().slice(0, 10);
      const data = await runReport(token, propertyId, {
        dateRanges: [{ startDate: fmt(startD), endDate: fmt(endD) }],
        dimensions: [{ name: 'sessionCampaignName' }],
        metrics: [{ name: 'sessions' }, { name: 'transactions' }, { name: 'sessionConversionRate' }],
        dimensionFilter: PAID_FILTER,
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 100,
      });
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        rows: parseRows(data).map(r => ({
          campaign: r.dims[0],
          sessions: r.mets[0],
          transactions: r.mets[1],
          conversionRate: r.mets[2],
        })),
        period: { start: fmt(startD), end: fmt(endD) },
      });
    }

    // ── Trafic total — KPIs semaine vs N-1 (tous canaux) ─────────────
    if (type === 'total_kpi') {
      const wk   = lastWeek();
      const wkN1 = lastWeekN1();
      const metrics = [
        { name: 'sessions' },
        { name: 'transactions' },
        { name: 'sessionConversionRate' },
      ];
      const [curData, n1Data] = await Promise.all([
        runReport(token, propertyId, { dateRanges: [{ startDate: wk.start, endDate: wk.end }], metrics }),
        runReport(token, propertyId, { dateRanges: [{ startDate: wkN1.start, endDate: wkN1.end }], metrics }),
      ]);
      const getTotal = (data, idx) => {
        const t = data.totals?.[0]?.metricValues?.[idx];
        if (t) return parseFloat(t.value) || 0;
        return sumMetrics(data, idx);
      };
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        current: { sessions: getTotal(curData, 0), transactions: getTotal(curData, 1), conversionRate: getTotal(curData, 2) },
        n1:      { sessions: getTotal(n1Data, 0), transactions: getTotal(n1Data, 1), conversionRate: getTotal(n1Data, 2) },
        weekLabel: wk.label,
        week: wk,
      });
    }

    // ── Trafic total — évolution 53 semaines (tous canaux) ────────────
    if (type === 'total_evolution') {
      const data = await runReport(token, propertyId, {
        dateRanges: [{ startDate: '370daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'yearWeek' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ dimension: { dimensionName: 'yearWeek' } }],
      });
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
      return res.status(200).json({
        weeks: parseRows(data).map(r => ({ yearWeek: r.dims[0], sessions: r.mets[0] })),
      });
    }

    return res.status(400).json({ error: `Unknown type: ${type}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
