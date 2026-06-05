-- ══════════════════════════════════════════════════════════════════
-- Export hebdomadaire des commissions Lengow
-- À coller dans phpMyAdmin → onglet SQL
-- Exporter en CSV (séparateur ; ou ,) → importer dans l'onglet TDC
-- ══════════════════════════════════════════════════════════════════

SELECT
  lo.id_order,
  CAST(
    JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.commission'))
    AS DECIMAL(12,2)
  )                                                          AS commission,
  JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace_order_id'))
                                                             AS marketplace_order_id,
  CAST(
    JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.total_order'))
    AS DECIMAL(12,2)
  )                                                          AS total_order,
  CAST(
    JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.shipping'))
    AS DECIMAL(12,2)
  )                                                          AS shipping,
  JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace'))      AS marketplace,
  JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace_status')) AS statut

FROM psdem1_lengow_orders lo

WHERE lo.id_order IS NOT NULL
  AND lo.id_order > 0
  AND JSON_EXTRACT(lo.extra, '$.commission') IS NOT NULL
  AND CAST(
        JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.commission'))
        AS DECIMAL(12,2)
      ) > 0
  -- Exclure les commandes annulées / remboursées
  AND JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace_status'))
      NOT IN ('REFUNDED','CANCELED','CANCELLED','CLOSED_BY_CUSTOMER')

ORDER BY lo.id_order DESC;

-- ──────────────────────────────────────────────────────────────────
-- VERSION FILTRÉE SUR LES 30 DERNIERS JOURS (recommandée en usage courant)
-- Remplacer la requête ci-dessus par celle-ci si la table est volumineuse :
-- ──────────────────────────────────────────────────────────────────
/*
SELECT
  lo.id_order,
  CAST(JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.commission')) AS DECIMAL(12,2)) AS commission,
  JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace_order_id'))               AS marketplace_order_id,
  CAST(JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.total_order')) AS DECIMAL(12,2)) AS total_order,
  CAST(JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.shipping'))    AS DECIMAL(12,2)) AS shipping,
  JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace'))                        AS marketplace,
  JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace_status'))                 AS statut
FROM psdem1_lengow_orders lo
INNER JOIN psdem1_orders o ON o.id_order = lo.id_order
WHERE lo.id_order IS NOT NULL AND lo.id_order > 0
  AND JSON_EXTRACT(lo.extra, '$.commission') IS NOT NULL
  AND CAST(JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.commission')) AS DECIMAL(12,2)) > 0
  AND JSON_UNQUOTE(JSON_EXTRACT(lo.extra, '$.marketplace_status'))
      NOT IN ('REFUNDED','CANCELED','CANCELLED','CLOSED_BY_CUSTOMER')
  AND o.date_add >= DATE_SUB(NOW(), INTERVAL 30 DAY)
ORDER BY lo.id_order DESC;
*/
