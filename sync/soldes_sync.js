#!/usr/bin/env node
/**
 * Soldes Été Historique — Prestashop → Supabase
 *
 * Construit la base de comparaison jour-par-jour pour les Soldes d'Été.
 * Lit ps_sales_daily (déjà synchronisé par ps_sync.js) et produit
 * soldes_daily_sales avec day_rank calculé par rapport au 1er jour des soldes.
 *
 * Variables d'environnement :
 *   PRESTASHOP_API_URL   (non utilisé directement ici — lu via ps_sales_daily)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   EDITION              2025 | 2026
 *   START_DATE           YYYY-MM-DD (requis si EDITION=2025, ignoré si 2026)
 *   END_DATE             YYYY-MM-DD (requis si EDITION=2025, ignoré si 2026)
 *   DRY_RUN              true | false
 *
 * Édition 2026 : dates figées 2026-06-24 → 2026-07-21 (ou aujourd'hui si avant la fin)
 * Édition 2025 : l'utilisateur spécifie les dates au lancement du workflow
 */

require('dotenv').config();

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const EDITION = process.env.EDITION || "2026";
const DRY_RUN = process.env.DRY_RUN === "true";

// Dates par édition
const EDITION_DEFAULTS = {
  "2026": { start: "2026-06-24", end: "2026-07-21" },
};

if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.");
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════
// HELPERS SUPABASE
// ══════════════════════════════════════════════════════════════════

async function sbGet(table, params = "") {
  let allRows = [];
  let offset = 0;
  const PAGE = 10000;
  while (true) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        Range: `${offset}-${offset + PAGE - 1}`,
        "Range-Unit": "items",
      },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`Supabase GET ${table} ${r.status}: ${t.slice(0, 300)}`);
    }
    const page = await r.json();
    allRows = allRows.concat(page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return allRows;
}

async function sbUpsert(table, rows) {
  if (!rows.length) return;
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=edition,sku,marketplace,sale_date`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Supabase upsert ${table} ${r.status}: ${t.slice(0, 300)}`);
  }
}

async function sbUpsertEdition(edition, startDate, endDate) {
  const r = await fetch(`${SB_URL}/rest/v1/soldes_editions?on_conflict=edition`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{ edition, start_date: startDate, end_date: endDate }]),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Supabase upsert soldes_editions ${r.status}: ${t.slice(0, 300)}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// LOGIQUE PRINCIPALE
// ══════════════════════════════════════════════════════════════════

function daysBetween(start, end) {
  return Math.round((new Date(end) - new Date(start)) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function run() {
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Soldes Été ${EDITION} — Sync${DRY_RUN ? " [DRY RUN]" : ""}`);
  console.log(`═══════════════════════════════════════\n`);

  // Déterminer les dates de l'édition
  let startDate, endDate;
  if (EDITION === "2026") {
    startDate = EDITION_DEFAULTS["2026"].start;
    const today = new Date().toISOString().slice(0, 10);
    endDate = today < EDITION_DEFAULTS["2026"].end ? today : EDITION_DEFAULTS["2026"].end;
    console.log(`📅 Édition 2026 : ${startDate} → ${endDate} (dates fixes jusqu'à aujourd'hui)`);
  } else {
    startDate = process.env.START_DATE;
    endDate = process.env.END_DATE;
    if (!startDate || !endDate) {
      console.error("❌ START_DATE et END_DATE sont requis pour l'édition 2025.");
      process.exit(1);
    }
    console.log(`📅 Édition ${EDITION} : ${startDate} → ${endDate} (dates saisies)`);
  }

  const totalDays = daysBetween(startDate, endDate) + 1;
  console.log(`📊 ${totalDays} jours de soldes à traiter\n`);

  // Charger les ventes PS sur la plage des soldes
  console.log(`⬇  Chargement ps_sales_daily [${startDate} → ${endDate}]...`);
  const rawSales = await sbGet("ps_sales_daily",
    `sale_date=gte.${startDate}&sale_date=lte.${endDate}` +
    `&select=marketplace,product_ref,sale_date,quantity,revenue_ht,shipping_ht` +
    `&order=sale_date.asc`
  );
  console.log(`   → ${rawSales.length} lignes brutes chargées`);

  if (!rawSales.length) {
    console.warn("⚠  Aucune vente trouvée sur cette période. Vérifiez que ps_sync.js est à jour.");
    if (!DRY_RUN) {
      await sbUpsertEdition(EDITION, startDate, endDate);
      console.log("✓ Edition enregistrée dans soldes_editions (sans ventes)");
    }
    return;
  }

  // Agréger par (marketplace, product_ref, sale_date) — sale_date tronqué au jour
  // (la colonne soldes_daily_sales.sale_date est de type DATE, alors que
  // ps_sales_daily.sale_date est un timestamp ; sans cette troncature, deux
  // commandes du même jour génèrent deux clés distinctes mais le même
  // conflit ON CONFLICT, ce qui fait échouer l'upsert)
  const aggMap = {};
  for (const s of rawSales) {
    const mp = s.marketplace || "site";
    if (mp === "site") continue; // On ignore les ventes site web
    const day = String(s.sale_date).slice(0, 10);
    const key = `${mp}|${s.product_ref}|${day}`;
    if (!aggMap[key]) aggMap[key] = { marketplace: mp, sku: s.product_ref, sale_date: day, quantity: 0, revenue_ht: 0 };
    aggMap[key].quantity   += (s.quantity || 0);
    aggMap[key].revenue_ht += (s.revenue_ht || 0) + (s.shipping_ht || 0);
  }

  // Calculer day_rank et préparer les lignes finales
  const rows = Object.values(aggMap).map(r => ({
    edition:     EDITION,
    sku:         r.sku,
    marketplace: r.marketplace,
    sale_date:   r.sale_date,
    day_rank:    daysBetween(startDate, r.sale_date) + 1,
    quantity:    r.quantity,
    revenue_ht:  Math.round(r.revenue_ht * 100) / 100,
  }));

  // Stats par marketplace
  const statsByMp = {};
  for (const r of rows) {
    if (!statsByMp[r.marketplace]) statsByMp[r.marketplace] = { skus: new Set(), qty: 0 };
    statsByMp[r.marketplace].skus.add(r.sku);
    statsByMp[r.marketplace].qty += r.quantity;
  }
  console.log("\n📦 Résumé par marketplace :");
  for (const [mp, s] of Object.entries(statsByMp)) {
    console.log(`   ${mp.padEnd(20)} : ${s.skus.size} SKUs · ${s.qty} ventes`);
  }
  console.log(`\n✅ Total : ${rows.length} lignes à insérer dans soldes_daily_sales\n`);

  if (DRY_RUN) {
    console.log("🔍 DRY RUN — aperçu des 5 premières lignes :");
    rows.slice(0, 5).forEach(r => console.log("  ", JSON.stringify(r)));
    console.log("\n✋ Dry run terminé. Aucune écriture.");
    return;
  }

  // Enregistrer l'édition dans soldes_editions
  await sbUpsertEdition(EDITION, startDate, endDate);
  console.log(`✓ Edition ${EDITION} enregistrée dans soldes_editions`);

  // Upsert par batch de 500
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await sbUpsert("soldes_daily_sales", batch);
    written += batch.length;
    process.stdout.write(`\r   Écriture : ${written}/${rows.length} lignes...`);
  }
  console.log(`\n\n✅ ${written} lignes écrites dans soldes_daily_sales`);
  console.log(`\n🏁 Sync Soldes Été ${EDITION} terminé.\n`);
}

run().catch(err => {
  console.error("❌ Erreur fatale :", err.message);
  process.exit(1);
});
