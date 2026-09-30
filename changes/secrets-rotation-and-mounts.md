---
audience: operators
kind: breaking
---

Production refuses a `SETTINGS_ENCRYPTION_KEY` shorter than 16 characters. The key can now be rotated without re-entering secrets, and credentials can be mounted one file each.

If your key is shorter than that, move it to `SETTINGS_ENCRYPTION_KEY_PREVIOUS`, generate a new one with `openssl rand -base64 32` into `SETTINGS_ENCRYPTION_KEY`, and start the app. A key from `install.sh` or from that command is long enough already and needs nothing.

`SETTINGS_ENCRYPTION_KEY_PREVIOUS` is the rotation path in general. On the next boot everything still encrypted with the old key is re-encrypted with the new one, after which the variable can be removed.

`SECRETS_DIR` reads credentials from a directory holding one file per variable, which is what docker and podman secrets, a kubernetes secret volume and systemd's credentials directory mount. A file there wins over the same variable in `SECRETS_FILE`.

`restore.sh --inspect` now also reports whether a backup's connection secrets decrypt with the key configured here, since a backup restored under a different key comes up with its servers disabled.
