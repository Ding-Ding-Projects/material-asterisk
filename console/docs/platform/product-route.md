# Product route

The supported route is `ding-pbx://destination/<id>`. See [Destination deep links](destination-deep-links.md) for the current bridge, validation rules and verification limits.

The running application uses `shared/destination-route.ts`, the main-process router in `app/electron/deep-link.ts`, and the `onDestination` preload bridge. It validates the capture tuple but applies only the destination. It does not resize the window, change theme or apply a capture state. The latest valid startup route is held until the renderer is ready; unknown destination ids are reported by the renderer.

An earlier route proposal remains in `shared/deep-link.ts` with its parser unit tests. Its stricter dark-only tuple, window-resize behavior and pending/onNavigate bridge are not the shipped integration. The renderer integration tests exercise the current router and bridge, including startup buffering, live navigation, refusal, cleanup and the destination-only contract. `scripts/negative-deep-link.mjs` retains the earlier parser's unit mutations and checks current production wiring separately.

Malformed percent encoding is refused instead of throwing during protocol activation. Local parser/router/renderer checks do not establish native operating-system protocol registration or packaged Windows behavior.
