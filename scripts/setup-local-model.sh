#!/usr/bin/env bash
# Starts-Agents local-model setup (item 150): installs Ollama,
# makes sure the service answers, and pulls the default chat model.
# Idempotent — safe to re-run; every step checks before it acts.
# Review before piping anything into a root shell; re-check the
# upstream installer if that matters. This script does NOT set any
# context-length override: Ollama's own defaults apply.
set -euo pipefail

MODEL="${SA_LOCAL_MODEL:-qwen2.5-coder:1.5b}"
OLLAMA_URL="http://127.0.0.1:11434"

ollama_up() { curl -fsS "$OLLAMA_URL/api/tags" >/dev/null 2>&1; }

# 1. Install Ollama if the command is missing.
if command -v ollama >/dev/null 2>&1; then
  echo "Ollama already installed ($(ollama --version 2>/dev/null || echo 'version unknown'))."
else
  echo "Ollama not found — installing via the official installer…"
  curl -fsSL https://ollama.com/install.sh | sh
fi

# 2. Make sure the service answers on 127.0.0.1:11434.
if ollama_up; then
  echo "Ollama service already reachable at $OLLAMA_URL."
else
  if command -v systemctl >/dev/null 2>&1; then
    echo "Starting the Ollama service via systemd…"
    systemctl enable --now ollama 2>/dev/null || sudo systemctl enable --now ollama || true
  fi
  for _ in $(seq 1 15); do
    if ollama_up; then break; fi
    sleep 1
  done
  if ! ollama_up; then
    echo "Ollama is installed but the service is not answering yet."
    echo "Start it with one of:"
    echo "  sudo systemctl start ollama"
    echo "  ollama serve            # foreground, for a quick manual try"
    echo "then re-run this script."
    exit 1
  fi
  echo "Ollama service is up at $OLLAMA_URL."
fi

# 3. Pull the default model (resumes by itself if interrupted).
echo "Pulling $MODEL (an interrupted pull resumes where it stopped)…"
ollama pull "$MODEL"

# 4. Report: keep-alive behaviour + how to verify.
cat <<EOF

Done. $MODEL is ready for Starts-Agents.

Verify:
  curl $OLLAMA_URL/api/tags
  ollama list
  curl $OLLAMA_URL/v1/models

Keep-alive: Ollama unloads a model after 5 idle minutes by default,
which returns its RAM to the box. To change that window, set
OLLAMA_KEEP_ALIVE in the service environment, e.g. 30m, or -1 to
keep models loaded:
  sudo systemctl edit ollama   # add: [Service] Environment="OLLAMA_KEEP_ALIVE=30m"
  sudo systemctl restart ollama
EOF
