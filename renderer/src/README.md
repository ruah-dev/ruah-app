# archmap renderer

Standalone viewer for the archmap daemon (PLAN.md WP-C). React 19 + Vite,
talks the WS/HTTP contract in ../../CONTRACTS.md.

```sh
npm run dev       # http://127.0.0.1:5173  (?daemon=ws://127.0.0.1:4177/ws to point elsewhere)
npm run build     # static SPA in dist/
npm run typecheck && npm run lint
```

Connection order: `?daemon=` query param, then `window.archmap.connection()`
(Electron preload), then `openRepository()`, then `openDemo()`, then the mock
demo. The mock demo button is always labelled as a demo.
