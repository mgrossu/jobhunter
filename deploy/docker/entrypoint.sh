#!/bin/sh
# Writes pi's models.json from the active profile in config/jobhunter.json plus JH_LLM_BASE_URL,
# so the model name and context size live in one place and only the server address comes from env.
set -e
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$AGENT"
if [ -n "$JH_LLM_BASE_URL" ]; then
  node /app/deploy/docker/write-models-json.mjs "$AGENT/models.json"
fi
exec "$@"
