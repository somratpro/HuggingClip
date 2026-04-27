#!/bin/bash
set -e

umask 0077

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Banner
echo -e "${BLUE}"
cat << 'EOF'
   ___  ___                _____ _ _
  / _ \/ _ \___ __________/ ___/| (_)____
 / ___/ ___/ _ `/ ___/ ___/\__ \ | | / __ \
/ /  / /  / /_/ / /  / /__/__/ / | | / /_/ /
\_/  \_/  \__,_/_/   \___/____/ |_|_/ .___/
                                    /_/
EOF
echo -e "${NC}${GREEN}Starting HuggingClip (Paperclip on HF Spaces)${NC}\n"

# ============================================================================
# 1. Validate Environment Variables
# ============================================================================
echo -e "${BLUE}[1/8] Validating environment variables...${NC}"

REQUIRED_VARS=("HF_TOKEN")
MISSING_VARS=()

for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        MISSING_VARS+=("$var")
    fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Warning: Missing env vars: ${MISSING_VARS[*]}${NC}"
    echo -e "${YELLOW}Backup to HF Dataset will be disabled${NC}"
    SYNC_DISABLED=true
else
    SYNC_DISABLED=false
fi

# Default values
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:paperclip@localhost:5432/paperclip}"
export PORT="${PORT:-3100}"
export SERVE_UI="${SERVE_UI:-true}"
export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-0.0.0.0}"
export PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}"
export PAPERCLIP_DEPLOYMENT_MODE="${PAPERCLIP_DEPLOYMENT_MODE:-authenticated}"
export SYNC_INTERVAL="${SYNC_INTERVAL:-180}"
export SYNC_MAX_FILE_BYTES="${SYNC_MAX_FILE_BYTES:-52428800}"
export BACKUP_DATASET_NAME="${BACKUP_DATASET_NAME:-paperclip-backup}"
export PAPERCLIP_TELEMETRY_DISABLED="${PAPERCLIP_TELEMETRY_DISABLED:-1}"
export DO_NOT_TRACK="${DO_NOT_TRACK:-1}"

# Auto-generate BETTER_AUTH_SECRET if not provided
# User-set secret (HF Space secret) always takes precedence
AUTH_SECRET_FILE="${PAPERCLIP_HOME}/.auth-secret"
mkdir -p "${PAPERCLIP_HOME}"
if [ -z "${BETTER_AUTH_SECRET}" ]; then
    if [ -f "${AUTH_SECRET_FILE}" ]; then
        # Reuse previously generated secret (persists across restarts)
        export BETTER_AUTH_SECRET=$(cat "${AUTH_SECRET_FILE}")
        echo -e "${YELLOW}Using persisted auth secret from ${AUTH_SECRET_FILE}${NC}"
    else
        # First boot — generate and save
        export BETTER_AUTH_SECRET=$(openssl rand -base64 32)
        echo "${BETTER_AUTH_SECRET}" > "${AUTH_SECRET_FILE}"
        chmod 600 "${AUTH_SECRET_FILE}"
        echo -e "${YELLOW}Generated new auth secret (saved to ${AUTH_SECRET_FILE})${NC}"
    fi
else
    echo -e "${GREEN}Using BETTER_AUTH_SECRET from environment${NC}"
fi

echo -e "${GREEN}✓ Environment validated${NC}\n"

# ============================================================================
# 2. Initialize PostgreSQL
# ============================================================================
echo -e "${BLUE}[2/8] Setting up PostgreSQL database...${NC}"

# Detect installed PostgreSQL version
PG_VERSION=$(ls /usr/lib/postgresql/ 2>/dev/null | sort -V | tail -1)
if [ -z "$PG_VERSION" ]; then
    echo -e "${RED}ERROR: PostgreSQL not found${NC}"
    exit 1
fi
PG_DATA="/var/lib/postgresql/${PG_VERSION}/main"
echo "PostgreSQL version: ${PG_VERSION}, data dir: ${PG_DATA}"

# Initialize cluster if it doesn't exist yet
if [ ! -f "${PG_DATA}/PG_VERSION" ]; then
    echo "Initializing PostgreSQL cluster..."
    pg_createcluster "${PG_VERSION}" main --locale=C.UTF-8
fi

# Start cluster if not running
if ! pg_ctlcluster "${PG_VERSION}" main status 2>/dev/null | grep -q "online"; then
    echo "Starting PostgreSQL cluster..."
    pg_ctlcluster "${PG_VERSION}" main start
fi

# Wait until ready
until pg_isready -h localhost -U postgres 2>/dev/null; do
    sleep 1
done

# Set postgres password and create paperclip DB (must run as postgres OS user — peer auth)
su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'paperclip';\"" 2>/dev/null || true
su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'paperclip'\" | grep -q 1 || \
    psql -c \"CREATE DATABASE paperclip OWNER postgres;\"" 2>/dev/null || true

# Export correct DATABASE_URL with detected version credentials
export DATABASE_URL="${DATABASE_URL:-postgres://postgres:paperclip@localhost:5432/paperclip}"

echo -e "${GREEN}✓ PostgreSQL ready${NC}\n"

# ============================================================================
# 3. Restore from HF Dataset Backup
# ============================================================================
echo -e "${BLUE}[3/8] Restoring database from HF Dataset backup...${NC}"

if [ "$SYNC_DISABLED" = false ]; then
    python3 /app/paperclip-sync.py restore 2>&1 || true
    echo -e "${GREEN}✓ Restore attempt completed${NC}\n"
else
    echo -e "${YELLOW}Skipping restore (no HF_TOKEN)${NC}\n"
fi

# ============================================================================
# 4. Setup Cloudflare Proxy (if token provided)
# ============================================================================
if [ -n "$CLOUDFLARE_WORKERS_TOKEN" ] && [ -n "$CLOUDFLARE_ACCOUNT_ID" ]; then
    echo -e "${BLUE}[4/8] Setting up Cloudflare proxy...${NC}"
    python3 /app/cloudflare-proxy-setup.py 2>&1 || echo -e "${YELLOW}Cloudflare setup failed, continuing without proxy${NC}"
    echo ""
else
    echo -e "${BLUE}[4/8] Cloudflare proxy (skipped - no credentials)${NC}\n"
fi

# ============================================================================
# 5. Start Background Sync Loop
# ============================================================================
echo -e "${BLUE}[5/8] Starting database sync loop...${NC}"

if [ "$SYNC_DISABLED" = false ]; then
    # Start sync in background
    (
        while true; do
            sleep "$SYNC_INTERVAL"
            python3 /app/paperclip-sync.py sync 2>&1 || true
        done
    ) &
    SYNC_PID=$!
    echo -e "${GREEN}✓ Sync loop started (PID: $SYNC_PID)${NC}\n"
else
    echo -e "${YELLOW}Sync disabled (no HF_TOKEN)${NC}\n"
fi

# ============================================================================
# 6. Start Health Server
# ============================================================================
echo -e "${BLUE}[6/8] Starting health server on port 7861...${NC}"

# Load Cloudflare proxy if available
if [ -f /app/cloudflare-proxy.js ]; then
    export NODE_OPTIONS="--require /app/cloudflare-proxy.js"
fi

node /app/health-server.js &
HEALTH_PID=$!
echo -e "${GREEN}✓ Health server started (PID: $HEALTH_PID)${NC}\n"

# Wait for health server to start
sleep 2

# ============================================================================
# 7. Launch Paperclip
# ============================================================================
echo -e "${BLUE}[7/8] Launching Paperclip application...${NC}"

cd /app/paperclip

# Install Paperclip dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing Paperclip dependencies..."
    pnpm install 2>&1 | tail -5 || npm install 2>&1 | tail -5
fi

# Run Paperclip
export DATABASE_URL
export PORT
export SERVE_UI
export NODE_ENV
export HOST
export PAPERCLIP_HOME
export PAPERCLIP_DEPLOYMENT_MODE
export PAPERCLIP_TELEMETRY_DISABLED
export DO_NOT_TRACK
export PAPERCLIP_DEPLOYMENT_EXPOSURE="${PAPERCLIP_DEPLOYMENT_EXPOSURE:-private}"
export PAPERCLIP_INSTANCE_ID="${PAPERCLIP_INSTANCE_ID:-default}"
export OPENCODE_ALLOW_ALL_MODELS="${OPENCODE_ALLOW_ALL_MODELS:-true}"

# Allowlist hostnames Paperclip will accept connections from
echo "Configuring allowed hostnames..."
pnpm paperclipai allowed-hostname localhost 2>/dev/null || true
pnpm paperclipai allowed-hostname 127.0.0.1 2>/dev/null || true
pnpm paperclipai allowed-hostname 0.0.0.0 2>/dev/null || true
# HF Spaces sets SPACE_HOST to the public URL (e.g. somratpro-huggingclip.hf.space)
if [ -n "$SPACE_HOST" ]; then
    pnpm paperclipai allowed-hostname "$SPACE_HOST" 2>/dev/null || true
    echo "Allowed HF Space host: $SPACE_HOST"
fi
echo -e "${GREEN}✓ Hostnames configured${NC}"

echo -e "${GREEN}✓ All systems ready${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "  Health Dashboard: http://localhost:7861/"
echo -e "  Paperclip UI:     http://localhost:7861/app/"
echo -e "  API Endpoint:     http://localhost:7861/api/*"
echo -e "${GREEN}═══════════════════════════════════════════${NC}\n"

# ============================================================================
# 8. Graceful Shutdown Handler
# ============================================================================
cleanup() {
    echo -e "\n${YELLOW}[SHUTDOWN] Received termination signal...${NC}"
    echo "Syncing data to HF Dataset..."

    if [ "$SYNC_DISABLED" = false ]; then
        python3 /app/paperclip-sync.py sync 2>&1 || true
    fi

    echo "Stopping services..."
    [ -n "$HEALTH_PID" ] && kill $HEALTH_PID 2>/dev/null || true
    [ -n "$SYNC_PID" ] && kill $SYNC_PID 2>/dev/null || true

    echo -e "${GREEN}Shutdown complete${NC}"
    exit 0
}

trap cleanup SIGTERM SIGINT

# Start Paperclip server with tsx loader (loads workspace .ts packages at runtime)
exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
