# Glossary

Feature-level terms from interview decision records.
The canonical domain glossary is `CONTEXT.md`; terms move there once the feature ships.

- **URL mode**: an intervu Session whose target is a running dev-server origin instead of an HTML artifact on disk.
- **In-page overlay**: intervu's chrome and SDK running inside the app's own document, in a shadow root, instead of around an iframe.
- **Dormant badge**: the in-page overlay's resting state when no Session is open for the origin.
- **Relay**: the Vite plugin's `/__intervu/*` dev-server middleware that forwards same-origin page traffic, SSE included, to the loopback daemon.
- **Source location**: the `file:line:col` of the JSX that rendered an annotated element, read from `data-intervu-src`.
