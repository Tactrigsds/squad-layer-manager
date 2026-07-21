# Git Hooks (Optional)

Enable with:

```bash
pnpm setup:hooks
```

Disable with:

```bash
pnpm remove:hooks
```

`pre-push` runs the full suite (format, typecheck, lint, unit, integration, e2e) on every branch. Branch
deletions are skipped. See [CONTRIBUTING.md](../CONTRIBUTING.md#the-pre-push-hook) for the details.

**Bypass:** `git push --no-verify`
