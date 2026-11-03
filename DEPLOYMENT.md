# LUBRAUTO — relais Auto Ways Network

API serveur pour identifier un véhicule français. La clé est fournie uniquement par la variable secrète `AWN_TOKEN` de Render. Aucune clé dans GitHub ou Shopify.

## Render

Node 24, région Frankfurt, build `npm ci && npm test`, démarrage `npm start`.

Variables :

- `AWN_TOKEN` : secret Auto Ways.
- `DATABASE_URL` : URL interne PostgreSQL, même espace et région.
- `ALLOWED_ORIGINS` : origines Shopify exactes séparées par des virgules, sans barre finale.
- `ENABLED` : `true` seulement après configuration et vérification.
- `MAX_PER_MINUTE=3`, `MAX_PER_DAY=10`, `MAX_PER_MONTH=20` : limites globales initiales.

Les compteurs sont réservés atomiquement en PostgreSQL avant chaque appel fournisseur. Les échecs fournisseur consomment une réservation. Une indisponibilité de la base bloque les recherches. Ne pas supprimer/réinitialiser la table de quotas pendant une période en cours : conserver les compteurs lors d'une migration. Les limites ne sont pas des droits d'accès : l'origine peut être imitée par un client HTTP. Les limites globales bornent les appels, mais un tiers peut épuiser le quota. Aucun VIN, plaque ou résultat automobile n'est enregistré. Pas de journal de requête dans le code applicatif.

`GET /health` indique la présence de la configuration (ne teste pas Auto Ways). `POST /vehicle`, JSON `{"plate":"..."}`, nécessite une origine autorisée. `OPTIONS /vehicle` gère CORS. La réponse sélectionne uniquement les informations techniques utiles et conserve `compatibilityVerified: false` : identifier le véhicule ne prouve pas la compatibilité d'une pièce.

## Limites de l'offre gratuite Render

Le service se met en veille après 15 minutes d'inactivité. Le réveil peut prendre environ une minute. La base PostgreSQL gratuite expire 30 jours après création. Cette configuration sert aux essais et ne constitue pas un hébergement de production durable. Avant commercialisation, faire valider le budget d'un hébergement durable et tester la recherche réelle ainsi que les erreurs depuis Shopify.

## Vérification

`npm ci && npm test`. Les tests automatisés n'appellent pas le fournisseur et ne consomment aucun crédit Auto Ways. La section Shopify doit être configurée avec l'URL HTTPS `/vehicle` du relais effectivement déployé.
