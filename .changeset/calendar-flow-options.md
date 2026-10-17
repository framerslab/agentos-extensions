---
'@framers/agentos-ext-calendar-google': patch
---

`GoogleCalendarOAuthFlow` refuses options that are not an object with `GoogleOAuthFault` `configuration` before it reads the scope, as the Drive pack's flow refuses its own: a null options object threw a `TypeError`, and a fetch or a scope given in place of the options was dropped, the flow asking the default scope through the global fetch. The README names the pack's second peer, `@framers/agentos-ext-account-sources` 0.7.0 or later, which `./reader` loads through the Drive pack's flow.
