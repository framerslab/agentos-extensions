# @framers/agentos-ext-channel-youtube

## 0.1.1

### Patch Changes

- [#59](https://github.com/framerslab/agentos-extensions/pull/59) [`eeb7c62`](https://github.com/framerslab/agentos-extensions/commit/eeb7c62cac5672ab2230bc461f3d74af57e2194f) Thanks [@jddunn](https://github.com/jddunn)! - Gmail builds its OAuth client with googleapis' `google.auth.OAuth2` instead of importing `OAuth2Client` from google-auth-library, which the package does not depend on; where another pack's google-auth-library was installed, that import could resolve to a different major than the one googleapis uses. Gmail, YouTube and Google Calendar pass the client options as an object, the form google-auth-library 10 keeps (it deprecates the positional arguments).
