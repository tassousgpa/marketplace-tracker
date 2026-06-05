/**
 * Diagnostic — Structure de order_extra_information
 * Usage : node diag_lengow.js <id_commande_PS>
 * Exemple : node diag_lengow.js 557782
 */
require("dotenv").config();

const PS_URL = (process.env.PRESTASHOP_API_URL || "").replace(/\/$/, "");
const PS_KEY = process.env.PRESTASHOP_API_KEY || "";

if (!PS_URL || !PS_KEY) {
  console.error("❌ Créer un fichier .env avec PRESTASHOP_API_URL et PRESTASHOP_API_KEY");
  process.exit(1);
}

const ORDER_ID = process.argv[2];
if (!ORDER_ID) {
  console.error("❌ Fournir un ID commande : node diag_lengow.js 557782");
  process.exit(1);
}

const PS_AUTH = "Basic " + Buffer.from(PS_KEY + ":").toString("base64");

// PS_URL contient déjà /api — les chemins ne doivent PAS commencer par /api/
async function get(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${PS_URL}${path}${sep}output_format=JSON`;
  const r = await fetch(url, { headers: { Authorization: PS_AUTH } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function main() {
  console.log(`\n🔍 Diagnostic PS API pour commande #${ORDER_ID}`);
  console.log(`   URL de base : ${PS_URL}\n`);

  // ── 1. order_extra_information ───────────────────────────────
  console.log("── 1. Ressource order_extra_information ──────────────────");
  try {
    const r = await get(`/order_extra_information?filter[id_order]=[${ORDER_ID}]&display=full&limit=5`);
    const items = r.order_extra_informations || r.order_extra_information || r;
    if (!items || (Array.isArray(items) && items.length === 0)) {
      console.log("   → Aucune donnée pour cette commande");
    } else {
      console.log("   → Structure :", JSON.stringify(items, null, 2));
    }
  } catch (e) {
    console.log("   → Erreur :", e.message);
  }

  // ── 2. order_details (lignes produits) ───────────────────────
  console.log("\n── 2. Ressource order_details ────────────────────────────");
  try {
    const r = await get(`/order_details?filter[id_order]=[${ORDER_ID}]&display=full&limit=5`);
    const items = r.order_details || r.order_detail || r;
    if (!items || (Array.isArray(items) && items.length === 0)) {
      console.log("   → Aucune donnée");
    } else {
      const sample = Array.isArray(items) ? items[0] : items;
      console.log("   → Champs disponibles :", Object.keys(sample).join(", "));
      console.log("   → 1ère ligne :", JSON.stringify(sample, null, 2));
    }
  } catch (e) {
    console.log("   → Erreur :", e.message);
  }

  // ── 3. order_payments ────────────────────────────────────────
  console.log("\n── 3. Ressource order_payments ───────────────────────────");
  try {
    const r2 = await get(`/orders/${ORDER_ID}?display=[reference,payment]`);
    const ref = r2.order?.reference;
    if (ref) {
      const rp = await get(`/order_payments?filter[order_reference]=[${ref}]&display=full`);
      const pays = rp.order_payments || rp.order_payment || [];
      console.log("   → Référence commande :", ref);
      console.log("   → Paiements :", JSON.stringify(Array.isArray(pays) ? pays : [pays], null, 2));
    }
  } catch (e) {
    console.log("   → Erreur :", e.message);
  }

  // ── 4. Commande complète (tous les champs) ────────────────────
  console.log("\n── 4. Commande complète — champs disponibles ─────────────");
  try {
    const r = await get(`/orders/${ORDER_ID}?display=full`);
    const o = r.order || r;
    console.log("   → Champs :", Object.keys(o).join(", "));
    // Chercher tout champ qui ressemble à une commission
    const commKeys = Object.keys(o).filter(k => /comm|fee|lengow|marketplace|extra/i.test(k));
    if (commKeys.length) {
      console.log("   → Champs potentiels commission :");
      commKeys.forEach(k => console.log(`      ${k} = ${JSON.stringify(o[k])}`));
    } else {
      console.log("   → Aucun champ lié à commission/lengow trouvé");
    }
  } catch (e) {
    console.log("   → Erreur :", e.message);
  }

  // ── 5. Messages de commande ───────────────────────────────────
  console.log("\n── 5. Messages de commande ───────────────────────────────");
  try {
    const r = await get(`/messages?filter[id_order]=[${ORDER_ID}]&display=full&limit=3`);
    const items = r.messages || r.message || [];
    if (!items || (Array.isArray(items) && items.length === 0)) {
      console.log("   → Aucun message");
    } else {
      console.log("   → Messages :", JSON.stringify(Array.isArray(items) ? items : [items], null, 2).slice(0, 1000));
    }
  } catch (e) {
    console.log("   → Erreur :", e.message);
  }

  console.log("\n✓ Diagnostic terminé\n");
}

main().catch(e => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
