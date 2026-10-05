---
audience: operators
kind: changed
---

Plugins can only be installed and refreshed over `https://`. SLM also refuses to install a plugin whose id is already
installed from another url, and uninstalling a plugin now leaves it stopped if it is installed again.

A plugin installed from an `http://` url can no longer be refreshed. Uninstall it and install it again from its
`https://` url.
