---
audience: operators
kind: added
minor: true
---

Plugin API 0.8.2: a packed plugin ships a stylesheet, so its Tailwind classes work once installed, and
`slm/components/ui` lends it SLM's alerts, badges, buttons, cards and tooltips.

`pnpm plugin:pack` compiles the classes a plugin's client uses into `client.css`, against SLM's own theme, and SLM
loads it with the client. A plain `client.css` beside `client.tsx` is compiled into the same file.
