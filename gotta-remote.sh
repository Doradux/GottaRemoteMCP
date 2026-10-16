#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "[GottaRemoteMCP] Instalando dependencias..."
  npm install --silent
fi

if [ ! -f "dist/index.js" ]; then
  echo "[GottaRemoteMCP] Compilando TypeScript..."
  npm run build --silent
fi

exec node dist/index.js "$@"
