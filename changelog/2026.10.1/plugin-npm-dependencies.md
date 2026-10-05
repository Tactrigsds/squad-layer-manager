---
audience: operators
kind: added
---

Plugins can depend on packages from npm. `pnpm plugin:pack` bundles them into the plugin.

A plugin repo declares its dependencies in its own `package.json` and installs them with `pnpm install`. The packages
SLM provides now include `react-dom`. `pnpm plugin:pack` refuses CommonJS packages, and warns when a dependency
expects a version of `react`, `zod` or another provided package that SLM does not ship. The plugin guide's
_Dependencies_ section describes the setup.
