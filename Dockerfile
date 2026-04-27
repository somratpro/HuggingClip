# Stage 1: Build Paperclip from source
FROM node:lts-trixie-slim AS paperclip-builder

WORKDIR /build

RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Clone Paperclip repository
RUN git clone https://github.com/paperclipai/paperclip.git . && \
    git checkout main

# Install pnpm
RUN npm install -g pnpm@9.15.2

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build Paperclip
RUN pnpm build

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
    python3-venv \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create PostgreSQL data directory
RUN mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql

# Install Node dependencies for health-server
RUN npm install -g express@4.18.2 cors@2.8.5 morgan@1.10.0 uuid@9.0.1

# Install Python dependencies for sync
RUN pip install --no-cache-dir huggingface_hub==0.24.5 PyYAML==6.0.1

# Copy Paperclip build from builder
COPY --from=paperclip-builder /build/dist /app/paperclip
COPY --from=paperclip-builder /build/package.json /app/paperclip/
COPY --from=paperclip-builder /build/node_modules /app/paperclip/node_modules

# Copy orchestration files
COPY start.sh /app/
COPY health-server.js /app/
COPY paperclip-sync.py /app/
COPY cloudflare-proxy.js /app/
COPY cloudflare-proxy-setup.py /app/
COPY cloudflare-worker.js /app/
COPY setup-uptimerobot.sh /app/

# Make scripts executable
RUN chmod +x /app/start.sh /app/setup-uptimerobot.sh

# Create persistent storage directory
RUN mkdir -p /paperclip /var/lib/postgresql/data && \
    chown -R postgres:postgres /var/lib/postgresql/data /paperclip

# Set secure file permissions
RUN umask 0077

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -f http://localhost:7861/health || exit 1

CMD ["/app/start.sh"]
