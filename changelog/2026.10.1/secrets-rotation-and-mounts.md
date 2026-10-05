---
audience: operators
kind: breaking
---

The BattleMetrics, Squad Browser and Steam credentials move from the environment to the settings page. The encryption key can be rotated, must be at least 16 characters in production, and credentials can be mounted one file each.

**Integrations on the settings page.** `BM_PAT`, `BM_ORG_ID`, `BM_ENABLED`, `SQUADBROWSER_API_KEY`, `SQUADBROWSER_ENABLED`, `STEAM_API_KEY` and `STEAM_ENABLED` are now the _Integrations_ section of the global settings. The first boot after upgrading carries the values over from the environment into the settings, after which the variables are ignored and the boot log says so each time one is still set. Remove them from `.env` and `.env.secrets` once that boot has happened. A token is stored encrypted and never shown again: the field shows a placeholder, and typing in it replaces the token. Editing the section takes a `global-settings:write` grant on `integrations`, which the default managers role does not hold. `BM_HOST`, `SQUADBROWSER_HOST` and `STEAM_HOST` stay in the environment.

**Encryption key length.** Production refuses a `SETTINGS_ENCRYPTION_KEY` shorter than 16 characters. If yours is, move it to `SETTINGS_ENCRYPTION_KEY_PREVIOUS`, generate a new one with `openssl rand -base64 32` into `SETTINGS_ENCRYPTION_KEY`, and start the app. A key from `install.sh` or from that command is long enough already and needs nothing.

**Key rotation.** `SETTINGS_ENCRYPTION_KEY_PREVIOUS` is the rotation path in general. On the next boot everything still encrypted with the old key is re-encrypted with the new one, after which the variable can be removed.

**One file per credential.** `SECRETS_DIR` reads credentials from a directory holding one file per variable, which is what docker and podman secrets, a kubernetes secret volume and systemd's credentials directory mount. A file there wins over the same variable in `SECRETS_FILE`.

**Restore.** `restore.sh --inspect` now also reports whether a backup's secrets decrypt with the key configured here, since a backup restored under a different key comes up with its servers disabled and its integration tokens unset.
