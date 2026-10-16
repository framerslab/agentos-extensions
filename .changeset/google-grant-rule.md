---
'@framers/agentos-ext-google-drive': minor
'@framers/agentos-ext-calendar-google': minor
---

`GoogleOAuthFlow` takes its grant's rule as an option (`grant`: the provider id, the scopes asked, `holds` or `exact` matching, the address's extra parameters), Drive's rule (`DRIVE_GRANT`) the default and its behaviour unchanged; `grantMatches` reads OpenID's short scope names as Google's long ones. The calendar pack's `./reader` exports `GoogleCalendarOAuthFlow`: one read-only calendar scope with `openid` and `email`, held exactly at the exchange and at every refresh, and the address the ID token of the token endpoint's answer names.
