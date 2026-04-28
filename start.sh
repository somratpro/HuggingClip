#!/bin/bash
set -euo pipefail

umask 0077

# ── Config ────────────────────────────────────────────────────────────────────
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:paperclip@localhost:5432/paperclip}"
export PORT="${PORT:-3100}"
export SERVE_UI="${SERVE_UI:-true}"
export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-0.0.0.0}"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
export PAPERCLIP_DEPLOYMENT_MODE="${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}"
export PAPERCLIP_DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
export PAPERCLIP_CONFIG="${PAPERCLIP_CONFIG:-${PAPERCLIP_HOME}/instances/default/config.json}"
export PAPERCLIP_TELEMETRY_DISABLED="${PAPERCLIP_TELEMETRY_DISABLED:-1}"
export DO_NOT_TRACK="${DO_NOT_TRACK:-1}"
export OPENCODE_ALLOW_ALL_MODELS="${OPENCODE_ALLOW_ALL_MODELS:-true}"
export SYNC_INTERVAL="${SYNC_INTERVAL:-180}"
export SYNC_MAX_FILE_BYTES="${SYNC_MAX_FILE_BYTES:-52428800}"
export BACKUP_DATASET_NAME="${BACKUP_DATASET_NAME:-paperclip-backup}"

# Derive public URL from HF Space host
if [ -z "${PAPERCLIP_PUBLIC_URL:-}" ] && [ -n "${SPACE_HOST:-}" ]; then
    export PAPERCLIP_PUBLIC_URL="https://${SPACE_HOST}"
fi

# Allowed hostnames
_ALLOWED="localhost,127.0.0.1,0.0.0.0"
if [ -n "${SPACE_HOST:-}" ]; then
    _ALLOWED="${_ALLOWED},${SPACE_HOST}"
fi
export PAPERCLIP_ALLOWED_HOSTNAMES="${PAPERCLIP_ALLOWED_HOSTNAMES:-${_ALLOWED}}"

# LLM API keys
export GEMINI_API_KEY="${GEMINI_API_KEY:-}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${CLAUDE_API_KEY:-}}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"

mkdir -p "${PAPERCLIP_HOME}"

# Auth secrets (generate + persist so they survive restarts)
AUTH_SECRET_FILE="${PAPERCLIP_HOME}/.auth-secret"
if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
    if [ -f "${AUTH_SECRET_FILE}" ]; then
        export BETTER_AUTH_SECRET=$(cat "${AUTH_SECRET_FILE}")
    else
        export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
        echo "${BETTER_AUTH_SECRET}" > "${AUTH_SECRET_FILE}"
        chmod 600 "${AUTH_SECRET_FILE}"
    fi
fi

JWT_SECRET_FILE="${PAPERCLIP_HOME}/.jwt-secret"
if [ -z "${PAPERCLIP_AGENT_JWT_SECRET:-}" ]; then
    if [ -f "${JWT_SECRET_FILE}" ]; then
        export PAPERCLIP_AGENT_JWT_SECRET=$(cat "${JWT_SECRET_FILE}")
    else
        export PAPERCLIP_AGENT_JWT_SECRET=$(openssl rand -base64 32)
        echo "${PAPERCLIP_AGENT_JWT_SECRET}" > "${JWT_SECRET_FILE}"
        chmod 600 "${JWT_SECRET_FILE}"
    fi
fi

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo "  ╔════════════════════════════════════╗"
echo "  ║          HuggingClip               ║"
echo "  ╚════════════════════════════════════╝"
echo ""
echo "Public host  : ${SPACE_HOST:-not detected}"
echo "Public URL   : ${PAPERCLIP_PUBLIC_URL:-http://localhost:${PORT}}"
echo "App port     : ${PORT}"
echo "Deploy mode  : ${PAPERCLIP_DEPLOYMENT_MODE}"
echo "Sync every   : ${SYNC_INTERVAL}s"
echo ""

# ── PostgreSQL ────────────────────────────────────────────────────────────────
PG_VERSION=$(ls /usr/lib/postgresql/ 2>/dev/null | sort -V | tail -1)
if [ -z "$PG_VERSION" ]; then
    echo "ERROR: PostgreSQL not found"
    exit 1
fi
PG_DATA="/var/lib/postgresql/${PG_VERSION}/main"

if [ ! -f "${PG_DATA}/PG_VERSION" ]; then
    echo "Initializing PostgreSQL cluster..."
    pg_createcluster "${PG_VERSION}" main --locale=C.UTF-8 >/dev/null 2>&1
fi

if ! pg_ctlcluster "${PG_VERSION}" main status 2>/dev/null | grep -q "online"; then
    echo "Starting PostgreSQL..."
    pg_ctlcluster "${PG_VERSION}" main start >/dev/null 2>&1
fi

until pg_isready -h localhost -U postgres >/dev/null 2>&1; do
    sleep 1
done

su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'paperclip';\"" >/dev/null 2>&1 || true
su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'paperclip'\" | grep -q 1 || psql -c \"CREATE DATABASE paperclip OWNER postgres;\"" >/dev/null 2>&1 || true

echo "PostgreSQL ready (v${PG_VERSION})"

# ── Restore from HF Dataset ───────────────────────────────────────────────────
if [ -n "${HF_TOKEN:-}" ]; then
    echo "Restoring persisted data from HF Dataset..."
    python3 /app/paperclip-sync.py restore 2>&1 || true
else
    echo "HF_TOKEN not set — running without backup persistence"
fi

# ── Cloudflare Proxy ──────────────────────────────────────────────────────────
if [ -n "${CLOUDFLARE_WORKERS_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    echo "Setting up Cloudflare proxy..."
    python3 /app/cloudflare-proxy-setup.py 2>&1 || echo "Cloudflare setup failed, continuing without proxy"
fi

# ── Load Cloudflare module if present ─────────────────────────────────────────
if [ -f /app/cloudflare-proxy.js ]; then
    export NODE_OPTIONS="--require /app/cloudflare-proxy.js"
fi

# ── Background sync loop ──────────────────────────────────────────────────────
if [ -n "${HF_TOKEN:-}" ]; then
    (
        while true; do
            sleep "$SYNC_INTERVAL"
            python3 /app/paperclip-sync.py sync 2>&1 || true
        done
    ) &
    SYNC_PID=$!
else
    SYNC_PID=""
fi

# ── Health server ─────────────────────────────────────────────────────────────
node /app/health-server.js &
HEALTH_PID=$!
sleep 2

# ── Paperclip instance config ─────────────────────────────────────────────────
cd /app/paperclip

if [ ! -d "node_modules" ]; then
    echo "Installing Paperclip dependencies..."
    pnpm install 2>&1 | tail -5 || npm install 2>&1 | tail -5
fi

if [ ! -f "${PAPERCLIP_CONFIG}" ]; then
    echo "Creating instance config (first boot)..."
    mkdir -p "$(dirname "${PAPERCLIP_CONFIG}")"
    python3 <<'PYEOF'
import json, os

home = os.environ.get("PAPERCLIP_HOME", "/paperclip")
port = int(os.environ.get("PORT", "3100"))
public_url = os.environ.get("PAPERCLIP_PUBLIC_URL", f"http://localhost:{port}")

config = {
    "$meta": {"version": 1, "updatedAt": "2024-01-01T00:00:00Z", "source": "onboard"},
    "llm": {"provider": "claude", "apiKey": ""},
    "database": {
        "mode": "postgres",
        "connectionString": os.environ.get("DATABASE_URL", "postgres://postgres:paperclip@localhost:5432/paperclip")
    },
    "logging": {"mode": "file", "logDir": f"{home}/instances/default/logs"},
    "server": {
        "deploymentMode": os.environ.get("PAPERCLIP_DEPLOYMENT_MODE", "authenticated"),
        "exposure": os.environ.get("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private"),
        "host": "0.0.0.0",
        "port": port,
        "allowedHostnames": [],
        "serveUi": True
    },
    "auth": {
        "baseUrlMode": "explicit",
        "publicBaseUrl": public_url,
        "disableSignUp": False
    },
    "storage": {
        "provider": "local_disk",
        "localDisk": {"baseDir": f"{home}/instances/default/data/storage"}
    },
    "secrets": {
        "provider": "local_encrypted",
        "strictMode": False,
        "localEncrypted": {"keyFilePath": f"{home}/instances/default/secrets/master.key"}
    },
    "telemetry": {"enabled": False}
}

config_path = os.environ.get("PAPERCLIP_CONFIG", f"{home}/instances/default/config.json")
os.makedirs(os.path.dirname(config_path), exist_ok=True)
with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
print(f"  Config written to {config_path}")
PYEOF
fi

# ── Graceful shutdown ─────────────────────────────────────────────────────────
cleanup() {
    echo "Shutting down — syncing data..."
    if [ -n "${HF_TOKEN:-}" ]; then
        python3 /app/paperclip-sync.py sync 2>&1 || true
    fi
    [ -n "${HEALTH_PID:-}" ] && kill "$HEALTH_PID" 2>/dev/null || true
    [ -n "${SYNC_PID:-}" ]   && kill "$SYNC_PID"  2>/dev/null || true
    [ -n "${PAPERCLIP_PID:-}" ] && kill "$PAPERCLIP_PID" 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

# ── Launch Paperclip ──────────────────────────────────────────────────────────
echo "Starting Paperclip..."
node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js &
PAPERCLIP_PID=$!

# Wait for API ready (max 90s)
PAPERCLIP_READY=false
for i in $(seq 1 45); do
    if curl -sf http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
        echo "Paperclip ready (${i}s)"
        PAPERCLIP_READY=true
        break
    fi
    sleep 2
done

if [ "$PAPERCLIP_READY" = true ]; then
    BOOTSTRAP_OUTPUT=$(pnpm paperclipai auth bootstrap-ceo 2>&1 || true)
    INVITE_URL=$(echo "$BOOTSTRAP_OUTPUT" | grep "Invite URL:" | sed 's/\x1B\[[0-9;]*[a-zA-Z]//g' | grep -o 'https\?://[^ ]*' | head -1)
    if [ -n "$INVITE_URL" ]; then
        echo "$INVITE_URL" > /tmp/invite-url.txt
        echo ""
        echo "  ┌─────────────────────────────────────────────────────┐"
        echo "  │  ADMIN SETUP — open this URL in your browser:       │"
        echo "  │                                                     │"
        echo "  │  ${INVITE_URL}"
        echo "  │                                                     │"
        echo "  └─────────────────────────────────────────────────────┘"
        echo ""
    else
        rm -f /tmp/invite-url.txt
        echo "Admin account already configured"
    fi
else
    echo "Warning: Paperclip did not become ready in 90s"
fi

echo "HuggingClip is ready!"
echo ""
echo "  Health dashboard : http://localhost:7861/"
echo "  Paperclip UI     : http://localhost:7861/app/"
echo "  API              : http://localhost:7861/api/"
echo ""

wait $PAPERCLIP_PID
