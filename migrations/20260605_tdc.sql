-- ══════════════════════════════════════════════════════════════════
-- TDC — Taux De Commission
-- Enrichissement ps_sales_daily + table commission_rates
-- ══════════════════════════════════════════════════════════════════

-- 1. Nouvelles colonnes sur ps_sales_daily
ALTER TABLE ps_sales_daily
  ADD COLUMN IF NOT EXISTS commission                   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS lengow_marketplace_order_id  TEXT,
  ADD COLUMN IF NOT EXISTS lengow_total_order           NUMERIC(12,2);

-- Index pour les requêtes TDC
CREATE INDEX IF NOT EXISTS idx_ps_sales_daily_tdc
  ON ps_sales_daily(marketplace, sale_date)
  WHERE commission IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────
-- 2. Backfill lengow_total_order sur les commandes existantes
--    (les nouvelles commandes seront remplies par ps_sync.js)
--    Logique : total = SUM(revenue_ttc toutes lignes) + shipping_ttc
--    Appliqué uniquement sur la première ligne de chaque commande
--    (celle avec shipping_ttc le plus élevé, ou product_ref min si ex-aequo)
-- ──────────────────────────────────────────────────────────────────
WITH ranked AS (
  SELECT
    order_id,
    product_ref,
    ROUND(
      SUM(revenue_ttc)  OVER (PARTITION BY order_id) +
      MAX(shipping_ttc) OVER (PARTITION BY order_id),
      2
    ) AS total_ttc,
    ROW_NUMBER() OVER (
      PARTITION BY order_id
      ORDER BY shipping_ttc DESC, product_ref ASC
    ) AS rn
  FROM ps_sales_daily
  WHERE order_id IS NOT NULL
    AND order_id > 0
    AND lengow_total_order IS NULL
)
UPDATE ps_sales_daily p
SET lengow_total_order = r.total_ttc
FROM ranked r
WHERE p.order_id   = r.order_id
  AND p.product_ref = r.product_ref
  AND r.rn          = 1
  AND r.total_ttc   > 0;

-- ──────────────────────────────────────────────────────────────────
-- 3. Table des taux de commission théoriques
--    product_ref NULL  = taux par défaut de la marketplace
--    product_ref non NULL = taux spécifique SKU
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_rates (
  id          BIGSERIAL    PRIMARY KEY,
  marketplace TEXT         NOT NULL,
  product_ref TEXT,
  rate        NUMERIC(5,2) NOT NULL,
  valid_from  DATE,
  valid_to    DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Un seul taux par défaut par marketplace
CREATE UNIQUE INDEX IF NOT EXISTS commission_rates_mp_default
  ON commission_rates(marketplace)
  WHERE product_ref IS NULL;

-- Un seul taux par (marketplace, SKU)
CREATE UNIQUE INDEX IF NOT EXISTS commission_rates_mp_sku
  ON commission_rates(marketplace, product_ref)
  WHERE product_ref IS NOT NULL;

-- 4. Taux par défaut (à confirmer avec l'équipe marketplace)
INSERT INTO commission_rates (marketplace, product_ref, rate, notes) VALUES
  ('cdiscount',      NULL, 14.00, 'Taux défaut Cdiscount — à confirmer'),
  ('amazon',         NULL, 15.00, 'Taux défaut Amazon — à confirmer'),
  ('maisonsdumonde', NULL, 20.00, 'Taux défaut MdM — à confirmer'),
  ('conforama',      NULL, 15.00, 'Taux défaut Conforama — à confirmer'),
  ('laredoute',      NULL, 18.00, 'Taux défaut La Redoute — à confirmer'),
  ('but',            NULL, 12.00, 'Taux défaut BUT — à confirmer'),
  ('manomano',       NULL, 14.00, 'Taux défaut ManoMano — à confirmer'),
  ('leroymerlin',    NULL, 16.00, 'Taux défaut Leroy Merlin — à confirmer')
ON CONFLICT DO NOTHING;
