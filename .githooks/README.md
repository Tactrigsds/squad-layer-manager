# Git Hooks (Optional)

Enable with:

```bash
pnpm setup:hooks
```

Disable with:

```bash
pnpm remove:hooks
```

Runs three checks on changed files when pushing to `main`:

- Type checking with `tsc -b`
- Format checking with `dprint check`
- Linting with `oxlint --type-aware`

**Bypass:** `git push --no-verify`
