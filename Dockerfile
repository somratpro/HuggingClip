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

# Persistent storage
RUN mkdir -p /paperclip /var/lib/postgresql/data && \
    chown -R postgres:postgres /var/lib/postgresql/data

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -f http://localhost:7861/health || exit 1

CMD ["/app/start.sh"]
