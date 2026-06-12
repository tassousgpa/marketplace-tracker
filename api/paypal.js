// Sync des frais PayPal (Transaction Search) -> cos_site_manuel.paypal_fees, agrégés par semaine ISO 2026.
// GET /api/paypal?type=sync

const SB_URL = "https://pmxsthzdxubqbemdgtbr.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBteHN0aHpkeHVicWJlbWRndGJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDk4NDQsImV4cCI6MjA5MDAyNTg0NH0.GpfAw91eJ8D7RIeZLFIejCt9DTwGpXvOGcxYlhZS78I";

async function sbSelect(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase select ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbUpsert(table, data, onConflict) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${r.status}: ${await r.text()}`);
}

// Réplique isoWeekLabel() côté front : retourne { year, week } pour une date donnée
function isoWeek(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + "T12:00:00Z");
  if (isNaN(d)) return null;
  const dow = d.getUTCDay() || 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - (dow - 1));
  const thu = new Date(mon); thu.setUTCDate(mon.getUTCDate() + 3);
  const yr = thu.getUTCFullYear();
  const jan4 = new Date(Date.UTC(yr, 0, 4));
  const jan4dow = jan4.getUTCDay() || 7;
  const week1mon = new Date(jan4); week1mon.setUTCDate(jan4.getUTCDate() - (jan4dow - 1));
  const week = Math.round((mon - week1mon) / 604800000) + 1;
  return { year: yr, week };
}

async function getAccessToken(clientId, secret) {
  const r = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`PayPal OAuth ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.access_token;
}

module.exports = async function handler(req, res) {
  const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
  const SECRET = process.env.PAYPAL_CLIENT_SECRET;
  if (!CLIENT_ID || !SECRET) {
    return res.status(500).json({ error: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET non configurées' });
  }

  const type = req.query.type || 'sync';

  try {
    if (type === 'sync') {
      const token = await getAccessToken(CLIENT_ID, SECRET);

      // Découpe la période (01/01/2026 -> aujourd'hui) en tranches de 31 jours max
      // (limite imposée par l'API Transaction Search).
      const start = new Date('2026-01-01T00:00:00Z');
      const now = new Date();
      const chunks = [];
      let curStart = new Date(start);
      while (curStart < now) {
        const curEnd = new Date(curStart);
        curEnd.setUTCDate(curEnd.getUTCDate() + 30);
        if (curEnd > now) curEnd.setTime(now.getTime());
        chunks.push({ start: new Date(curStart), end: new Date(curEnd) });
        curStart = new Date(curEnd);
        curStart.setUTCMilliseconds(curStart.getUTCMilliseconds() + 1);
      }

      const weekFees = {}; // "YYYY-Sxx" -> total fees (valeur absolue)
      let txCount = 0;
      const startTime = Date.now();
      const DEADLINE_MS = 45000;

      for (const c of chunks) {
        if (Date.now() - startTime > DEADLINE_MS) break;
        let page = 1;
        let totalPages = 1;
        do {
          const params = new URLSearchParams({
            start_date: c.start.toISOString().slice(0, 19) + '-0000',
            end_date: c.end.toISOString().slice(0, 19) + '-0000',
            fields: 'transaction_info',
            page_size: '500',
            page: String(page),
          });
          const r = await fetch(`https://api-m.paypal.com/v1/reporting/transactions?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!r.ok) {
            const t = await r.text().catch(() => '');
            return res.status(r.status).json({ error: `PayPal API ${r.status}: ${t.slice(0, 300)}` });
          }
          const data = await r.json();
          totalPages = data.total_pages || 1;
          const details = data.transaction_details || [];
          for (const d of details) {
            const info = d.transaction_info || {};
            const fee = info.fee_amount && info.fee_amount.value ? Math.abs(parseFloat(info.fee_amount.value)) : 0;
            const date = info.transaction_initiation_date;
            if (!fee || !date) continue;
            const wk = isoWeek(date);
            if (!wk) continue;
            const key = wk.year + '-S' + wk.week;
            weekFees[key] = (weekFees[key] || 0) + fee;
            txCount++;
          }
          page++;
        } while (page <= totalPages && Date.now() - startTime < DEADLINE_MS);
      }

      // Charge les lignes existantes (pour ne pas perdre les autres colonnes)
      const existing = await sbSelect('cos_site_manuel', 'marketplace=eq.site_internet&select=*');
      const existingByWeek = {};
      existing.forEach(r => { existingByWeek[r.semaine] = r; });

      const rows = [];
      for (const [key, fees] of Object.entries(weekFees)) {
        const [yr, wk] = key.split('-');
        if (yr !== '2026') continue;
        const ex = existingByWeek[wk] || {};
        rows.push({
          marketplace: 'site_internet',
          semaine: wk,
          paypal_fees: Math.round(fees * 100) / 100,
          mollie_fees: ex.mollie_fees ?? null,
          gads: ex.gads ?? null,
          meta: ex.meta ?? null,
          pinterest: ex.pinterest ?? null,
          tiktok: ex.tiktok ?? null,
          agences: ex.agences ?? null,
          bnpl: ex.bnpl ?? null,
        });
      }

      if (rows.length) await sbUpsert('cos_site_manuel', rows, 'marketplace,semaine');

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, transactions: txCount, weeksUpdated: rows.length, weeks: rows.map(r => ({ semaine: r.semaine, paypal_fees: r.paypal_fees })) });
    }

    return res.status(400).json({ error: 'type inconnu' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
