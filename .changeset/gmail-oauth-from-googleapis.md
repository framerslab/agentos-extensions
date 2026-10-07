---
"@framers/agentos-ext-email-gmail": patch
"@framers/agentos-ext-channel-youtube": patch
"@framers/agentos-ext-calendar-google": patch
---

Gmail builds its OAuth client with googleapis' `google.auth.OAuth2` instead of importing `OAuth2Client` from google-auth-library, which the package does not depend on; where another pack's google-auth-library was installed, that import could resolve to a different major than the one googleapis uses. Gmail, YouTube and Google Calendar pass the client options as an object, the form google-auth-library 10 keeps (it deprecates the positional arguments).
