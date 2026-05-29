#!/usr/bin/env node
/**
 * Prestashop → Supabase — sync incrémental quotidien
 * Lance quotidiennement via cron à 04:00 (voir npm run cron)
 *
 * Variables d'environnement requises (copier .env.example → .env) :
 *   PRESTASHOP_API_URL   ex: https://bestmobilier.com/api
 *   PRESTASHOP_API_KEY   clé Marketplace_Dashboard_MKPTRACKER
 *   SUPABASE_URL         URL du projet Supabase
 *   SUPABASE_SERVICE_KEY service_role key (accès total, ne jamais exposer côté client)
 *
 * Tables Supabase requises :
 *   ps_sales_daily   (order_id, product_ref unique key)
 *   ps_sync_state    (id INT pk, last_order_id INT, last_sync_at TIMESTAMPTZ)
 *
 * SQL de création des tables (à exécuter dans Supabase SQL Editor) :
 *   CREATE TABLE IF NOT EXISTS ps_sales_daily (
 *     id              BIGSERIAL PRIMARY KEY,
 *     order_id        INTEGER NOT NULL,
 *     order_reference TEXT,
 *     sale_date       DATE NOT NULL,
 *     payment_method  TEXT,
 *     marketplace     TEXT,
 *     product_ref     TEXT NOT NULL,
 *     product_name    TEXT,
 *     quantity        INTEGER DEFAULT 1,
 *     revenue_ttc     NUMERIC(12,2),
 *     revenue_ht      NUMERIC(12,2),
 *     order_state     TEXT,
 *     created_at      TIMESTAMPTZ DEFAULT NOW(),
 *     UNIQUE (order_id, product_ref)
 *   );
 *   CREATE TABLE IF NOT EXISTS ps_sync_state (
 *     id              INTEGER PRIMARY KEY DEFAULT 1,
 *     last_order_id   INTEGER DEFAULT 0,
 *     last_sync_at    TIMESTAMPTZ
 *   );
 *   INSERT INTO ps_sync_state (id, last_order_id) VALUES (1, 0) ON CONFLICT DO NOTHING;
 */

require('dotenv').config();

const PS_URL = (process.env.PRESTASHOP_API_URL || "").replace(/\/$/, "");
const PS_KEY = process.env.PRESTASHOP_API_KEY || "";
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!PS_URL || !PS_KEY) {
  console.error("❌ PRESTASHOP_API_URL et PRESTASHOP_API_KEY sont requis.");
  process.exit(1);
}
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE_URL et SUPABASE_SERVICE_KEY sont requis.");
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════
// CONFIGURATION — exclusions d'états
// ══════════════════════════════════════════════════════════════════

// Exclusion par nom (quand order_states est accessible)
const EXCLUDED_STATES = [
  "annul",        // annulé, annulée, annulés
  "rembours",     // remboursé, remboursement
  "litige",
  "erreur",
  "cancel",       // cancelled (en anglais)
  "refund",
];

// Exclusion par ID Prestashop (fallback quand order_states est inaccessible)
// IDs par défaut de Prestashop : 6=Annulé, 7=Remboursé, 8=Erreur de paiement
// Ajoutez ici les IDs custom de BestMobilier si nécessaire
const EXCLUDED_STATE_IDS = new Set(["6", "7", "8"]);

// ══════════════════════════════════════════════════════════════════
// MAPPING PAIEMENT → MARKETPLACE
// Réutilise la même logique que ODOO_CHANNEL_MAP dans index.html
// ══════════════════════════════════════════════════════════════════
const PAYMENT_MAP_EXACT = {
  // Cdiscount
  "cdiscount_octopia":          "cdiscount",
  "cdiscount":                  "cdiscount",
  // Amazon
  "amazon":                     "amazon",
  "amazon_fr":                  "amazon",
  "amazon_be":                  "amazon",
  "amazon_de":                  "amazon",
  // Maisons du Monde
  "maisonsdumonde":             "maisonsdumonde",
  "maisonsdumonde_de":          "maisonsdumonde",
  // La Redoute
  "laredoute_mirakl":           "laredoute",
  "laredoute":                  "laredoute",
  // Conforama
  "conforama":                  "conforama",
  // ManoMano — "monechelle" est le nom Prestashop de la marketplace ManoMano Pro
  "manomano_fr":                "manomano",
  "manomano_fr_b2b":            "manomano",
  "manomano_fr_mmf":            "manomano",
  "manomano_de":                "manomano",
  "manomano":                   "manomano",
  "monechelle":                 "manomano",   // ← ManoMano Pro (Prestashop)
  // BUT
  "but_mirakl":                 "but",
  "but":                        "but",
  // Leroy Merlin
  "leroymerlin_mirakl":         "leroymerlin",
  "leroy_merlin_mirakl":        "leroymerlin",
  "leroymerlin":            "leroymerlin",
};

function mapMarketplaceFromPayment(payment) {
  if (!payment) return "site";
  const p = payment.toLowerCase().replace(/\s+/g, "_").trim();

  // Match exact
  if (PAYMENT_MAP_EXACT[p]) return PAYMENT_MAP_EXACT[p];

  // Match partiel
  if (p.includes("cdiscount"))    return "cdiscount";
  if (p.includes("maison"))       return "maisonsdumonde";
  if (p.includes("redoute"))      return "laredoute";
  if (p.includes("conforama"))    return "conforama";
  if (p.includes("manomano"))     return "manomano";
  if (p.includes("leroy"))        return "leroymerlin";
  if (/\bbut\b/.test(p) || p.includes("but_")) return "but";

  // Paiements site web (carte bancaire, PayPal, etc.)
  return "site";
}

// ══════════════════════════════════════════════════════════════════
// HELPERS PRESTASHOP
// ══════════════════════════════════════════════════════════════════
const PS_AUTH = "Basic " + Buffer.from(PS_KEY + ":").toString("base64");

async function psGet(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${PS_URL}${path}${sep}output_format=JSON`;
  const r = await fetch(url, { headers: { Authorization: PS_AUTH } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Prestashop ${r.status} — ${url} — ${body.slice(0, 200)}`);
  }
  return r.json();
}

// ══════════════════════════════════════════════════════════════════
// HELPERS SUPABASE
// ══════════════════════════════════════════════════════════════════
async function sbGet(table, params = "") {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Range: "0-9999",
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Supabase GET ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function sbUpsert(table, rows, conflictCols = "") {
  if (!rows.length) return;
  const url = conflictCols
    ? `${SB_URL}/rest/v1/${table}?on_conflict=${conflictCols}`
    : `${SB_URL}/rest/v1/${table}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      // merge-duplicates → ON CONFLICT DO UPDATE (réécriture des lignes existantes)
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Supabase upsert ${table} ${r.status}: ${t.slice(0, 300)}`);
  }
}

async function sbPatch(table, filter, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(data),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Supabase PATCH ${table} ${r.status}: ${t.slice(0, 200)}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// LOGIQUE MÉTIER
// ══════════════════════════════════════════════════════════════════
function shouldExcludeOrder(stateName) {
  if (!stateName) return false;
  const s = String(stateName).toLowerCase();
  // Exclusion par nom (ex: "Annulé", "Remboursé"...)
  if (EXCLUDED_STATES.some(ex => s.includes(ex))) return true;
  // Exclusion par ID numérique (fallback quand order_states est inaccessible)
  if (EXCLUDED_STATE_IDS.has(s)) return true;
  return false;
}

function toFloat(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(",", "."));
  return isNaN(n) ? 0 : n;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

// ══════════════════════════════════════════════════════════════════
// MODE MANUEL — import d'une plage d'IDs (indépendant du mode auto)
// ══════════════════════════════════════════════════════════════════
async function runManualMode(startTime) {
  const startId = toInt(process.env.START_ORDER_ID || "0");
  const endId   = toInt(process.env.END_ORDER_ID   || "0");

  // ── Validation ───────────────────────────────────────────────────
  if (!startId || !endId) {
    console.error(`  ❌ Mode manuel : START_ORDER_ID et END_ORDER_ID sont obligatoires.`);
    console.error(`     START_ORDER_ID reçu : "${process.env.START_ORDER_ID || "(vide)"}"`);
    console.error(`     END_ORDER_ID reçu   : "${process.env.END_ORDER_ID   || "(vide)"}"`);
    process.exit(1);
  }
  if (startId > endId) {
    console.error(`  ❌ Mode manuel : start_order_id (${startId}) doit être ≤ end_order_id (${endId}).`);
    process.exit(1);
  }

  console.log(`  start_order_id   : ${startId}`);
  console.log(`  end_order_id     : ${endId}`);
  console.log(`  Plage potentielle: ${endId - startId + 1} IDs`);

  // ── Charger les états (même logique que mode automatique) ────────
  const stateMap = {};
  let stateMapMode = "ids_fallback";
  try {
    const resp = await psGet("/order_states?display=[id,name]&limit=200");
    (resp.order_states || []).forEach(s => { stateMap[String(s.id)] = s.name || String(s.id); });
    stateMapMode = "names";
    console.log(`  ✓ États commandes chargés : ${Object.keys(stateMap).length} (exclusion par nom active)`);
  } catch (e) {
    const is401 = e.message.includes("401") || e.message.includes("not allowed");
    if (is401) {
      console.warn(`  ⚠ Permission order_states manquante — fallback IDs : ${[...EXCLUDED_STATE_IDS].join(", ")}`);
    } else {
      console.warn(`  ⚠ États non chargés: ${e.message}`);
    }
  }
  console.log(`  ✓ Mode exclusion états : ${stateMapMode}`);

  // ── Récupérer les IDs dans la plage (paginé par 5000) ────────────
  let rangeIds = [];
  try {
    const PAGE_SIZE = 5000;
    let offset = 0, pageNum = 1;
    while (true) {
      const resp = await psGet(
        `/orders?display=[id]&filter[id]=[${startId},${endId}]&sort=[id_ASC]&limit=${offset},${PAGE_SIZE}`
      );
      const page = (resp.orders || []).map(o => toInt(o.id)).filter(id => id > 0);
      rangeIds.push(...page);
      console.log(`  ✓ Page ${pageNum} : ${page.length} IDs (cumul : ${rangeIds.length})`);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
      pageNum++;
    }
    console.log(`  ✓ Commandes trouvées dans [${startId}, ${endId}] : ${rangeIds.length}`);
  } catch (e) {
    console.error(`  ❌ Erreur récupération IDs Prestashop : ${e.message}`);
    process.exit(1);
  }

  if (!rangeIds.length) {
    console.log(`\n  ✓ Aucune commande trouvée dans la plage [${startId}, ${endId}].`);
    return;
  }

  // ── Traiter chaque commande de la plage ──────────────────────────
  let totalLines = 0, insertedLines = 0, skippedOrders = 0, psErrors = 0, sbErrors = 0;
  const buffer = [];

  async function flushBuffer() {
    if (!buffer.length) return;
    try {
      await sbUpsert("ps_sales_daily", buffer, "order_id,product_ref");
      insertedLines += buffer.length;
      console.log(`    → ${buffer.length} lignes insérées (total: ${insertedLines})`);
    } catch (e) {
      console.error(`  ❌ Erreur Supabase insertion: ${e.message}`);
      sbErrors++;
    }
    buffer.length = 0;
  }

  for (const orderId of rangeIds) {
    try {
      const resp = await psGet(`/orders/${orderId}`);
      const order = resp.order;
      if (!order) {
        console.warn(`  ⚠ Commande #${orderId} : réponse vide`);
        psErrors++;
        continue;
      }

      const stateId   = String(order.current_state || "");
      const stateName = stateMap[stateId] || stateId;
      if (shouldExcludeOrder(stateName)) {
        const reason = stateMap[stateId]
          ? `nom="${stateName}"`
          : `id=${stateId} (nom inconnu)`;
        console.log(`  ⊘ Commande #${orderId} exclue — état: ${reason}`);
        skippedOrders++;
        continue;
      }


      const marketplace   = mapMarketplaceFromPayment(order.payment);
      const saleDate      = String(order.date_add || "").slice(0, 10);
      const orderRef      = order.reference || null;
      const paymentMethod = order.payment || null;

      // PS renvoie order_rows soit comme tableau direct, soit wrappé dans .order_row
      const assocRows = order.associations?.order_rows;
      let rowsArr = [];
      if (Array.isArray(assocRows))                         rowsArr = assocRows;
      else if (assocRows?.order_row) {
        const r = assocRows.order_row;
        rowsArr = Array.isArray(r) ? r : [r];
      }

      for (const row of rowsArr) {
        if (!row || !row.product_reference) continue;
        const qty    = toInt(row.product_quantity) || 1;
        const revTtc = Math.round(toFloat(row.unit_price_tax_incl) * qty * 100) / 100;
        const revHt  = Math.round(toFloat(row.unit_price_tax_excl) * qty * 100) / 100;
        totalLines++;
        buffer.push({
          order_id:        toInt(orderId),
          order_reference: orderRef,
          sale_date:       saleDate,
          payment_method:  paymentMethod,
          marketplace,
          product_ref:     String(row.product_reference).trim(),
          product_name:    String(row.product_name || "").slice(0, 255),
          quantity:        qty,
          revenue_ttc:     revTtc,
          revenue_ht:      revHt,
          order_state:     stateName,
        });
      }

      if (buffer.length >= 100) await flushBuffer();
    } catch (e) {
      console.error(`  ❌ Erreur Prestashop commande #${orderId}: ${e.message}`);
      psErrors++;
    }
  }

  await flushBuffer();

  // ── Résumé ────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ══════════════ Résumé import manuel ══════════════`);
  console.log(`  Plage traitée            : [${startId}, ${endId}]`);
  console.log(`  Commandes trouvées       : ${rangeIds.length}`);
  console.log(`  Commandes exclues        : ${skippedOrders}`);
  console.log(`  Lignes produits générées : ${totalLines}`);
  console.log(`  Lignes insérées (UPSERT) : ${insertedLines}`);
  console.log(`  Erreurs Prestashop       : ${psErrors}`);
  console.log(`  Erreurs Supabase         : ${sbErrors}`);
  console.log(`  Durée                    : ${elapsed}s`);
  console.log(`  ✓ last_order_id NON modifié (mode manuel)`);
  console.log(`  ══════════════════════════════════════════\n`);

  if (psErrors > 0 || sbErrors > 0) process.exit(1);
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
async function main() {
  const startTime = Date.now();
  console.log(`\n[${new Date().toISOString()}] ═══════════════════════════════════`);
  console.log(`[${new Date().toISOString()}] Démarrage sync Prestashop → Supabase`);
  console.log(`[${new Date().toISOString()}] ═══════════════════════════════════`);

  // ── Détection du mode ────────────────────────────────────────────
  const SYNC_MODE = (process.env.SYNC_MODE || "automatic").toLowerCase().trim();
  console.log(`  Mode : ${SYNC_MODE.toUpperCase()}`);
  if (SYNC_MODE === "manual") {
    return await runManualMode(startTime);
  }
  // ── MODE AUTOMATIQUE (suite) — code inchangé ─────────────────────

  // ── 1. Lire last_order_id ────────────────────────────────────────
  let lastOrderId = 0;
  try {
    const rows = await sbGet("ps_sync_state", "select=last_order_id&limit=1");
    if (rows.length) lastOrderId = toInt(rows[0].last_order_id);
    console.log(`  ✓ last_order_id lu : ${lastOrderId}`);
  } catch (e) {
    console.error(`  ⚠ Impossible de lire ps_sync_state (table vide ?): ${e.message}`);
    console.error(`    → Démarrage depuis id=0`);
  }

  // ── 2. Récupérer la liste des IDs de commandes ──────────────────
  // sort=[id_DESC] : Prestashop renvoie les commandes en ASC par défaut
  // → sans tri explicite, limit=5000 retourne les 5000 plus anciennes.
  let allIds = [];
  try {
    const resp = await psGet("/orders?display=[id]&sort=[id_DESC]&limit=5000");
    const orders = resp.orders || [];
    allIds = orders.map(o => toInt(o.id)).filter(id => id > 0);

    // ── Logs de diagnostic ──────────────────────────────────────────
    if (allIds.length > 0) {
      const sorted = [...allIds].sort((a, b) => a - b);
      console.log(`  ✓ IDs récupérés       : ${allIds.length}`);
      console.log(`  ✓ ID minimum          : ${sorted[0]}`);
      console.log(`  ✓ ID maximum          : ${sorted[sorted.length - 1]}`);
      const byResp = [...allIds]; // ordre tel que renvoyé par l'API
      console.log(`  ✓ 10 premiers (API)   : [${byResp.slice(0, 10).join(", ")}]`);
      console.log(`  ✓ 10 derniers (API)   : [${byResp.slice(-10).join(", ")}]`);
      console.log(`  ✓ IDs > last_order_id : ${allIds.filter(id => id > lastOrderId).length}`);
    } else {
      console.log(`  ⚠ Aucun ID retourné par Prestashop`);
    }
  } catch (e) {
    console.error(`  ❌ Erreur Prestashop (liste IDs): ${e.message}`);
    process.exit(1);
  }

  // ── 3. Filtrer les commandes depuis last_order_id - 100 ──────────
  // Le buffer de 100 permet de rattraper d'éventuelles commandes manquées
  // lors d'une sync précédente. L'UPSERT sur (order_id, product_ref)
  // garantit qu'aucune ligne n'est dupliquée.
  const SYNC_BUFFER = 100;
  const filterFromId = Math.max(0, lastOrderId - SYNC_BUFFER);
  const newIds = allIds.filter(id => id > filterFromId).sort((a, b) => a - b);
  const trulyNew = newIds.filter(id => id > lastOrderId).length;
  console.log(`  ✓ Commandes à traiter (id > ${filterFromId}) : ${newIds.length} (dont ${trulyNew} nouvelles, ${newIds.length - trulyNew} re-synchro buffer)`);


  if (!newIds.length) {
    console.log(`\n  ✓ Aucune commande à traiter (buffer de ${SYNC_BUFFER} inclus).`);
    await updateSyncState(lastOrderId);
    return;
  }

  // ── 4. Charger les états de commande (pour exclusion par nom) ────
  const stateMap = {};
  let stateMapMode = "ids_fallback"; // "names" | "ids_fallback"
  try {
    const resp = await psGet("/order_states?display=[id,name]&limit=200");
    (resp.order_states || []).forEach(s => {
      stateMap[String(s.id)] = s.name || String(s.id);
    });
    stateMapMode = "names";
    console.log(`  ✓ États commandes chargés : ${Object.keys(stateMap).length} (exclusion par nom active)`);
  } catch (e) {
    const is401 = e.message.includes("401") || e.message.includes("not allowed");
    if (is401) {
      console.warn(`  ⚠ Permission order_states manquante (401) — fallback sur IDs par défaut`);
      console.warn(`    IDs exclus par défaut : ${[...EXCLUDED_STATE_IDS].join(", ")} (Annulé, Remboursé, Erreur paiement)`);
      console.warn(`    → Pour une exclusion complète, ajoutez order_states→GET à la clé API Prestashop`);
    } else {
      console.warn(`  ⚠ Impossible de charger les états: ${e.message}`);
    }
  }
  console.log(`  ✓ Mode exclusion états : ${stateMapMode}`);

  // ── 5. Traiter chaque nouvelle commande ──────────────────────────
  let totalLines = 0;
  let insertedLines = 0;
  let skippedOrders = 0;
  let psErrors = 0;
  let sbErrors = 0;
  let maxId = lastOrderId;
  const buffer = [];

  async function flushBuffer() {
    if (!buffer.length) return;
    try {
      await sbUpsert("ps_sales_daily", buffer, "order_id,product_ref");
      insertedLines += buffer.length;
      console.log(`    → ${buffer.length} lignes insérées (total: ${insertedLines})`);
    } catch (e) {
      console.error(`  ❌ Erreur Supabase insertion: ${e.message}`);
      sbErrors++;
    }
    buffer.length = 0;
  }

  for (const orderId of newIds) {
    try {
      const resp = await psGet(`/orders/${orderId}`);
      const order = resp.order;
      if (!order) {
        console.warn(`  ⚠ Commande #${orderId} : réponse vide`);
        psErrors++;
        if (orderId > maxId) maxId = orderId;
        continue;
      }

      const stateId = String(order.current_state || "");
      const stateName = stateMap[stateId] || stateId;
      if (shouldExcludeOrder(stateName)) {
        const reason = stateMap[stateId] ? `nom="${stateName}"` : `id=${stateId} (nom inconnu — permission order_states manquante)`;
        console.log(`  ⊘ Commande #${orderId} exclue — état: ${reason}`);
        skippedOrders++;
        if (orderId > maxId) maxId = orderId;
        continue;
      }

      const marketplace = mapMarketplaceFromPayment(order.payment);
      const saleDate = String(order.date_add || "").slice(0, 10);
      const orderRef = order.reference || null;
      const paymentMethod = order.payment || null;

      // Normaliser order_rows (PS peut renvoyer un objet si 1 seul élément)
      const rawRows = order.associations?.order_rows?.order_row;
      let rowsArr = [];
      if (Array.isArray(rawRows)) {
        rowsArr = rawRows;
      } else if (rawRows && typeof rawRows === "object") {
        rowsArr = [rawRows];
      }

      for (const row of rowsArr) {
        if (!row || !row.product_reference) continue;
        const qty = toInt(row.product_quantity) || 1;
        const revTtc = Math.round(toFloat(row.unit_price_tax_incl) * qty * 100) / 100;
        const revHt = Math.round(toFloat(row.unit_price_tax_excl) * qty * 100) / 100;

        totalLines++;
        buffer.push({
          order_id:        toInt(orderId),
          order_reference: orderRef,
          sale_date:       saleDate,
          payment_method:  paymentMethod,
          marketplace,
          product_ref:     String(row.product_reference).trim(),
          product_name:    String(row.product_name || "").slice(0, 255),
          quantity:        qty,
          revenue_ttc:     revTtc,
          revenue_ht:      revHt,
          order_state:     stateName,
        });
      }

      if (orderId > maxId) maxId = orderId;

      // Flush par lots de 100
      if (buffer.length >= 100) await flushBuffer();

    } catch (e) {
      console.error(`  ❌ Erreur Prestashop commande #${orderId}: ${e.message}`);
      psErrors++;
      if (orderId > maxId) maxId = orderId;
    }
  }

  // Vider le buffer restant
  await flushBuffer();

  // ── 6. Mettre à jour ps_sync_state ──────────────────────────────
  await updateSyncState(maxId);

  // ── 7. Résumé ────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  ══════════════ Résumé sync ══════════════`);
  console.log(`  Fenêtre traitée          : id > ${filterFromId} (buffer -${SYNC_BUFFER})`);
  console.log(`  Commandes traitées       : ${newIds.length} (${trulyNew} nouvelles + ${newIds.length - trulyNew} re-synchro)`);
  console.log(`  Commandes exclues        : ${skippedOrders}`);
  console.log(`  Lignes produits générées : ${totalLines}`);
  console.log(`  Lignes insérées          : ${insertedLines}`);
  console.log(`  Nouveau last_order_id    : ${maxId}`);
  console.log(`  Erreurs Prestashop       : ${psErrors}`);
  console.log(`  Erreurs Supabase         : ${sbErrors}`);
  console.log(`  Durée                    : ${elapsed}s`);
  console.log(`  ═════════════════════════════════════════\n`);

  if (psErrors > 0 || sbErrors > 0) process.exit(1);
}

async function updateSyncState(newLastId) {
  try {
    await sbPatch("ps_sync_state", "id=eq.1", {
      last_order_id: newLastId,
      last_sync_at: new Date().toISOString(),
    });
    console.log(`  ✓ ps_sync_state mis à jour (last_order_id=${newLastId})`);
  } catch (e) {
    console.error(`  ❌ Impossible de mettre à jour ps_sync_state: ${e.message}`);
  }
}

main().catch(e => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
