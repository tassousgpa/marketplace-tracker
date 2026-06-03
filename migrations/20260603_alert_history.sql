-- ══════════════════════════════════════════════════════════════════
-- Migration : table alert_history
-- À exécuter dans Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS alert_history (
  id            BIGSERIAL PRIMARY KEY,
  marketplace   TEXT NOT NULL,
  alert_type    TEXT NOT NULL,  -- 'price_ecart' | 'sea_delivery' | 'sea_ope_doublon' | 'sea_parent_doublon' | 'sea_multi_mp'
  sku           TEXT NOT NULL,
  detail        JSONB,          -- contexte libre (prix, délai, opé, etc.)
  validated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_mp ON alert_history(marketplace, alert_type);
CREATE INDEX IF NOT EXISTS idx_alert_history_sku ON alert_history(sku);

ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_alert_history"   ON alert_history FOR SELECT USING (true);
CREATE POLICY "anon_insert_alert_history" ON alert_history FOR INSERT WITH CHECK (true);
