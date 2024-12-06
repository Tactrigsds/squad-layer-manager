#!/bin/sh

LOG_PATH=/logs/app.jsonl pnpm tsx --tsconfig tsconfig.node.json src/scripts/host.ts & wait
