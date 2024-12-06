#!/bin/sh

docker  run \
  --add-host=host.docker.internal:host-gateway \
  --rm \
  -v "$(pwd)/config.json:/app/config.json" \
  -v "$(pwd)/logs:/logs" \
  --env-file .env \
  -p 3000:3000 \
  -e HOST="0.0.0.0" \
  -e DB_HOST="host.docker.internal" \
  --name=squad-layer-manager \
  squad-layer-manager
