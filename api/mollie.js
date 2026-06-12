// Sync des frais Mollie (Settlements) -> cos_site_manuel.mollie_fees, agrégés par semaine ISO 2026.
// GET /api/mollie?type=sync

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
  const week = Math.round((thu - week1mon) / 604800000) + 1;
  return { year: yr, week };
}

module.exports = async function handler(req, res) {
  const MOLLIE_KEY = process.env.MOLLIE_API_KEY;
  if (!MOLLIE_KEY) {
    return res.status(500).json({ error: 'MOLLIE_API_KEY non configurée' });
  }

  const type = req.query.type || 'sync';

  try {
    if (type === 'sync') {
      // Récupère les settlements (paginé), avec settledAt et le détail des coûts
      let url = 'https://api.mollie.com/v2/settlements?limit=64';
      const settlements = [];
      let guard = 0;
      while (url && guard < 30) {
        guard++;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${MOLLIE_KEY}` } });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          return res.status(r.status).json({ error: `Mollie API ${r.status}: ${t.slice(0, 300)}` });
        }
        const data = await r.json();
        const list = (data._embedded && data._embedded.settlements) || [];
        settlements.push(...list);
        url = (data._links && data._links.next && data._links.next.href) || null;
      }

      // Agrégation des frais (costs) par semaine ISO, basée sur settledAt
      const weekFees = {}; // "YYYY-Sxx" -> total fees
      for (const s of settlements) {
        const settledAt = s.settledAt || s.createdAt;
        if (!settledAt) continue;
        const wk = isoWeek(settledAt);
        if (!wk) continue;
        const key = wk.year + '-S' + wk.week;

        let fee = 0;
        const periods = s.periods || {};
        for (const yr of Object.values(periods)) {
          for (const month of Object.values(yr)) {
            const costs = month.costs || [];
            for (const c of costs) {
              const v = c.amountGross || c.amount;
              if (v && v.value) fee += parseFloat(v.value);
            }
          }
        }
        if (fee > 0) {
          weekFees[key] = (weekFees[key] || 0) + Math.round(fee * 100) / 100;
        }
      }

      // Charge les lignes existantes (pour ne pas perdre paypal_fees / psp manuel)
      const existing = await sbSelect('cos_site_manuel', 'marketplace=eq.site_internet&select=*');
      const existingByWeek = {};
      existing.forEach(r => { existingByWeek[r.semaine] = r; });

      const rows = [];
      for (const [key, mollieFees] of Object.entries(weekFees)) {
        const [yr, wk] = key.split('-');
        if (yr !== '2026') continue; // limité à l'année en cours, comme le reste de l'outil
        const ex = existingByWeek[wk] || {};
        rows.push({
          marketplace: 'site_internet',
          semaine: wk,
          mollie_fees: Math.round(mollieFees * 100) / 100,
          paypal_fees: ex.paypal_fees ?? null,
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
      return res.status(200).json({ ok: true, settlements: settlements.length, weeksUpdated: rows.length, weeks: rows.map(r => ({ semaine: r.semaine, mollie_fees: r.mollie_fees })) });
    }

    return res.status(400).json({ error: 'type inconnu' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
