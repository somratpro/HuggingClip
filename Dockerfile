# Stage 1: Build Paperclip from source
FROM node:lts-trixie-slim AS paperclip-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Clone Paperclip (depth=1 for speed, uses repo's default branch)
RUN git clone --depth=1 https://github.com/paperclipai/paperclip.git .

# Copy lock files early for cache efficiency: lock changes don't re-clone
RUN ls -la pnpm-lock.yaml package.json 2>/dev/null || true

# Install dependencies (corepack picks correct pnpm version from packageManager field)
RUN pnpm install

# Apply both patches in a single layer (reduces layer count, cleaner git history)
# Patch 1: React Router basename for /app path handling
# Patch 2: Recovery chain depth cap at 500 to prevent stack overflow
RUN sed -i 's|<BrowserRouter>|<BrowserRouter basename="/app">|' ui/src/main.tsx && \
    grep -q 'basename="/app"' ui/src/main.tsx || (echo "PATCH 1 FAILED: React Router basename not applied" && exit 1) && \
    PATCH_FILE=server/src/services/recovery/issue-graph-liveness.ts && \
    test -f "$PATCH_FILE" || (echo "PATCH 2 FAILED: File not found: $PATCH_FILE" && exit 1) && \
    sed -i 's/seen\.has(current\.id)/(seen.size > 500 || seen.has(current.id))/' "$PATCH_FILE" && \
    grep -q "seen.size > 500" "$PATCH_FILE" || (echo "PATCH 2 FAILED: Chain depth cap not applied" && exit 1)

# Build Paperclip (match official Dockerfile order)
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build

# Stage 2: Runtime
FROM node:lts-trixie-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    postgresql-client \
    postgresql \
    postgresql-contrib \
    python3 \
    python3-pip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create PostgreSQL runtime directories
RUN mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql

# Install health-server Node dependencies locally in /app
RUN npm init -y && npm install express@4 cors morgan

# Install agent CLIs globally
RUN npm install -g @google/gemini-cli @anthropic-ai/claude-code @openai/codex

# Wrap agent CLIs so they:
# 1. Drop cloudflare-proxy.js NODE_OPTIONS (would conflict with their HTTP)
# 2. Pre-set --max-old-space-size=4096 so gemini doesn't trigger heap-size
#    self-relaunch (the spawn fails in HF Spaces containers)
RUN for cmd in claude codex; do \
        if [ -e /usr/local/bin/$cmd ]; then \
            mv /usr/local/bin/$cmd /usr/local/bin/${cmd}-real && \
            printf '#!/bin/sh\nunset NODE_OPTIONS\nexport NODE_OPTIONS="--max-old-space-size=4096 --no-deprecation --no-warnings"\nexec /usr/local/bin/%s-real "$@"\n' "$cmd" > /usr/local/bin/$cmd && \
            chmod +x /usr/local/bin/$cmd; \
        fi; \
    done

# Gemini wrapper — definitive fix for "Failed to relaunch the CLI process":
#
# ROOT CAUSE: Gemini CLI checks process.execArgv for --max-old-space-size.
#   NODE_OPTIONS does NOT populate process.execArgv, so Gemini always tries to
#   relaunch itself with the flag as a CLI arg. That spawn fails in HF Spaces.
#
# FIX: Resolve the actual JS entry point at build time and invoke it directly
#   via `node --max-old-space-size=4096 <entry.js>` so the flag IS in execArgv.
#   Gemini sees it, skips the relaunch entirely.
#
# Also bake in headless env vars so they survive even when Paperclip spawns
# gemini with a custom env object (no env inheritance fallback):
#   GEMINI_SANDBOX=false          — skip Docker-sandbox attempt in containers
#   GEMINI_CLI_TRUST_WORKSPACE=true — skip interactive workspace-trust prompt
RUN GEMINI_PKG="/usr/local/lib/node_modules/@google/gemini-cli" && \
    GEMINI_JS=$(node -e " \
      const pkg = require('$GEMINI_PKG/package.json'); \
      const bin = pkg.bin; \
      const entry = typeof bin === 'string' ? bin : (bin.gemini || bin[Object.keys(bin)[0]]); \
      console.log(require('path').resolve('$GEMINI_PKG', entry)); \
    ") && \
    echo "Gemini JS entry: $GEMINI_JS" && \
    mv /usr/local/bin/gemini /usr/local/bin/gemini-real && \
    { \
      echo '#!/bin/sh'; \
      echo 'unset NODE_OPTIONS'; \
      echo 'export NODE_OPTIONS="--no-deprecation --no-warnings"'; \
      echo 'export GEMINI_SANDBOX=false'; \
      echo 'export GEMINI_CLI_TRUST_WORKSPACE=true'; \
      echo "exec node --max-old-space-size=4096 $GEMINI_JS \"\$@\""; \
    } > /usr/local/bin/gemini && \
    chmod +x /usr/local/bin/gemini && \
    echo "=== gemini wrapper ===" && cat /usr/local/bin/gemini

# Install Python dependencies for sync
RUN pip install --no-cache-dir --break-system-packages huggingface_hub PyYAML

# Copy full Paperclip build (including node_modules for runtime)
COPY --from=paperclip-builder /build /app/paperclip

# Ensure pnpm is available in runtime stage
RUN corepack enable

# Copy orchestration files
COPY start.sh /app/
COPY health-server.js /app/
COPY paperclip-sync.py /app/
COPY cloudflare-proxy.js /app/
COPY cloudflare-proxy-setup.py /app/
COPY cloudflare-worker.js /app/
COPY setup-uptimerobot.sh /app/

RUN chmod +x /app/start.sh /app/setup-uptimerobot.sh

# Create non-root user for running Paperclip + agent CLIs
# Claude Code refuses --dangerously-skip-permissions when running as root
# Note: /app files stay root-owned (644/755 defaults = readable by all).
# /paperclip runtime dir is chowned to paperclip in start.sh after restore.
RUN useradd -m -u 1001 -s /bin/bash paperclip && \
    mkdir -p /paperclip /var/lib/postgresql/data && \
    chown -R postgres:postgres /var/lib/postgresql/data && \
    chown paperclip:paperclip /paperclip

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:7861/health || exit 1

CMD ["/app/start.sh"]
