#!/usr/bin/env bash
# Install a LOCAL open-weight model for Complay Ai (Starts-Agents).
#
#   sudo bash scripts/setup-local-model.sh [model]
#
# Default model: qwen2.5-coder:1.5b — chosen for small-memory servers:
# ~1.1 GB on disk, ~1.2 GB RAM while answering, and the harness asks
# Ollama to unload it after 5 idle minutes, so the RAM comes back.
# More RAM to spare? Pass a bigger one, e.g.:
#   sudo bash scripts/setup-local-model.sh qwen2.5-coder:3b    (~2.2 GB RAM)
#   sudo bash scripts/setup-local-model.sh qwen2.5-coder:7b    (~4.7 GB RAM)
#
# Ollama listens on 127.0.0.1 only. The harness auto-detects it on
# boot and registers a "本地模型 · Ollama" provider — no API key,
# no cloud, nothing leaves this machine.
set -euo pipefail
MODEL="${1:-qwen2.5-coder:1.5b}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "Installing Ollama…"
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Keep the footprint polite on a shared server: one request at a time,
# unload the model after 5 idle minutes.
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/complay-ai.conf <<'EOF'
[Service]
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_KEEP_ALIVE=5m"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
EOF
systemctl daemon-reload
systemctl enable --now ollama
systemctl restart ollama

echo "Pulling model: $MODEL (one-time download)…"
ollama pull "$MODEL"

echo
echo "Local model ready: $MODEL"
echo "Now restart the app so it auto-detects Ollama:"
echo "  pm2 restart starts-agents"
echo "Then open Complay Ai — the Coder bot will use the local model."
