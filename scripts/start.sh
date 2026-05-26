#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-8080}"
WEB_PORT="${PORT:-5000}"

echo "Starting API server on port ${API_PORT}..."
cd "$ROOT_DIR/artifacts/api-server" && PORT="$API_PORT" pnpm run dev &
API_PID=$!

echo "Waiting for API server to be ready..."
until curl -sf "http://localhost:${API_PORT}/api/healthz" > /dev/null 2>&1; do
  sleep 1
done
echo "API server ready."

echo "Starting frontend on port ${WEB_PORT}..."
cd "$ROOT_DIR/artifacts/fishtokri-admin" && PORT="$WEB_PORT" BASE_PATH=/ pnpm run dev &
FRONTEND_PID=$!

wait $API_PID $FRONTEND_PID
