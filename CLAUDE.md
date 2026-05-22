# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A French-language marketplace monitoring dashboard for BestMobilier, tracking products, positions, competitor activity, and revenue across 7 marketplaces (Cdiscount, Amazon, Maisons du Monde, Conforama, La Redoute, BUT, ManoMano).

## Running the app

No build step or package installation is required. Open `index.html` directly in a browser, or serve it with any static file server:

```bash
python3 -m http.server 8080
# or
npx serve .
```

The app is deployed on Vercel and reads all data from Supabase at runtime.

## Architecture

The entire application is a **single `index.html` file** (~3800 lines) containing all HTML, CSS, and JavaScript inline. There are no separate source files, no bundler, and no backend code in this repo.

### Data layer — Supabase

All data is fetched directly from Supabase via the REST API using the `sb()`, `sbInsert()`, `sbUpdate()`, and `sbDelete()` helpers at the top of the script. The anon key and URL are hardcoded as `SB_URL` / `SB_KEY` constants.

Key tables:
- `products` — tracked products per marketplace (with `product_id_scraper`, `sku`, `sku_marketplace`, `url`)
- `product_snapshots` — time-series price/availability/rating/delivery data per product
- `positions` — search page 1 results per keyword per marketplace
- `seller_stats` — competitor seller data (sales counts, ratings, best-seller info)
- `tracked_sellers` — the list of competitors to show in the Concurrents tab
- `revenue_entries` — manually entered weekly revenue
- `revenue_imports` — XLS-imported revenue data (weekly or YTD)
- `revenue_monthly_history` — historical monthly revenue summaries
- `commercial_operations` / `operation_products` — active promotional deals
- `product_sales_weekly` — weekly per-SKU sales imported from Odoo

### State and rendering

`loadData()` fetches all tables in parallel and populates the global `STATE` object. All rendering is synchronous from `STATE`; re-renders happen by calling `renderContent()`.

Navigation is tab-based. Full marketplaces have 9 tabs (0–8); "light" marketplaces like ManoMano skip Positions and Concurrents:

| Index | Tab |
|-------|-----|
| 0 | Synthèse — KPIs, revenue block, top weekly sales |
| 1 | Produits — filterable product table, CSV export |
| 2 | Historique — cross-date metric comparison table |
| 3 | Positions — page-1 presence by keyword (full only) |
| 4 | Concurrents — competitor seller metrics (full only) |
| 5 | Anomalies |
| 6 | Audit |
| 7 | Opé. Commerciales — promotional deals CRUD |
| 8 | Gestion — product/seller management |

### Key global constants / variables

- `MAINTENANCE_MODE` — set to `true` to show a maintenance screen
- `MARKETPLACE` — currently selected marketplace id (e.g. `"cdiscount"`)
- `STATE` — global object holding all loaded data and current tab index
- `NO_POSITIONS_MP` / `NO_COMPETITORS_MP` — sets of marketplace ids that skip those tabs
- `BM_SELLER_NAMES` / `BM_NAMES_SET` — name variants for BestMobilier (the tracked brand)

### Competitor data logic

Two seller tracking modes exist depending on `mpType()`:
- `"cumul"` (Conforama, MdM): `seller_sales` is a cumulative total; delta is computed between sessions
- `"ltm"` (others): `seller_sales` is an LTM snapshot; for Amazon/BUT, `seller_ratings_count` is used as a sales proxy

`resolveSellerNames()` maps display names to raw names stored in `seller_stats` (handles VidaXL casing variants, etc.).
