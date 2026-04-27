---
title: HuggingClip
emoji: 📎
colorFrom: gray
colorTo: black
sdk: docker
app_port: 7861
pinned: true
license: mit
secrets:
  - name: HF_TOKEN
    description: Hugging Face API token for database backup persistence to HF Dataset.
  - name: CLAUDE_API_KEY
    description: Anthropic Claude API key for Claude-powered agents.
  - name: BETTER_AUTH_SECRET
    description: Random secret for user authentication (generate with openssl rand -base64 32).
  - name: CLOUDFLARE_WORKERS_TOKEN
    description: Optional Cloudflare API token for outbound proxy setup.
  - name: CLOUDFLARE_ACCOUNT_ID
    description: Optional Cloudflare account ID (required if using Cloudflare proxy).
---

# � HuggingClip

Paperclip AI Agent Orchestration Platform running on Hugging Face Spaces.

Deploy your own instance of [Paperclip](https://paperclip.ing/) — the open-source platform for orchestrating AI agents to run autonomous businesses — on Hugging Face Spaces with automatic persistent backup to Hugging Face Datasets.

**Features:**

- ✅ Run Paperclip on HF Spaces (free tier compatible)
- ✅ Automatic database backup to HF Dataset (survives restarts)
- ✅ Health monitoring dashboard with real-time status
- ✅ One-click deploy with configuration via environment variables
- ✅ Cloudflare proxy integration (for network-restricted providers)
- ✅ Graceful shutdown and data persistence

## Quick Start

### 1-Click Deploy (Recommended)

[Deploy to Hugging Face Spaces](https://huggingface.co/new-space?template=somratpro/HuggingClip)

Or manually:

1. Create a new Space on [Hugging Face](https://huggingface.co/new-space)
2. Choose **Docker** as the runtime
3. Copy this repository as the source
4. Configure required secrets (see **Configuration** below)
5. Deploy!

### Local Development

#### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for direct testing)
- PostgreSQL 13+ (if running outside Docker)

#### Setup

```bash
# Clone repository
git clone https://github.com/somratpro/HuggingClip.git
cd HuggingClip

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
# At minimum set: HF_TOKEN for backup persistence

# Start with Docker Compose
docker-compose up -d

# Check health
curl http://localhost:7861/health

# Open dashboard
open http://localhost:7861/
```

## Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `HF_TOKEN` | Hugging Face API token (for backup persistence) | `hf_xxxx...` |

Get your HF token from [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens)

### Paperclip Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://postgres:paperclip@localhost:5432/paperclip` | PostgreSQL connection string |
| `PORT` | `3100` | Paperclip API port |
| `NODE_ENV` | `production` | Node.js environment |
| `PAPERCLIP_HOME` | `/paperclip` | Paperclip data directory |
| `PAPERCLIP_DEPLOYMENT_MODE` | `authenticated` | Deployment mode (local/authenticated) |

### Agent Provider Keys

Configure API keys for your agent providers:

```bash
# Claude agents
CLAUDE_API_KEY=sk-ant-xxxx...

# Other LLM providers
LLM_API_KEY=xxxx...

# Allow all Claude models
OPENCODE_ALLOW_ALL_MODELS=true
```

### Backup Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SYNC_INTERVAL` | `180` | Backup interval (seconds) |
| `SYNC_MAX_FILE_BYTES` | `52428800` | Max backup size (50MB) |
| `BACKUP_DATASET_NAME` | `paperclip-backup` | HF Dataset name for backups |

### Optional: Cloudflare Proxy

Enable outbound connections to blocked domains (Telegram, Discord, WhatsApp, etc.):

```bash
CLOUDFLARE_WORKERS_TOKEN=xxx  # From https://dash.cloudflare.com/
CLOUDFLARE_ACCOUNT_ID=xxx     # From Cloudflare dashboard
```

See [cloudflare-proxy-setup.py](cloudflare-proxy-setup.py) for details.

### Optional: Authentication

```bash
BETTER_AUTH_SECRET=your-random-secret  # Generate: openssl rand -base64 32
DISCORD_WEBHOOK_URL=https://...        # For admin notifications
```

## Deployment

### Hugging Face Spaces

1. **Create Space**: [huggingface.co/new-space](https://huggingface.co/new-space)
   - **Space name**: `huggingclip`
   - **Space type**: Public (or Private)
   - **Runtime**: Docker

2. **Configure Secrets**: Settings → Repository Secrets
   - `HF_TOKEN`: Your Hugging Face API token
   - `CLAUDE_API_KEY`: Claude API key (if using Claude agents)
   - Add any other provider keys needed

3. **Deploy**: Push to the Space repo or use the web editor

4. **Monitor**: Dashboard appears at `https://your-username-huggingclip.hf.space/`

### Docker

```bash
# Build
docker build -t huggingclip .

# Run
docker run -d \
  -p 7861:7861 \
  -e HF_TOKEN=hf_xxxx... \
  -e CLAUDE_API_KEY=sk-ant-xxxx... \
  -e DATABASE_URL=postgres://... \
  -v paperclip_data:/paperclip \
  huggingclip
```

### Docker Compose (Development)

```bash
docker-compose up -d
```

## Usage

### Dashboard

Access the health monitoring dashboard at: `http://your-space-url/`

**Shows:**

- Paperclip service status (running/down)
- Database health & last backup timestamp
- System uptime & start time
- Quick links to Paperclip UI and API

### Paperclip UI

Full Paperclip interface at: `http://your-space-url/app/`

**Features:**

- Create companies and organizational structures
- Recruit AI agents with specific roles
- Define tasks and monitor execution
- View conversation logs and agent decisions
- Manage budgets and costs
- Approve/override agent actions

### API

Direct API access at: `http://your-space-url/api/*`

Examples:

```bash
# Get API status
curl http://localhost:7861/health

# Check dashboard data
curl http://localhost:7861/dashboard/status

# Access Paperclip API
curl http://localhost:7861/api/companies
```

## Data Persistence

### Automatic Backup

HuggingClip automatically backs up your Paperclip database every 180 seconds (configurable):

1. **Database dump** - PostgreSQL SQL format
2. **Paperclip data** - Config files, plugins, etc.
3. **Upload to HF** - Stored in your `paperclip-backup` Dataset
4. **On restart** - Data automatically restored

You can view backups at: `https://huggingface.co/datasets/your-username/paperclip-backup`

### Manual Backup

```bash
# From inside container
python3 /app/paperclip-sync.py sync
```

### Manual Restore

```bash
# From inside container
python3 /app/paperclip-sync.py restore
```

## Troubleshooting

### Database Connection Failed

**Problem**: "Cannot connect to PostgreSQL"

**Solution:**

1. Check DATABASE_URL is correct: `postgres://user:pass@host:port/db`
2. Verify PostgreSQL is running: `docker ps | grep postgres`
3. Check credentials in DATABASE_URL match PostgreSQL setup
4. Wait 10-30s for PostgreSQL to initialize on first startup

### Backup Not Uploading

**Problem**: "Sync status shows error"

**Solution:**

1. Verify `HF_TOKEN` is set and valid
2. Check HF Dataset is created: `huggingface-cli repo info datasets/your-username/paperclip-backup`
3. Look at container logs: `docker logs huggingclip-app`
4. Run manual backup: `python3 paperclip-sync.py sync`

### Paperclip Not Accessible

**Problem**: Can't reach <http://localhost:7861/app/>

**Solution:**

1. Check container is running: `docker ps`
2. Check ports are exposed: `docker port huggingclip-app`
3. Verify port 3100 is not blocked
4. Check health: `curl http://localhost:7861/health`
5. Look at Paperclip logs: Search container logs for errors

### Space Keeps Restarting

**Problem**: Container exits repeatedly

**Solution:**

1. Check logs: `docker logs --tail=100 huggingclip-app`
2. Common causes:
   - Invalid DATABASE_URL
   - Missing required env vars
   - PostgreSQL not responding
   - Out of memory (HF free tier is limited)
3. Verify all required env vars are set correctly

### Out of Memory

**Problem**: "Killed" message or container restarts

**Solution:**

1. HF Spaces free tier: 2 vCPU, 16GB RAM, 50GB storage
2. Reduce backup interval: `SYNC_INTERVAL=600` (every 10 min instead of 3)
3. Reduce database size: Archive old agent runs and conversations
4. Use upgraded HF Space (Pro) for more resources

## Architecture

### Components

1. **Health Server** (Node.js, port 7861)
   - Public gateway + dashboard
   - Proxies requests to Paperclip
   - Health checks for monitoring

2. **Paperclip** (Node.js, port 3100)
   - Main AI agent orchestration app
   - React UI + REST API
   - PostgreSQL database

3. **PostgreSQL** (port 5432)
   - Stores companies, agents, tasks, conversations
   - Embedded in container
   - Synced to HF Dataset

4. **Sync Worker** (Python)
   - Periodic backup to Hugging Face
   - Restore on startup
   - Handles database persistence

5. **Cloudflare Proxy** (Optional)
   - Bypasses HF Spaces network blocks
   - Routes outbound API calls
   - Auto-provisioned if token provided

### Data Flow

```
┌─────────────────┐
│  Paperclip UI   │ (http://space-url/app/)
│  & REST API     │
└────────┬────────┘
         │
    (port 3100)
         │
┌────────▼────────┐      Every 180s      ┌──────────────────┐
│   Health Server │────────────────────▶ │ Sync to HF       │
│   (7861)        │                      │ (PostgreSQL dump)│
└────────┬────────┘                      └──────────────────┘
         │                                      │
         │                                      ▼
         │                         ┌──────────────────────┐
         └────────────────────────▶│ HF Dataset Backup    │
                                   │ paperclip-backup     │
         ◀─────────────────────────│                      │
         │  (on restart)           └──────────────────────┘
         ▼
    ┌────────────┐
    │ PostgreSQL │
    │ /paperclip │
    └────────────┘
```

## Backup Retention

HuggingClip stores only the **latest backup** in HF Dataset (`snapshots/latest.tar.gz`).

**To keep multiple backups manually:**

```bash
# Download backup from HF
huggingface-cli download datasets/your-username/paperclip-backup \
  snapshots/latest.tar.gz --repo-type dataset

# Save a copy
cp latest.tar.gz paperclip-backup-$(date +%Y%m%d-%H%M%S).tar.gz
```

## Monitoring

### UptimeRobot Integration

Prevent HF Spaces from sleeping (free tier auto-suspends idle Spaces):

1. Create UptimeRobot account: [uptimerobot.com](https://uptimerobot.com)
2. Add monitor: `https://your-space-url/health` (HTTP check every 5 min)
3. Configure alerts in HuggingClip:
   - `POST /dashboard/uptimerobot/setup` with webhook URL
4. UptimeRobot will ping your Space regularly, preventing sleep

### Health Check

The `/health` endpoint returns JSON with full service status:

```bash
curl -s http://localhost:7861/health | jq .
```

Response includes:

- Service uptime
- Database status
- Last backup timestamp
- Any errors

## Contributing

Found a bug? Want to improve HuggingClip?

1. Check [HuggingClip issues](https://github.com/somratpro/HuggingClip/issues)
2. Submit PR with:
   - Clear description of changes
   - Any needed documentation updates
   - Test of changes locally

## License

MIT License - see [LICENSE](LICENSE) file

## Resources

- **Paperclip**: [paperclip.ing](https://paperclip.ing/) | [GitHub](https://github.com/paperclipai/paperclip)
- **Documentation**: [docs.paperclip.ing](https://docs.paperclip.ing)
- **HuggingClip**: [GitHub](https://github.com/somratpro/HuggingClip)

## Support

- 📖 [Paperclip Docs](https://docs.paperclip.ing)
- 💬 [Paperclip Discord](https://discord.gg/paperclipai)
- 🐛 [Report Issues](https://github.com/somratpro/HuggingClip/issues)

---

Made with ❤️ for the AI agent community
