# Plan final dirigé — stabilisation et simplification

> **Statut : plan historique terminé.** Les phases ci-dessous décrivent la
> consolidation Metrics Overview achevée avant les évolutions produit du
> 2026-08-13. Ce fichier n’est plus une file de travaux active. Le comportement
> courant est décrit dans l’[architecture](metrics-overview-architecture.md) et
> les évolutions postérieures dans le [bilan d’ingénierie](engineering-review.md).

**Statut :** terminé — P0 à P6 validés et livrés en commits logiques
**Dernière révision :** 2026-08-03
**Périmètre principal :** Metrics Overview, son contrat API et les chemins
TradingView/SQLite directement associés.

Ce document remplace le runbook append-only. Il sert à terminer la branche,
pas à ouvrir une nouvelle boucle d’optimisation indéfinie. Un agent traite une
phase à la fois, met à jour le tableau d’avancement en place et s’arrête dès que
le critère de sortie est atteint.

Références :

- [architecture courante](metrics-overview-architecture.md) ;
- [bilan consolidé des décisions](engineering-review.md).

## 1. Résultat attendu

La branche finale doit être :

1. révisable en changements logiques séparés ;
2. compatible avec un contrat API explicitement choisi et testé ;
3. plus simple que l’état actuel, sans nouveau cache, statut ou micro-module ;
4. mathématiquement cohérente pour la croissance agrégée des earnings ;
5. entièrement validée dans un environnement autorisant les processus enfants.

Le travail est terminé uniquement lorsque les phases P0 à P6 sont clôturées.
Une amélioration simplement plausible ne suffit pas.

## 2. État de départ vérifié

| Élément | État courant |
| --- | --- |
| Worktree | `codex/optimize`, 49 fichiers suivis modifiés et 41 nouveaux au dernier audit |
| Pipeline Metrics | environ 1 417 lignes non vides dans quatre modules, dont environ 454 dans l’orchestrateur |
| Mappings | 3 571 résolus, 0 unresolved, 0 mismatch Screener/Estimates, provenance complète |
| Cache négatif persistant | utile : IEMG après redémarrage mesuré à environ 309 ms et 0 symbole provider demandé |
| DTO compact | variante rejetée : incompatible avec les champs v1 publiés |
| Validation locale | typecheck, lint, migrations, audit mapping strict et diff check passent |
| Validation incomplète | `npm test` et la fin de `npm run build` bloqués par `spawn EPERM` dans la sandbox |

Ces chiffres sont une baseline, pas une promesse de performance permanente.
Toute nouvelle mesure utilise la même base, le même build et le même scénario
avant/après.

## 3. Défauts de la boucle précédente à ne pas répéter

| Défaut observé | Règle corrective obligatoire |
| --- | --- |
| 93 entrées d’itération et plusieurs micro-sondes sans priorité produit | Une phase active, une hypothèse, au maximum une variante mesurée. Toute autre idée va dans le parking lot. |
| Plus de 5 000 lignes de documentation dupliquée | Aucun journal append-only. Mettre à jour le tableau et un résultat de dix lignes maximum. |
| Objectif de simplification partiellement manqué | Une refactorisation doit supprimer du code ou des branches ; aucun nouveau fichier de production pour seulement déplacer la logique. |
| Glissement vers Portfolio, Compare, ETF Creator et autres routes | Ne modifier que les chemins autorisés par la phase. Une anomalie hors périmètre est notée, pas corrigée dans le même lot. |
| Contrat JSON `/api/v1` modifié pendant une optimisation de payload | Décider et tester le contrat avant toute nouvelle modification du DTO. |
| Lots marqués terminés malgré une branche non structurée | Une phase de livraison n’est jamais `completed` tant que son diff logique et sa validation ne sont pas isolables. |
| Validation partielle décrite comme quasi finale | Un `spawn EPERM` signifie `blocked` pour la validation complète. Aucun faux vert et aucune configuration de build permanente pour contourner la sandbox. |
| Compteurs Estimates ambigus | Chaque compteur doit avoir une sémantique testable, y compris pour une réponse réussie mais vide. |

## 4. Invariants non négociables

### Données et calculs

- La série EPS reste composée de quatre estimations historiques et quatre
  estimations futures. Aucun EPS publié ou reconstruit n’est réintroduit.
- P/E, P/B et P/S restent des agrégats harmoniques pondérés sur les valeurs
  positives et la couverture réellement disponible.
- Une donnée manquante reste visible dans la couverture. Aucune renormalisation
  silencieuse ne peut être présentée comme une couverture complète.
- Les composants finis restent visibles dans le bubble chart, sous réserve de
  la limite top-500 explicitement affichée.

### Provider et persistance

- Seule une absence confirmée par une réponse TradingView réussie entre dans le
  cache négatif.
- Timeout, fermeture prématurée et erreur de lot restent retentables.
- La table `provider_negative_cache`, ses TTL et son pruning sont conservés :
  leur bénéfice inter-processus est démontré.
- Une observation n’est compatible que si son symbole provider correspond au
  mapping courant et à une provenance auditable.
- `.data/`, les sauvegardes SQLite et les migrations versionnées ne sont jamais
  supprimées comme artefacts de build.

### Complexité et périmètre

- Aucun nouveau cache, statut, index, endpoint, table ou module sans problème
  mesuré, seuil de succès et plan de retrait approuvés.
- Le SQL direct reste limité aux deux lectures chaudes déjà mesurées. Il ne
  devient pas le style par défaut du repository.
- Une modification analytique et une refactorisation technique sont deux lots
  distincts.
- Un agent ne modifie pas un fichier hors de la liste de sa phase.

## 5. Tableau d’avancement

Ce tableau est modifié en place. Ne pas ajouter de journal chronologique sous
le document.

| Phase | Statut | Responsable | Résultat court |
| --- | --- | --- | --- |
| D0 — documentation | `completed` | Codex | Trois documents canoniques ; runbook redondant retiré ; liens réalignés. |
| D1 — artefacts générés | `completed` | Codex | Cache temporaire retiré ; `.next` reste un build local ignoré, absent des commits. |
| P0 — gel du périmètre et baseline | `completed` | Codex | Contrat v1 identifié dans le commit de base ; baseline statique et audit mondial reproduits. |
| P1 — contrat API et livrabilité | `completed` | Codex | Contrat HTTP v1 complet testé ; l’ETag couvre exactement le JSON sérialisé. |
| P2 — diagnostics Estimates | `completed` | Codex | Lots terminés, non vides et échoués séparés ; `missingSymbols` et `failedSymbols` sont disjoints. |
| P3 — agrégation de croissance earnings | `completed` | Codex | Formule earnings-yield, cas extrêmes/nuls et baseline IVV/ACWI/CHIP/IEMG vérifiés. |
| P4 — réduction de complexité | `completed` | Codex | Orchestrateur 454 → 407 lignes non vides ; fusion des états provider sans nouveau module. |
| P5 — séparation des changements hors périmètre | `completed` | Codex | Changements isolés en commits SQLite/runtime, produit, Metrics et documentation. |
| P6 — validation finale et transmission | `completed` | Codex | Suite/build verts ; standalone 5 sélections, redémarrage sans appel provider et UI/console vérifiés. |

États autorisés : `pending`, `in_progress`, `completed`, `rejected`, `blocked`.
Il ne peut y avoir qu’une seule phase `in_progress`.

## 6. Procédure commune à chaque phase

Avant toute modification :

1. lire ce document et la section concernée de l’architecture ;
2. exécuter `git status --short` et noter les fichiers déjà modifiés ;
3. écrire une hypothèse falsifiable, une mesure et un seuil de succès ;
4. vérifier que chaque fichier prévu appartient à la phase ;
5. mesurer la baseline sur le build et la base qui seront réutilisés après.

Après la modification :

1. exécuter les tests ciblés ;
2. comparer comportement, couverture, payload et timings pertinents ;
3. retirer immédiatement la variante si le seuil n’est pas atteint ;
4. mettre à jour une seule ligne du tableau d’avancement ;
5. ajouter au plus dix lignes dans la section « Résultats finaux » ;
6. s’arrêter au lieu de chercher spontanément une nouvelle optimisation.

## 7. Phases dirigées

### P0 — Geler le périmètre et reproduire la baseline

**Fichiers autorisés :** aucun fichier de production.

**Actions :**

1. inventorier le diff par domaine : Metrics, providers, holdings, Portfolio,
   API transversale, runtime standalone, migrations et documentation ;
2. vérifier le chemin SQLite et créer `npm run db:backup` avant toute migration
   supplémentaire ;
3. enregistrer les réponses API IEMG, ACWI, CHIP, IVV et quatre ETF combinés ;
4. conserver statut, warnings, ETag, taille, couverture, compteurs provider et
   timings par phase ;
5. produire une liste exacte des consommateurs du type
   `MetricsOverviewResult` et de `/api/v1/metrics/overview`.

**Sortie obligatoire :** baseline reproductible et liste de consommateurs.
Sans cette preuve, P1 reste `blocked`.

### P1 — Verrouiller le contrat API et rendre le diff livrable

**Fichiers autorisés :**

- `src/domain/metrics.ts` ;
- `src/app/api/v1/metrics/overview/route.ts` ;
- tests du contrat Metrics Overview ;
- composant Metrics Overview uniquement si le contrat retenu l’exige.

**Décision préalable :** le responsable confirme si `/api/v1` a des
consommateurs externes. Sans confirmation, appliquer la règle conservatrice :
préserver la compatibilité de la représentation déjà publiée. Une rupture
volontaire exige une route/version distincte ; elle ne doit pas être cachée
derrière une optimisation de payload.

**Actions :**

1. créer un test de sérialisation couvrant noms de champs, compteurs, statuts,
   warnings et structure des huit estimations ;
2. décider explicitement du sort des champs retirés (`securityId`,
   `providerSymbol`, sommes EPS et anciens compteurs) ;
3. conserver la projection compacte seulement si elle respecte la décision de
   compatibilité ;
4. vérifier que l’ETag change avec toute représentation différente ;
5. documenter le contrat retenu dans l’architecture.

**Critère de sortie :** contrat testé et décision de version explicite. Une
simple absence de consommateur dans le dépôt ne prouve pas l’absence de client
externe.

### P2 — Corriger la sémantique des diagnostics Estimates

> Phase historique terminée. Les compteurs provider ont permis la validation,
> puis `metrics-overview-diagnostics.ts` a été retiré du runtime lors du réaudit
> de simplification ; les statuts et warnings fonctionnels restent couverts.

**Fichiers autorisés :**

- `src/data/providers/tradingview-estimates.ts` et son test ;
- `src/data/services/metrics-overview-estimates.ts` ;
- `src/domain/metrics-overview-diagnostics.ts` et son test ;
- l’orchestrateur uniquement pour renommer les champs de log.

**Problème précis :** une réponse réussie contenant zéro série pouvait produire
`successfulBatchCount = 0` et `failedBatchCount = 0`, sans distinguer le
transport terminé du contenu utile.

**Contrat recommandé :**

- `completedBatchCount` : transport terminé correctement, même sans série ;
- `nonEmptyBatchCount` : au moins une série valide reçue ;
- `failedBatchCount` : transport ou protocole en échec ;
- invariant : `completedBatchCount + failedBatchCount = batchCount`.

**Tests obligatoires :** réponse complète, réponse réussie vide, mélange
vide/non vide, lot en échec et tous les lots en échec.

**Critère de sortie :** diagnostics non ambigus sans changement du statut,
des warnings, du cache négatif ou du DTO public.

### P3 — Remplacer la moyenne des croissances par un agrégat earnings

Cette phase est analytique et possède son propre lot. Ne modifier aucun cache
ou provider simultanément.

**Fichiers autorisés :**

- `src/domain/processors/aggregate-etf-metrics.ts` et tests ;
- `src/domain/metrics.ts` ;
- affichage/architecture pour le libellé et la formule.

**Formule cible :** sur l’intersection des composants ayant des P/E historique
et forward positifs :

```text
historical earnings yield = Σ(poids / PE_historique)
forward earnings yield    = Σ(poids / PE_forward)
croissance agrégée        = forward yield / historical yield - 1
```

Cette reconstruction est cohérente avec le P/E harmonique de l’ETF. Elle
remplace la moyenne arithmétique des taux individuels. La garde arbitraire
`-100 %/+300 %` doit disparaître de l’agrégat ; toute exclusion restante doit
être justifiée comptablement et réduire explicitement la couverture.

**Tests obligatoires :**

- deux composants de poids et P/E différents ;
- croissance individuelle extrême mais finie ;
- P/E nul/négatif ;
- couverture partielle ;
- égalité avec la formule manuelle ;
- absence de changement du bubble chart composant.

**Critère de sortie :** formule, description, valeur et couverture cohérentes.
Comparer les résultats actuels et nouveaux sur IEMG, ACWI, CHIP et IVV avant
de conserver le changement.

### P4 — Réduire la complexité sans nouveau découpage

**Fichiers autorisés :** les quatre modules `metrics-overview-*` et leurs tests.

**Actions prioritaires :**

1. centraliser dans l’orchestrateur la fusion répétitive des résultats provider
   (`live`, `partial`, `stale`, warnings) avec une fonction locale typée ;
2. supprimer les variables ou branches qui dupliquent les mêmes transitions ;
3. conserver Screener, Estimates et Model comme trois responsabilités stables ;
4. ne créer aucun cinquième module ;
5. ne toucher ni aux formules, ni au schéma SQLite, ni aux TTL ;
6. comparer les tests et le smoke multi-ETF avant/après.

**Seuil de conservation :** réduction nette d’au moins 10 % du code de
production touché ou suppression démontrée d’un état/embranchement dupliqué,
sans nouveau concept persistant. Si le diff ne simplifie que visuellement ou
déplace les lignes, le rejeter.

La cible de 250–350 lignes pour l’orchestrateur reste indicative. Il est
interdit de l’atteindre par des micro-fichiers mono-usage.

### P5 — Isoler les changements hors Metrics Overview

**Périmètre :** Portfolio, Compare, ETF Creator, prix, holdings et runtime
standalone déjà présents dans le diff.

**Actions :**

1. classer chaque changement comme correction nécessaire, durcissement utile
   ou dérive sans preuve ;
2. conserver les fallbacks iShares, le launcher standalone, les bornes de
   concurrence et la taxonomie d’erreurs lorsqu’ils ont un test ;
3. simplifier les empilements répétitifs de `try/catch` uniquement avec un diff
   net plus court et les mêmes statuts HTTP ;
4. examiner les helpers mono-usage, sans sacrifier la testabilité ;
5. préparer un lot de livraison distinct de Metrics Overview.

**Critère de sortie :** aucun changement hors Metrics Overview n’est caché dans
son lot logique. Ne pas corriger de nouvelle anomalie découverte pendant cette
classification.

### P6 — Validation finale et transmission

**Validation statique :**

```powershell
npm run typecheck
npm run lint
node scripts/test-migrations.mjs
node scripts/audit-tradingview-mappings.test.mjs
node scripts/audit-tradingview-mappings.mjs --strict --breakdown
git diff --check
```

**Validation complète dans un environnement autorisant les forks :**

```powershell
npm test
npm run build
```

**Validation runtime :**

- smoke standalone IEMG, ACWI, CHIP, IVV et sélection combinée ;
- premier appel, appel cache, redémarrage du processus et `304` conditionnel ;
- zéro requête provider après réhydratation d’absences encore fraîches ;
- mêmes mappings, couvertures, warnings et statuts hors correction attendue ;
- contrôle navigateur des deux graphiques et absence d’erreur console.

Un build qui compile puis échoue par `spawn EPERM` reste `blocked`. La phase ne
devient `completed` qu’après un vrai passage de `npm test` et du build final.

## 8. Découpage de livraison recommandé

Lorsque le responsable autorise commits ou staging, utiliser des lots séparés :

1. documentation et nettoyage d’artefacts ;
2. contrat API et diagnostics ;
3. agrégation earnings ;
4. réduction de complexité Metrics Overview ;
5. corrections transversales hors Metrics ;
6. validation finale et documentation alignée.

Chaque lot doit être révisable indépendamment. Aucun commit « optimisation
générale » regroupant les six intentions.

## 9. Pistes fermées sans nouveau signal

Ne pas relancer :

- requêtes SQLite latest-only par fenêtre ou sous-requête ;
- tailles de lots SQLite 500/750/900 ;
- tailles de lots Estimates 125/500 ;
- concurrence Screener 4 ;
- exécution parallèle Screener/Estimates ;
- statements SQLite réutilisés ;
- cache distribué ;
- nouveau cache applicatif ;
- réduction arbitraire du top-500 ;
- endpoint EPS par ticker ou dictionnaire de périodes sans profil navigateur.

Une piste fermée ne revient dans le plan qu’avec un changement de volume, une
régression observable ou une nouvelle preuve mesurée.

## 10. Résultats finaux

Cette section contient au maximum une entrée courte par phase. Remplacer ou
mettre à jour l’entrée de la phase ; ne pas recopier les commandes ni créer un
journal détaillé.

- **P0/P1/P2/P3/P4 — corrections finales :** contrat HTTP v1 et ETag complet
  verrouillés ; absences/échecs disjoints ; croissance earnings-yield testée sur
  les cas extrêmes et quatre ETF ; orchestrateur réduit de 454 à 407 lignes.
- **D0 — documentation :** documentation consolidée en trois fichiers
  canoniques ; ancien runbook append-only retiré ; liens README réalignés.
- **D1 — artefacts générés :** le cache TypeScript, le bundle de validation
  temporaire et `.next` ont été retirés après le build final. La base active
  corrigée, les migrations, `node_modules` et `next-env.d.ts` sont préservés.
- **P5 — séparation hors périmètre :** les lots SQLite/runtime, produit
  transversal, Metrics Overview et documentation sont matérialisés en commits
  distincts et révisables.
- **P6 — validation :** 130/130 tests TypeScript, audit mapping, migrations,
  assets standalone, typecheck, lint, diff check et build Next production
  passent. Le standalone répond `200→304` pour IVV, ACWI, CHIP, IEMG et leur
  sélection combinée ; après redémarrage, CHIP ne demande aucun symbole
  provider. Les trois graphes, la bascule IVV/ACWI et la console sont vérifiés.
