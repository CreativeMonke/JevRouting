#!/usr/bin/env bash
# Run Cloudflare Clef-flash locally on Apple Silicon (MLX) as a System One server,
# then set JEV_LOCAL_URL=http://127.0.0.1:${PORT}/v1 so the router uses it first.
#
#   scripts/clef-serve.sh            # clef-flash-4bit (16 GB Macs)
#   CLEF_MODEL=mlx-community/clef-4bit scripts/clef-serve.sh   # 27B, 32 GB+ Macs
set -euo pipefail
export PORT="${PORT:-8765}"
MODEL="${CLEF_MODEL:-mlx-community/clef-flash-4bit}"
HOME_DIR="${JEV_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/jev-routing}"
VENV="$HOME_DIR/clef-venv"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "creating venv in $VENV" >&2
  mkdir -p "$HOME_DIR"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" -q install "mlx-vlm>=0.7.4,<0.8" huggingface_hub
fi
MODEL_DIR="$("$VENV/bin/hf" download "$MODEL" --quiet)"
echo "serving $MODEL from $MODEL_DIR on http://127.0.0.1:$PORT/v1" >&2
cd "$MODEL_DIR"
# Cap MLX's buffer cache (default: grows with every request until the Mac swaps; on a 16 GB
# M4 that turned 6 s requests into 10-minute ones). CLEF_CACHE_MB=0 disables caching.
exec "$VENV/bin/python" -c '
import os, runpy, sys
import mlx.core as mx
mx.set_cache_limit(int(os.environ.get("CLEF_CACHE_MB", "512")) * 1024 * 1024)
sys.argv = ["clef_mlx.py", "serve", "--port", os.environ["PORT"]]
runpy.run_path("clef_mlx.py", run_name="__main__")
'

