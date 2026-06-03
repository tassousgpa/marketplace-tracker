-- ══════════════════════════════════════════════════════════════════
-- Migration : SEA Actifs + Soldes Été
-- À exécuter dans Supabase SQL Editor (Settings → SQL Editor)
-- ══════════════════════════════════════════════════════════════════

-- ── 1. sea_active_products ───────────────────────────────────────
-- Produits déclarés SEA actifs sur une période donnée.
-- Source de vérité unique pour le tag ⚡ SEA dans toute l'app.
CREATE TABLE IF NOT EXISTS sea_active_products (
  id           BIGSERIAL PRIMARY KEY,
  marketplace  TEXT      NOT NULL,
  sku          TEXT      NOT NULL,
  period_start DATE      NOT NULL,
  period_end   DATE      NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sea_active_mp_sku
  ON sea_active_products(marketplace, sku);

CREATE INDEX IF NOT EXISTS idx_sea_active_mp_period
  ON sea_active_products(marketplace, period_start, period_end);

-- Index partiel pour requêtes "actif aujourd'hui"
CREATE INDEX IF NOT EXISTS idx_sea_active_current
  ON sea_active_products(marketplace, sku)
  WHERE period_end >= CURRENT_DATE;

-- ── 2. soldes_editions ──────────────────────────────────────────
-- Paramètres de chaque édition de soldes (une ligne par an).
-- Le workflow GitHub Actions lit ces paramètres pour calculer day_rank.
CREATE TABLE IF NOT EXISTS soldes_editions (
  id         BIGSERIAL PRIMARY KEY,
  edition    TEXT UNIQUE NOT NULL,  -- ex: '2025', '2026'
  start_date DATE        NOT NULL,
  end_date   DATE        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pré-remplir l'édition 2026 (dates connues)
INSERT INTO soldes_editions (edition, start_date, end_date)
VALUES ('2026', '2026-06-24', '2026-07-21')
ON CONFLICT (edition) DO NOTHING;

-- ── 3. soldes_daily_sales ───────────────────────────────────────
-- Ventes journalières enrichies pour la comparaison Soldes.
-- day_rank = (sale_date - start_date)::integer + 1
-- Peuplé par le workflow GitHub Actions "Soldes Été Historique".
CREATE TABLE IF NOT EXISTS soldes_daily_sales (
  id          BIGSERIAL PRIMARY KEY,
  edition     TEXT         NOT NULL,  -- '2025' ou '2026'
  sku         TEXT         NOT NULL,
  marketplace TEXT         NOT NULL,
  sale_date   DATE         NOT NULL,
  day_rank    INTEGER      NOT NULL,  -- 1 = premier jour des soldes
  quantity    INTEGER      DEFAULT 0,
  revenue_ht  NUMERIC(12,2) DEFAULT 0,
  UNIQUE(edition, sku, marketplace, sale_date)
);

CREATE INDEX IF NOT EXISTS idx_soldes_rank
  ON soldes_daily_sales(edition, day_rank);

CREATE INDEX IF NOT EXISTS idx_soldes_sku_mp
  ON soldes_daily_sales(edition, sku, marketplace);

CREATE INDEX IF NOT EXISTS idx_soldes_date
  ON soldes_daily_sales(edition, sale_date);

-- ── RLS (Row Level Security) ────────────────────────────────────
-- Activer RLS si ce n'est pas déjà fait, et permettre lecture anon.
-- À adapter selon votre politique de sécurité Supabase.

ALTER TABLE sea_active_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_sea_active"  ON sea_active_products FOR SELECT USING (true);
CREATE POLICY "anon_write_sea_active" ON sea_active_products FOR ALL    USING (true);

ALTER TABLE soldes_editions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_soldes_editions"  ON soldes_editions FOR SELECT USING (true);
CREATE POLICY "anon_write_soldes_editions" ON soldes_editions FOR ALL    USING (true);

ALTER TABLE soldes_daily_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_soldes_sales"  ON soldes_daily_sales FOR SELECT USING (true);
CREATE POLICY "anon_write_soldes_sales" ON soldes_daily_sales FOR ALL    USING (true);
