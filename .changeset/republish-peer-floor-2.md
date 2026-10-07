---
'@framers/agentos-ext-cloud-aws': patch
'@framers/agentos-ext-cloud-cloudflare-pages': patch
'@framers/agentos-ext-cloud-digitalocean': patch
'@framers/agentos-ext-cloud-flyio': patch
'@framers/agentos-ext-cloud-heroku': patch
'@framers/agentos-ext-cloud-linode': patch
'@framers/agentos-ext-cloud-netlify': patch
'@framers/agentos-ext-cloud-railway': patch
'@framers/agentos-ext-cloud-vercel': patch
'@framers/agentos-ext-notifications': patch
'@framers/agentos-ext-telegram-bot': minor
'@framers/agentos-ext-domain-cloudflare-registrar': patch
'@framers/agentos-ext-domain-godaddy': patch
'@framers/agentos-ext-domain-namecheap': patch
'@framers/agentos-ext-domain-porkbun': patch
'@framers/agentos-ext-clearbit': minor
'@framers/agentos-ext-github': patch
'@framers/agentos-ext-telegram': minor
'@framers/agentos-ext-giphy': minor
'@framers/agentos-ext-image-search': minor
'@framers/agentos-ext-letterboxd': minor
'@framers/agentos-ext-omdb': minor
'@framers/agentos-ext-voice-synthesis': minor
'@framers/agentos-ext-document-export': patch
'@framers/agentos-ext-widget-generator': minor
'@framers/agentos-ext-anchor-providers': minor
'@framers/agentos-ext-citation-verifier': patch
'@framers/agentos-ext-content-extraction': patch
'@framers/agentos-ext-deep-research': patch
'@framers/agentos-ext-hacker-news': minor
'@framers/agentos-ext-news-search': minor
'@framers/agentos-ext-stealth-browser': minor
'@framers/agentos-ext-trulia-search': patch
'@framers/agentos-ext-weather': minor
'@framers/agentos-ext-web-browser': minor
'@framers/agentos-ext-web-scraper': patch
'@framers/agentos-ext-web-search': minor
---

Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.
