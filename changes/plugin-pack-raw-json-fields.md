---
audience: operators
kind: added
minor: true
---

`pnpm plugin:pack` warns about each plugin config field that the settings page would show as a raw JSON editor.

A plugin config field typed `string | number`, nullable or not, now renders as a text input. A filter named in a
nullable object, a union branch or a record entry of a plugin's config now counts as a reference to that filter.
