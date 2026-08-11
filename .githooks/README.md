# Git Hooks (Optional)

Enable with:

```bash
pnpm setup:hooks
```

Disable with:

```bash
pnpm remove:hooks
```

`pre-push` runs everything but integration/e2e tests (format, typecheck, lint, unit) on every branch. Branch
deletions are skipped. See [CONTRIBUTING.md](../CONTRIBUTING.md#the-pre-push-hook) for the details.

**Bypass:** `git push --no-verify`
