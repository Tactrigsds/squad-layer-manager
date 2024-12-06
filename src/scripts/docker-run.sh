#!/bin/sh
PORT=3000
HOST=0.0.0.0

docker run \
  # if you want to access the database from localhost, include the following two options:
  --add-host=host.docker.internal:host-gateway \
  -e DB_HOST="host.docker.internal" \
  --rm \
  -v "$(pwd)/config.json:/app/config.json" \
  -v "$(pwd)/logs:/logs" \
  --env-file .env \
  # PORT is hardcoded in image to 3000, but you can bind it to any port you want on the host
  -p 3000:3000 \
  --name=squad-layer-manager \
  squad-layer-manager
