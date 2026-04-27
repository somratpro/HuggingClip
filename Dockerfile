# Stage 1: Build Paperclip from source
FROM node:lts-trixie-slim AS paperclip-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Clone Paperclip (depth=1 for speed, uses repo's default branch)
RUN git clone --depth=1 https://github.com/paperclipai/paperclip.git .

# Install dependencies (corepack picks correct pnpm version from packageManager field)
RUN pnpm install

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

# Install Gemini CLI globally so the gemini-local adapter can find it in PATH
RUN npm install -g @google/gemini-cli

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
