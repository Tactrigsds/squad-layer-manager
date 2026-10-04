---
audience: operators
kind: breaking
---

Two changes can need a step when upgrading:

- **A server agent** is refused while its server still has the default token, `dev`. Set a token of your own in the
  server's connection settings, and give the agent the same one.
- **A local admin list file** must be inside the `data` directory. Move the file there, or set `LOCAL_ADMIN_LISTS_DIR`
  to the directory it is kept in.
