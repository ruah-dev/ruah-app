## What and why

<!-- What does this change, and why? Link the issue it closes (Closes #123). -->

## How it was tested

<!-- The gates below, plus what you checked by hand: a live run with `--mock`
     or a real agent, the pages you looked at, screenshots for UI changes
     (fixture repos only, never a real account). -->

- [ ] `pnpm typecheck && pnpm build && pnpm test`
- [ ] `cd ui && npx tsc --noEmit && bun run build`
- [ ] Live check: <!-- what you ran and saw -->

## Checklist

- [ ] New or changed API, message or file format: a numbered section appended to `docs/CONTRACTS.md`
- [ ] User-visible change: `README.md` and the "Unreleased" part of `CHANGELOG.md` updated
- [ ] Feature is optional in the app and quiet when its tool is missing; the CLI works without the daemon
- [ ] Viewer: semantic colour tokens only (no raw hex in components)
- [ ] No secrets, real account data, client names or home paths in code, fixtures, logs or screenshots
- [ ] Adapted third-party code: header comment + `THIRD_PARTY_NOTICES.md` row
