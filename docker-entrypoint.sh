#!/bin/sh
# SLM runs as the unprivileged node user. The container starts as root only to hand that user the data mount, since an
# install that ran an older image as root has its database, backups and plugins owned by root.
set -e

if [ "$(id -u)" = "0" ]; then
	find /app/data ! -user node -exec chown node:node {} +
	exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
