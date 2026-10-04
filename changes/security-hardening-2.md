---
audience: operators
kind: fixed
---

Several security fixes:

- SLM refuses to be shown inside a frame on another site, which could trick a signed-in admin into clicking its
  controls.
- A queue editor can no longer send the queue operations SLM reserves for itself, which skipped the edit window and the
  pool and installed-mods checks.
- The plugin list hides the query of an install url, where a token can be kept, and shows a plugin's error only to
  users who can manage plugins.
- An open plugin stream stops for a user who loses the permission the plugin requires.
- SLM refuses to install a plugin whose id is too alike to an installed plugin's for their database tables to be kept
  apart, such as `hello` beside `hello-x`.
- A server join link must open Steam.
