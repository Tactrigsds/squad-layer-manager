# Git Hooks

`pnpm dev` installs these hooks when it provisions a workspace. To install or uninstall them by hand:

```bash
pnpm setup:hooks
pnpm remove:hooks
```

`pnpm remove:hooks` also stops `pnpm dev` from installing them again.

`pre-push` runs everything but integration/e2e tests (format, typecheck, lint, changelog, unit) on every branch. Branch
deletions are skipped. See [CONTRIBUTING.md](../CONTRIBUTING.md#the-pre-push-hook) for the details.

**Bypass:** `git push --no-verify`
