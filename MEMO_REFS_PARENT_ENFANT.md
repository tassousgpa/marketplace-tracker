# Mémo — Structure Réfs Enfant / Parent BestMobilier

## Concept

Les références produits BestMobilier suivent une convention de nommage hiérarchique :

- **Réf parent** : identifiant numérique du modèle (ex: `1366`, `2797`, `3509`)
- **Réf enfant** : réf parent + suffixe couleur (ex: `1366BEI`, `1366V`, `1366B`)

Un même modèle peut avoir plusieurs déclinaisons coloris (enfants partageant le même parent).

## Exemples

| Réf enfant | Réf parent | Couleur |
|---|---|---|
| 1366BEI | 1366 | Beige |
| 1366V | 1366 | Vert |
| 1366B | 1366 | Blanc |
| 2797BEI | 2797 | Beige |
| 2797G | 2797 | Gris |

## Utilisation dans l'app

La table de correspondance est stockée dans **`data/product_refs.json`** :

```json
{
  "new2026": ["3501BEI", "3506BEI", ...],
  "child_to_parent": { "1366BEI": "1366", "1366V": "1366", ... },
  "parent_to_children": { "1366": ["1366BEI", "1366V", "1366B"], ... }
}
```

## Cas d'usage développement

### Alerte SEA doublon parent (Alerte 3)
Si deux enfants d'un même parent sont actifs en SEA sur la **même marketplace** simultanément
→ alerte : duplication de budget sur le même modèle.

Exemple : `1366BEI` et `1366V` tous deux actifs en SEA sur Cdiscount → alerte.

### Filtres et analytics
- Regrouper les ventes par modèle (parent) pour avoir une vision agrégée
- Identifier les déclinaisons les plus performantes d'un même modèle

## Source des données

Fichier : `Date de sortie produit par SKU.xlsx`
- Col B : Date de sortie
- Col C : Réf enfant
- Col D : Réf parent

**À mettre à jour** : lors de l'ajout de nouveaux produits, mettre à jour le fichier Excel
et ré-exécuter le script de génération de `data/product_refs.json`.

## Générer / Mettre à jour product_refs.json

```bash
python3 scripts/generate_product_refs.py
```

(Script à créer — voir logique dans ce mémo)
