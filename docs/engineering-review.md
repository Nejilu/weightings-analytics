# Bilan consolidé des revues d’ingénierie

**État observé :** 2026-08-14
**Objet :** conserver les décisions utiles de la boucle d’optimisation sans
maintenir un journal chronologique redondant.

Le détail d’exécution a été condensé. Le
[plan final](iterative-agent-work-plan.md) est désormais un historique terminé ;
les contrats courants restent décrits par l’[architecture Metrics Overview](metrics-overview-architecture.md).

## Verdict

La branche est matériellement meilleure en fiabilité, couverture mondiale,
temps de redémarrage et transparence. La livraison est structurée en lots
logiques committés. La commande standard et le build Next passent dans
l’environnement autorisant les processus enfants : 148 tests TypeScript, les
audits annexes et la génération des 12 pages Next sont validés. Le précédent
`spawn EPERM` était donc environnemental. Le contrat HTTP v1 et son ETag sont
couverts sur la représentation sérialisée complète.

## Réaudit de simplification

Le contrôle suivant a confirmé que certaines protections avaient été découpées
en modules trop fins. Les wrappers de clés de cache, de politique HTTP et de
code d’erreur ont été réintégrés à leur unique consommateur. L’instrumentation
Metrics par phases et ses compteurs internes ont été retirés après mesure.

La réconciliation complète des identités n’est plus exécutée à chaque lancement
de l’application : elle reste transactionnelle lors d’une ingestion v3, qui est
précisément le moment où une ancienne identité peut devoir être remplacée.

Un défaut fonctionnel a aussi été supprimé : un payload iShares/BlackRock trop
court passe maintenant à la prochaine source officielle au lieu de retélécharger
le même candidat. Compare, Portfolio, ETF Creator et Metrics ont été contrôlés
par API et dans la webapp après ces changements.

Les mécanismes conservés ont un effet mesuré ou protègent une donnée métier :
snapshots SQLite, déduplication des appels en cours, cache de résultat Metrics,
ETag et cache négatif. Ce dernier est désormais présenté comme une seule
abstraction bornée avec persistance SQLite, pas comme deux caches indépendants.

## Décisions à conserver

### Données et analytique

- La série EPS utilise exclusivement quatre estimations historiques et quatre
  estimations futures. Les EPS publiés ou reconstruits sont exclus.
- P/E, P/B et P/S sont agrégés par moyenne harmonique pondérée sur les valeurs
  positives couvertes.
- Rendement, ROE, dette/equity et bêta restent arithmétiques pondérés.
- Les couvertures et valeurs manquantes sont visibles ; aucun résultat partiel
  n’est présenté comme complet.
- Le bubble chart utilise des axes robustes indépendants du sélecteur 4Q/2Q/1Q.
  Seuls les points sans série Q-3/Next Q complète, sans P/E positif à l’une des
  deux extrémités ou au-delà du top-500 pondéré sont exclus et comptés. Les ETF
  comparés sont superposés sous forme de petits carrés fixes et teintés.

### Provider, mapping et cache

- TradingView est interrogé en lots, jamais titre par titre pour le Screener.
- `missingSymbols` et `failedSymbols` restent distincts. Un échec de transport
  ne doit jamais devenir une absence persistée.
- Les mappings conservent exchange, provenance, description provider, candidats
  et contrôle d’émetteur.
- Une observation Screener ou Estimates n’est utilisable que si son symbole
  correspond au mapping courant.
- Le cache négatif borné et sa persistance `provider_negative_cache` sont
  conservés. Leur bénéfice après redémarrage est mesuré et l’API runtime a été
  ramenée à une abstraction unique.
- Les entrées expirent, sont prunées au bootstrap et sont supprimées lorsqu’une
  valeur redevient disponible.

### Runtime et produit

- Les statuts `live`, `cached`, `partial` et `stale` ont des sens distincts et
  utiles. `partial` désigne une absence confirmée ; `stale` une erreur avec
  fallback compatible.
- Les warnings typés restent affichés dans le panel.
- L’ETag est calculé sur le JSON complet effectivement envoyé ; le `304`
  conditionnel n’est donc possible que pour une représentation identique.
- Les requêtes UI sont annulées lors d’un changement de sélection.
- Le launcher standalone conserve les chemins SQLite/migrations et copie les
  assets statiques nécessaires.
- Un payload iShares ou BlackRock vide ou incomplet passe à la source officielle
  suivante sans assouplir les seuils de plausibilité propres à l’ETF.

### Persistance et performance locale

- Les écritures mapping, Screener, Estimates et métriques dérivées sont groupées
  en transactions et lots de 250.
- Les deux lectures chaudes Metrics Overview utilisent un SQL paramétré direct
  après mesure du coût Drizzle. Cette exception ne doit pas être généralisée.
- La suppression des anciennes définitions métriques est portée par la migration
  `0009`, pas par l’initialisation applicative.
- Les séries EPS invalides ou JSON malformées sont retirées par les migrations
  `0007` et `0008`, puis protégées par le validateur runtime.

## Preuves principales

| Sujet | Résultat observé |
| --- | --- |
| Audit mapping strict local du 2026-08-14 | 3 271 résolus, 1 unresolved, 0 mismatch d’identité ; échec strict dû à 995 mappings hérités sans provenance et 7 références orphelines |
| Couverture mapping locale | ACWI, CHIP, IEMG, IQQ, IVV, NDXWLD, PANX, QLD, QTOP, SP20, TQQQ et URTH à 100 % du poids arrondi ; CSEMAS à 544/548 titres et 95,26 % du poids ; la complétude pondérale ne remplace pas la provenance |
| Cache négatif inter-processus | IEMG d’environ 5,9 s à environ 309 ms, 0 symbole redemandé |
| Capture de `databasePath()` | `derive-and-write` environ 126,7 → 49–54 ms |
| Mapping plan | environ 138–149 → 40–48 ms |
| Lecture EPS directe | médiane environ 26,7 → 7,3 ms sur 2 981 lignes |
| DTO compact | variante mesurée puis rejetée : elle supprimait des champs v1 |
| Validation HTTP | réponses 200 puis 304 avec ETag stable sur les univers contrôlés |
| Baseline séquentielle | IVV 1,1 s/654 Ko/32,3 %, ACWI 3,8 s/672 Ko/36,4 %, CHIP 35 ms/71 Ko/116,6 %, IEMG 25,6 s/673 Ko/74,4 % ; mapping 100 % |
| Validation du lot 2026-08-13 | lint, typecheck, 147/147 tests TS, 3/3 tests d’audit, migration smoke, 2/2 tests d’assets et build des 12 routes Next passent |
| Validation CSEMAS du 2026-08-14 | flux officiel de 559 lignes parsées (557 à poids positif), seed SQLite, lint, typecheck, 148/148 tests TS et build des 12 routes Next passent |

Les durées provider dépendent du réseau et de l’état des caches. Elles justifient
les décisions prises mais ne constituent pas un SLA.

## Expériences rejetées

Les variantes suivantes n’ont pas fourni de gain end-to-end reproductible ou
augmentaient la complexité :

- latest-only SQLite avec `ROW_NUMBER`, `NOT EXISTS` ou `MAX(captured_at)` ;
- tailles de lots SQLite supérieures à 250 ;
- suppression du tri SQL au profit d’un tri JavaScript ;
- statements préparés partagés entre lots ;
- lecture des mappings hors ORM pour un gain de quelques millisecondes ;
- tailles de lots Estimates 125 ou 500 ;
- concurrence Screener portée à 4 ;
- chevauchement Screener/Estimates ;
- parsing lazy des métadonnées mapping ;
- nouvelle réduction du DTO par dictionnaire de périodes ;
- cache distribué et découpage supplémentaire en micro-modules.

Ces pistes restent fermées sans changement mesuré de volume ou de profil.

## Écarts par rapport au plan initial

### Simplification ciblée

Le pipeline initial comptait environ 370 lignes dans un service. Après le
réaudit, l’état courant compte 1 325 lignes non vides dans quatre modules, dont
345 dans l’orchestrateur. L’objectif indicatif de 250–350 lignes pour
l’orchestrateur est désormais atteint sans modifier le DTO ni les calculs.

Une partie de cette hausse est justifiée par la provenance, les absences
confirmées, la compatibilité des symboles et les transitions de statut. La
refactorisation finale a supprimé les trois frontières provider répétées et
déplacé l’assemblage ETF dans le module Model sans créer de fichier de
production supplémentaire. Un nouveau découpage serait injustifié sans mesure.

### Contrat API restauré

La compaction par `estimatePeriods`/`estimates` retirait `securityId`,
`providerSymbol`, les deux sommes EPS et les objets détaillés déjà publiés par
`/api/v1`. Elle a été rejetée malgré son gain de payload. Les champs v1 sont
maintenant conservés ; les compteurs transparents sont ajoutés séparément et
testés au niveau modèle et au niveau de la réponse HTTP.

### Documentation et livraison

La boucle précédente avait produit plus de 5 000 lignes réparties sur quatre
documents, avec des mesures répétées et des statuts parfois obsolètes. Le
runbook append-only a été retiré ; ce bilan conserve uniquement décisions,
preuves, rejets et risques.

Le worktree reste physiquement large, mais les changements sont désormais
classés pour une livraison séparée :

- **lot Metrics Overview :** contrat, agrégats, sémantique Estimates, providers
  TradingView, modèle et panel ;
- **lot données/persistance :** iShares, holdings, repositories, schéma et
  migrations ;
- **lot produit transversal :** Portfolio, Compare, ETF Creator, prix, recherche
  et routes de santé ;
- **lot runtime/publication :** launcher standalone, assets, configuration,
  scripts et documentation.

Aucun nouveau correctif hors Metrics n’a été ajouté pendant cette phase. Ces lots
ont été matérialisés en commits distincts ; la séparation est donc vérifiable
dans l’historique et ne repose pas sur un simple classement documentaire.

| Lot | Fichiers effectivement concernés | Décision |
| --- | --- | --- |
| Metrics Overview | `src/app/api/v1/metrics/overview/**`, `src/components/dashboard/metrics-overview.tsx`, `src/data/services/metrics-overview-*`, `src/data/providers/tradingview-*`, `src/domain/metrics*`, agrégats EPS, repository Metrics et audits TradingView | Conserver et livrer ensemble ; P1–P4 s’y appliquent. |
| Données/persistance | iShares, holdings, repositories non-Metrics, `src/db/**`, `drizzle/**`, caches provider transversaux | Conserver si le test associé passe ; livrer séparément, sans nouvelle extension pendant P5. |
| Produit transversal | routes et composants Catalog, Compare, ETF Creator, Portfolio, prix, recherche et santé ; services/domaines correspondants | Ne pas mélanger au lot Metrics ; aucune anomalie nouvelle corrigée. |
| Runtime/publication | `package*.json`, `.env.example`, launcher/assets standalone, scripts de bootstrap/statistiques, README et CSS global | Conserver pour la publication ; smoke et build requis dans P6. |

## Risques ouverts

1. La complexité totale du pipeline reste élevée malgré la réduction nette de
   l’orchestrateur ; tout nouveau découpage exige une mesure préalable.
2. Les payloads ACWI/IEMG restent proches de 670 Ko et la sélection de quatre
   ETF atteint environ 2,06 Mo ; la compatibilité v1 interdit une compaction
   silencieuse, donc une future réduction exigerait une nouvelle version d’API.
3. La base locale contient encore 995 mappings hérités sans provenance et
   7 références orphelines. L’audit strict doit rester rouge jusqu’à migration
   ou résolution explicite de ces lignes ; une couverture pondérale de 100 %
   ne suffit pas à les déclarer auditables.

La croissance ETF est désormais reconstruite par earnings yields pondérés ; les
tests couvrent P/E positifs, P/E non positifs et couverture partielle.

## Évolutions produit depuis le plan Metrics

Le lot du 2026-08-13 étend le produit sans modifier les invariants historiques
de source et de couverture :

- l’espace Holdings devient une analyse mono-ETF par défaut ; la comparaison
  reste optionnelle et les grandes tables passent par une expansion progressive ;
- un contre-factuel ACWI mesure la distorsion de pondération sur l’univers
  commun, avec score, couverture et titres absents explicitement séparés ;
- Portfolio accepte positions longues/courtes et cash ou emprunt multidevise,
  puis expose au choix l’exposition actions brute normalisée ou les poids NAV
  signés incluant cash et financement implicite des ETF à levier ;
- les ETF personnalisés conservent une recette manuellement surchargeable, mais
  recalculent les poids disponibles depuis le dernier snapshot de leur univers
  source ; les ETF personnalisés et Portfolio sont rechargeables, modifiables et
  supprimables via un cycle de vie transactionnel réservé aux objets locaux ;
- le catalogue ajoute CSEMAS comme univers MSCI Emerging Markets Asia natif,
  avec sa cotation SIX/USD, son snapshot autonome et un plancher de 500 lignes
  pour refuser un export officiel tronqué ;
- Metrics Overview ajoute P/E TTM, EV/EBITDA, P/FCF, marge opérationnelle, ROIC,
  croissances TTM et capitalisation médiane pondérée, avec provenance temporelle
  par métrique et axes robustes réversibles sur le graphique constituants ;
- la migration `0011` persiste les positions cash par portefeuille avec cascade
  limitée au portefeuille concerné.

## Validation au dernier audit

Succès observés :

```text
npm run typecheck
npm run lint
node scripts/test-migrations.mjs
node scripts/audit-tradingview-mappings.test.mjs
node scripts/audit-tradingview-mappings.mjs --strict --breakdown
node --test --experimental-test-isolation=none \
  scripts/audit-tradingview-mappings.test.mjs \
  scripts/start-standalone-assets.test.mjs
git diff --check
```

Le réaudit du 2026-08-14 exécute 148/148 tests TypeScript par la commande
standard. Les 3 tests de contrat d’audit, le migration smoke et les 2 tests
d’assets standalone passent dans le même enchaînement. `npm run build` compile
l’application optimisée, termine le contrôle TypeScript et génère les 12 routes
Next.

L’audit de données `db:audit-mappings -- --strict`, réexécuté après sauvegarde
et `db:setup`, reste volontairement rouge sur la base locale : 995 mappings
hérités sont résolus sans provenance et 7 références sont orphelines. Les
identités Screener/Estimates ne présentent aucun mismatch. La couverture
pondérale arrondie reste de 100 % sur les univers précédemment audités, tandis
que CSEMAS expose explicitement 544/548 mappings et 95,26 % du poids. Ce passif
de données est documenté comme risque ouvert ; il n’est pas masqué par la suite
de fixtures.

Le smoke HTTP couvre Catalog, Holdings, Compare, Portfolio, recherche et
Metrics : toutes les réponses nominales valent `200`, et la requête Metrics
conditionnelle vaut `304`. Les sélections ou payloads invalides de Compare,
Holdings, Metrics, prix, Portfolio et ETF Creator conservent leurs contrats
`400`/`404`.

Le smoke de production du 2026-08-14 confirme aussi `/api/health`, la présence
de CSEMAS dans `/api/v1/catalog` et 559 holdings datés du 2026-08-13 sur
`/api/v1/holdings/CSEMAS`.

Le contrôle navigateur de la webapp confirme Compare (IVV/ACWI), ETF Creator,
Portfolio et l’ensemble du panel Metrics, notamment les trajectoires P/E, la
comparaison ETF et le bubble chart.

Le blocage environnemental observé pendant l’audit a été levé lors de la
validation finale :

```text
npm test       -> succès
npm run build  -> succès, TypeScript et génération des 12 pages inclus
```
