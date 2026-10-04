---
audience: operators
kind: changed
---

SLM's web interface sends every action over one connection to the server. SLM now refuses that connection when a page
on another site opens it, since that page could otherwise act as whoever was signed in. The session cookie is now
`SameSite=Lax`, and `Secure` when `ORIGIN` starts with `https://`.

A deployment behind a reverse proxy needs `ORIGIN` set to the url that browsers open, or the proxy must pass the `Host`
header through unchanged. Otherwise the web interface cannot connect.
