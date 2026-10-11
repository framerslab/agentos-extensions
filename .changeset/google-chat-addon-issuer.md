---
"@framers/agentos-ext-channel-google-chat": patch
---

App-URL verification accepts the Workspace add-on of the Google Cloud project named by the new `addOnProjectNumber` option (or `GOOGLE_CHAT_ADDON_PROJECT_NUMBER`), and no other add-on. The add-on check was a pattern written with doubled backslashes that matched no address, so every add-on request was rejected; accepting every project's add-on would let an unrelated add-on pass, since any add-on can obtain a token for this URL.
