// Single public entrypoint for HF Spaces: local dashboard + reverse proxy to Paperclip.
const http = require("http");
const https = require("https");
const fs = require("fs");
const net = require("net");

const PORT = 7861; // always public-facing port, never read from PORT (that's for Paperclip)
const PAPERCLIP_HOST = "127.0.0.1";
const PAPERCLIP_PORT = 3100;
const startTime = Date.now();

const HF_BACKUP_ENABLED = !!process.env.HF_TOKEN;
const SYNC_INTERVAL = process.env.SYNC_INTERVAL || "180";

const UPTIMEROBOT_SETUP_ENABLED =
  String(process.env.UPTIMEROBOT_SETUP_ENABLED || "true").toLowerCase() === "true";
const UPTIMEROBOT_RATE_WINDOW_MS = 60 * 1000;
const UPTIMEROBOT_RATE_MAX = Number(process.env.UPTIMEROBOT_RATE_LIMIT_PER_MINUTE || 5);
const SPACE_VISIBILITY_TTL_MS = 10 * 60 * 1000;
const spaceVisibilityCache = new Map();
const uptimerobotRateMap = new Map();

// ============================================================================
// URL helpers
// ============================================================================

function parseRequestUrl(url) {
  try {
    return new URL(url, "http://localhost");
  } catch {
    return new URL("http://localhost/");
  }
}

function isLocalRoute(pathname) {
  return (
    pathname === "/health" ||
    pathname === "/status" ||
    pathname === "/uptimerobot/setup"
  );
}

// ============================================================================
// UptimeRobot helpers
// ============================================================================

function getRequesterIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded) && forwarded.length > 0) return String(forwarded[0]).split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
  const now = Date.now();
  const ip = getRequesterIp(req);
  const bucket = uptimerobotRateMap.get(ip) || [];
  const recent = bucket.filter((ts) => now - ts < UPTIMEROBOT_RATE_WINDOW_MS);
  recent.push(now);
  uptimerobotRateMap.set(ip, recent);
  return recent.length > UPTIMEROBOT_RATE_MAX;
}

setInterval(() => {
  const cutoff = Date.now() - UPTIMEROBOT_RATE_WINDOW_MS;
  for (const [ip, timestamps] of uptimerobotRateMap) {
    if (timestamps.every((ts) => ts < cutoff)) uptimerobotRateMap.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function isAllowedUptimeSetupOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  const origin = String(req.headers.origin || "").toLowerCase();
  const referer = String(req.headers.referer || "").toLowerCase();
  if (!host) return false;
  if (origin && !origin.includes(host)) return false;
  if (referer && !referer.includes(host)) return false;
  return true;
}

function isValidUptimeApiKey(key) {
  return /^[A-Za-z0-9_-]{20,128}$/.test(String(key || ""));
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getSpaceRef(parsedUrl) {
  const signedToken = parsedUrl.searchParams.get("__sign");
  if (!signedToken) return null;
  const payload = decodeJwtPayload(signedToken);
  const subject = payload && payload.sub;
  const match =
    typeof subject === "string"
      ? subject.match(/^\/spaces\/([^/]+)\/([^/]+)$/)
      : null;
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function fetchStatusCode(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "HuggingClip/1.0", accept: "application/json" } },
      (res) => { res.resume(); resolve(res.statusCode || 0); },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

async function resolveSpaceIsPrivate(parsedUrl) {
  const ref = getSpaceRef(parsedUrl);
  if (!ref) return false;
  const cacheKey = `${ref.owner}/${ref.repo}`;
  const cached = spaceVisibilityCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SPACE_VISIBILITY_TTL_MS) return cached.isPrivate;
  try {
    const statusCode = await fetchStatusCode(`https://huggingface.co/api/spaces/${ref.owner}/${ref.repo}`);
    const isPrivate = statusCode === 401 || statusCode === 403 || statusCode === 404;
    spaceVisibilityCache.set(cacheKey, { isPrivate, timestamp: Date.now() });
    return isPrivate;
  } catch {
    if (cached) return cached.isPrivate;
    return false;
  }
}

function postUptimeRobot(path, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.uptimerobot.com",
        port: 443,
        method: "POST",
        path,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { raw += chunk; });
        response.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error("Unexpected response from UptimeRobot")); }
        });
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function createUptimeRobotMonitor(apiKey, host) {
  const cleanHost = String(host || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!cleanHost) throw new Error("Missing Space host.");

  const monitorUrl = `https://${cleanHost}/health`;
  const existing = await postUptimeRobot("/v2/getMonitors", {
    api_key: apiKey, format: "json", logs: "0",
    response_times: "0", response_times_limit: "1",
  });

  const existingMonitor = Array.isArray(existing.monitors)
    ? existing.monitors.find((m) => m.url === monitorUrl)
    : null;

  if (existingMonitor) {
    return { created: false, message: `Monitor already exists for ${monitorUrl}` };
  }

  const created = await postUptimeRobot("/v2/newMonitor", {
    api_key: apiKey, format: "json", type: "1",
    friendly_name: `HuggingClip ${cleanHost}`,
    url: monitorUrl, interval: "300",
  });

  if (created.stat !== "ok") {
    const message = created?.error?.message || created?.message || "Failed to create UptimeRobot monitor.";
    throw new Error(message);
  }

  return { created: true, message: `Monitor created for ${monitorUrl}` };
}

// ============================================================================
// Status helpers
// ============================================================================

function readSyncStatus() {
  try {
    if (fs.existsSync("/tmp/sync-status.json")) {
      return JSON.parse(fs.readFileSync("/tmp/sync-status.json", "utf8"));
    }
  } catch {}
  if (HF_BACKUP_ENABLED) {
    return {
      db_status: "unknown",
      last_sync_time: null,
      last_error: null,
      sync_count: 0,
      status: "configured",
      message: `Backup enabled. Waiting for first sync (every ${SYNC_INTERVAL}s).`,
    };
  }
  return { db_status: "unknown", last_sync_time: null, last_error: null, sync_count: 0 };
}

function readInviteUrl() {
  try {
    if (fs.existsSync("/tmp/invite-url.txt")) {
      return fs.readFileSync("/tmp/invite-url.txt", "utf8").trim();
    }
  } catch {}
  return null;
}

function checkPaperclipHealth() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: "unreachable", reason: "timeout" }), 5000);
    http.get(`http://${PAPERCLIP_HOST}:${PAPERCLIP_PORT}/api/health`, (res) => {
      clearTimeout(timeout);
      resolve({ status: res.statusCode < 500 ? "running" : "error", statusCode: res.statusCode });
      res.resume();
    }).on("error", (err) => {
      clearTimeout(timeout);
      resolve({ status: "unreachable", reason: err.message });
    });
  });
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ============================================================================
// Dashboard HTML
// ============================================================================

function renderDashboard(initialData) {
  const keepAwakeHtml = !UPTIMEROBOT_SETUP_ENABLED
    ? `<div class="helper-summary">UptimeRobot setup is disabled for this Space.</div>`
    : initialData.spacePrivate
    ? `<div class="helper-summary"><strong>Space is private.</strong> External monitors cannot access private HF health URLs. Switch to a public Space to use keep-awake.</div>`
    : `
        <div id="uptimerobot-summary" class="helper-summary">
            One-time setup for public Spaces. Paste your UptimeRobot <strong>Main API key</strong> to create the monitor.
        </div>
        <button id="uptimerobot-toggle" class="helper-toggle" type="button">Set Up Monitor</button>
        <div id="uptimerobot-shell" class="helper-shell hidden">
            <div class="helper-copy">
                Do <strong>not</strong> use the Read-only API key or a Monitor-specific API key.
            </div>
            <div class="helper-row">
                <input id="uptimerobot-key" class="helper-input" type="password"
                    placeholder="Paste your UptimeRobot Main API key" autocomplete="off" />
                <button id="uptimerobot-btn" class="helper-button" type="button">Create Monitor</button>
            </div>
            <div class="helper-note">One-time setup. Your key is only used to create the monitor for this Space.</div>
        </div>
        <div id="uptimerobot-result" class="helper-result"></div>`;

  const syncStatus = initialData.sync;
  const hasBackup = HF_BACKUP_ENABLED;
  const lastSync = syncStatus.last_sync_time
    ? new Date(syncStatus.last_sync_time).toLocaleString()
    : "Never";
  const syncError = syncStatus.last_error || null;
  const syncOk = hasBackup && !syncError && syncStatus.last_sync_time;

  const syncBadge = !hasBackup
    ? `<div class="status-badge status-offline">Disabled</div>`
    : syncError
    ? `<div class="status-badge status-error">Error</div>`
    : syncStatus.last_sync_time
    ? `<div class="status-badge status-online"><div class="pulse"></div>Enabled</div>`
    : `<div class="status-badge status-syncing"><div class="pulse" style="background:#3b82f6"></div>Pending</div>`;

  const paperclipBadge = initialData.paperclipRunning
    ? `<div class="status-badge status-online"><div class="pulse"></div>Running</div>`
    : `<div class="status-badge status-offline">Unreachable</div>`;

  const inviteUrl = initialData.inviteUrl;
  const setupBannerHtml = inviteUrl ? `
    <div class="setup-banner">
      <div class="setup-banner-title">Admin Setup Required</div>
      <div class="setup-banner-body">No admin account configured. Open this link to create your first admin account:</div>
      <div class="setup-banner-url">${inviteUrl}</div>
      <a href="${inviteUrl}" class="setup-banner-btn" target="_blank" rel="noopener noreferrer">Open Setup Page →</a>
    </div>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HuggingClip Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --accent: linear-gradient(135deg, #667eea, #764ba2);
            --text: #f8fafc;
            --text-dim: #94a3b8;
            --success: #10b981;
            --error: #ef4444;
            --warning: #f59e0b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg);
            color: var(--text);
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
            padding: 24px 0;
            background-image:
                radial-gradient(at 0% 0%, rgba(102, 126, 234, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(118, 75, 162, 0.15) 0px, transparent 50%);
        }
        .dashboard {
            width: 90%;
            max-width: 600px;
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 24px;
            padding: 40px;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
            animation: fadeIn 0.8s ease-out;
            margin: 24px 0;
        }
        @keyframes fadeIn { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
        header { text-align: center; margin-bottom: 40px; }
        h1 {
            font-size: 2.5rem;
            margin-bottom: 8px;
            background: var(--accent);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            font-weight: 600;
        }
        .subtitle { color: var(--text-dim); font-size: 0.9rem; letter-spacing: 1px; text-transform: uppercase; }
        .stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        .stat-card {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.05);
            padding: 20px;
            border-radius: 16px;
            transition: transform 0.3s ease, border-color 0.3s ease;
        }
        .stat-card:hover { transform: translateY(-3px); border-color: rgba(102,126,234,0.3); }
        .stat-label { color: var(--text-dim); font-size: 0.75rem; text-transform: uppercase; margin-bottom: 8px; display: block; }
        .stat-value { font-size: 1.1rem; font-weight: 600; }
        .stat-btn {
            grid-column: span 2;
            background: var(--accent);
            color: #fff;
            padding: 16px;
            border-radius: 16px;
            text-align: center;
            text-decoration: none;
            font-weight: 600;
            display: block;
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            box-shadow: 0 10px 20px -5px rgba(102,126,234,0.4);
        }
        .stat-btn:hover { transform: scale(1.02); box-shadow: 0 15px 30px -5px rgba(102,126,234,0.6); }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 600;
        }
        .status-online  { background: rgba(16,185,129,0.1); color: var(--success); }
        .status-offline { background: rgba(239,68,68,0.1); color: var(--error); }
        .status-syncing { background: rgba(59,130,246,0.1); color: #3b82f6; }
        .status-error   { background: rgba(239,68,68,0.1); color: var(--error); }
        .pulse {
            width: 8px; height: 8px; border-radius: 50%;
            background: currentColor;
            box-shadow: 0 0 0 0 rgba(16,185,129,0.7);
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%   { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16,185,129,0.7); }
            70%  { transform: scale(1);    box-shadow: 0 0 0 10px rgba(16,185,129,0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16,185,129,0); }
        }
        .card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
        .card-header .stat-label { margin-bottom: 0; }
        .sync-info { background: rgba(255,255,255,0.02); padding: 15px; border-radius: 12px; font-size: 0.85rem; color: var(--text-dim); margin-top: 10px; }
        #sync-msg { color: var(--text); display: block; margin-top: 4px; }
        .helper-card { width: 100%; margin-top: 20px; }
        .helper-copy { color: var(--text-dim); font-size: 0.92rem; line-height: 1.6; margin-top: 10px; }
        .helper-copy strong { color: var(--text); }
        .helper-row { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
        .helper-input {
            flex: 1; min-width: 240px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            color: var(--text); border-radius: 12px;
            padding: 14px 16px; font: inherit;
        }
        .helper-input::placeholder { color: var(--text-dim); }
        .helper-button {
            background: var(--accent); color: #fff; border: 0;
            border-radius: 12px; padding: 14px 18px;
            font: inherit; font-weight: 600; cursor: pointer; min-width: 180px;
        }
        .helper-button:disabled { opacity: 0.6; cursor: wait; }
        .hidden { display: none !important; }
        .helper-note { margin-top: 10px; font-size: 0.82rem; color: var(--text-dim); }
        .helper-result { margin-top: 14px; padding: 12px 14px; border-radius: 12px; font-size: 0.9rem; display: none; }
        .helper-result.ok    { display: block; background: rgba(16,185,129,0.1); color: var(--success); }
        .helper-result.error { display: block; background: rgba(239,68,68,0.1); color: var(--error); }
        .helper-shell { margin-top: 12px; }
        .helper-shell.hidden { display: none; }
        .helper-summary {
            margin-top: 14px; padding: 12px 14px; border-radius: 12px;
            background: rgba(255,255,255,0.03); color: var(--text-dim);
            font-size: 0.9rem; line-height: 1.5;
        }
        .helper-summary strong { color: var(--text); }
        .helper-summary.success { background: rgba(16,185,129,0.08); }
        .helper-toggle {
            margin-top: 14px; display: inline-flex; align-items: center; justify-content: center;
            background: rgba(255,255,255,0.04); color: var(--text);
            border: 1px solid rgba(255,255,255,0.08); border-radius: 12px;
            padding: 12px 16px; font: inherit; font-weight: 600; cursor: pointer;
        }
        .setup-banner {
            background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3);
            border-radius: 16px; padding: 20px; margin-bottom: 20px;
        }
        .setup-banner-title { font-weight: 600; color: var(--warning); margin-bottom: 8px; }
        .setup-banner-body { color: var(--text-dim); font-size: 0.9rem; margin-bottom: 10px; }
        .setup-banner-url {
            font-family: monospace; font-size: 0.8rem; word-break: break-all;
            background: rgba(255,255,255,0.04); border-radius: 8px;
            padding: 8px 12px; margin-bottom: 12px; color: var(--text);
        }
        .setup-banner-btn {
            display: inline-block; background: var(--warning); color: #000;
            font-weight: 700; padding: 8px 20px; border-radius: 8px;
            text-decoration: none; font-size: 0.9rem;
        }
        .links-row { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
        .link-btn {
            flex: 1; min-width: 120px; text-align: center; padding: 10px 16px;
            border-radius: 12px; text-decoration: none; font-size: 0.9rem; font-weight: 600;
            transition: opacity 0.2s;
        }
        .link-btn:hover { opacity: 0.8; }
        .link-primary { background: var(--accent); color: #fff; }
        .link-secondary { background: rgba(255,255,255,0.06); color: var(--text); border: 1px solid rgba(255,255,255,0.08); }
        .footer { text-align: center; color: var(--text-dim); font-size: 0.8rem; margin-top: 20px; }
        @media (max-width: 700px) {
            body { padding: 16px 0; }
            .dashboard { width: calc(100% - 24px); padding: 24px; border-radius: 18px; margin: 12px 0; }
            header { margin-bottom: 28px; }
            h1 { font-size: 2rem; }
            .stats-grid { grid-template-columns: 1fr; gap: 14px; margin-bottom: 16px; }
            .stat-btn { grid-column: span 1; }
            .helper-row { flex-direction: column; }
            .helper-input, .helper-button { width: 100%; min-width: 0; }
        }
    </style>
</head>
<body>
    <div class="dashboard">
        <header>
            <h1>📎 HuggingClip</h1>
            <p class="subtitle">Paperclip on HF Spaces</p>
        </header>

        ${setupBannerHtml}

        <div class="stats-grid">
            <div class="stat-card">
                <div class="card-header">
                    <span class="stat-label">Paperclip</span>
                    <span id="paperclip-badge">${paperclipBadge}</span>
                </div>
            </div>
            <div class="stat-card">
                <span class="stat-label">Uptime</span>
                <span class="stat-value" id="uptime">${formatUptime(Math.floor((Date.now() - startTime) / 1000))}</span>
            </div>
            <div class="stat-card">
                <div class="card-header">
                    <span class="stat-label">Backup</span>
                    <span id="sync-badge">${syncBadge}</span>
                </div>
                <div style="margin-top: 8px; font-size: 0.82rem; color: var(--text-dim);">
                    Last sync: <span id="last-sync">${lastSync}</span>
                </div>
            </div>
            <div class="stat-card">
                <span class="stat-label">Database</span>
                <span class="stat-value" id="db-status">${syncStatus.db_status === "connected" ? "PostgreSQL ✓" : syncStatus.db_status === "error" ? "Error" : "PostgreSQL"}</span>
            </div>
            <a href="/app/" id="open-ui-btn" class="stat-btn" target="_blank" rel="noopener noreferrer">Open Paperclip UI</a>
        </div>

        <div class="stat-card" style="width: 100%; margin-bottom: 20px;">
            <div class="card-header">
                <span class="stat-label">Backup Sync</span>
                <div id="sync-badge-detail">${syncBadge}</div>
            </div>
            <div class="sync-info">
                Last activity: <span id="sync-time-detail">${lastSync}</span>
                <span id="sync-msg">${syncError ? "Error: " + syncError : syncStatus.last_sync_time ? "Sync successful" : hasBackup ? "Waiting for first sync..." : "HF_TOKEN not set — backups disabled"}</span>
            </div>
        </div>

        <div class="stat-card helper-card">
            <span class="stat-label">Keep Space Awake</span>
            ${keepAwakeHtml}
        </div>

        <div class="stat-card" style="margin-top: 20px;">
            <span class="stat-label">Resources</span>
            <div class="links-row">
                <a href="/app/" class="link-btn link-primary" target="_blank">Paperclip UI</a>
                <a href="/api/health" class="link-btn link-secondary" target="_blank">API Health</a>
                <a href="https://paperclip.ing" class="link-btn link-secondary" target="_blank" rel="noopener noreferrer">Docs</a>
            </div>
        </div>

        <div class="footer">Live updates every 30s</div>
    </div>

    <script>
        const KEEP_AWAKE_PRIVATE = ${initialData.spacePrivate ? "true" : "false"};
        const KEEP_AWAKE_SETUP_ENABLED = ${UPTIMEROBOT_SETUP_ENABLED ? "true" : "false"};
        const monitorStateKey = 'huggingclip_uptimerobot_v1';

        function getCurrentSearch() { return window.location.search || ''; }

        function renderSyncBadge(status, lastSyncTime, lastError) {
            if (!${hasBackup}) return '<div class="status-badge status-offline">Disabled</div>';
            if (lastError) return '<div class="status-badge status-error">Error</div>';
            if (lastSyncTime) return '<div class="status-badge status-online"><div class="pulse"></div>Enabled</div>';
            return '<div class="status-badge status-syncing"><div class="pulse" style="background:#3b82f6"></div>Pending</div>';
        }

        async function updateStatus() {
            try {
                const res = await fetch('/status' + getCurrentSearch());
                const data = await res.json();

                document.getElementById('uptime').textContent = data.uptime;

                const pbadge = data.paperclipRunning
                    ? '<div class="status-badge status-online"><div class="pulse"></div>Running</div>'
                    : '<div class="status-badge status-offline">Unreachable</div>';
                document.getElementById('paperclip-badge').innerHTML = pbadge;

                const badge = renderSyncBadge(data.sync.db_status, data.sync.last_sync_time, data.sync.last_error);
                document.getElementById('sync-badge').innerHTML = badge;
                document.getElementById('sync-badge-detail').innerHTML = badge;

                const lastSync = data.sync.last_sync_time
                    ? new Date(data.sync.last_sync_time).toLocaleString()
                    : 'Never';
                document.getElementById('last-sync').textContent = lastSync;
                document.getElementById('sync-time-detail').textContent = lastSync;

                const syncMsg = data.sync.last_error
                    ? 'Error: ' + data.sync.last_error
                    : data.sync.last_sync_time
                    ? 'Sync successful'
                    : ${hasBackup} ? 'Waiting for first sync...' : 'HF_TOKEN not set — backups disabled';
                document.getElementById('sync-msg').textContent = syncMsg;

                const dbEl = document.getElementById('db-status');
                dbEl.textContent = data.sync.db_status === 'connected' ? 'PostgreSQL ✓'
                    : data.sync.db_status === 'error' ? 'Error' : 'PostgreSQL';
            } catch (e) {
                console.error('Status update failed:', e);
            }
        }

        function setMonitorUiState(isConfigured) {
            const summary = document.getElementById('uptimerobot-summary');
            const shell = document.getElementById('uptimerobot-shell');
            const toggle = document.getElementById('uptimerobot-toggle');
            if (!summary || !shell || !toggle) return;
            if (isConfigured) {
                summary.classList.add('success');
                summary.innerHTML = '<strong>Already set up.</strong> Your UptimeRobot monitor should keep this public Space awake.';
                shell.classList.add('hidden');
                toggle.textContent = 'Set Up Again';
            } else {
                summary.classList.remove('success');
                summary.innerHTML = 'One-time setup for public Spaces. Paste your UptimeRobot <strong>Main API key</strong> to create the monitor.';
                toggle.textContent = 'Set Up Monitor';
            }
        }

        function restoreMonitorUiState() {
            try { setMonitorUiState(window.localStorage.getItem(monitorStateKey) === 'done'); }
            catch { setMonitorUiState(false); }
        }

        async function setupUptimeRobot() {
            const input = document.getElementById('uptimerobot-key');
            const button = document.getElementById('uptimerobot-btn');
            const result = document.getElementById('uptimerobot-result');
            const apiKey = input.value.trim();
            if (!apiKey) {
                result.className = 'helper-result error';
                result.textContent = 'Paste your UptimeRobot Main API key first.';
                return;
            }
            button.disabled = true;
            button.textContent = 'Creating...';
            result.className = 'helper-result';
            result.textContent = '';
            try {
                const res = await fetch('/uptimerobot/setup' + getCurrentSearch(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Failed to create monitor.');
                result.className = 'helper-result ok';
                result.textContent = data.message || 'UptimeRobot monitor is ready.';
                input.value = '';
                try { window.localStorage.setItem(monitorStateKey, 'done'); } catch {}
                setMonitorUiState(true);
                document.getElementById('uptimerobot-shell').classList.add('hidden');
            } catch (error) {
                result.className = 'helper-result error';
                result.textContent = error.message || 'Failed to create monitor.';
            } finally {
                button.disabled = false;
                button.textContent = 'Create Monitor';
            }
        }

        updateStatus();
        setInterval(updateStatus, 30000);

        if (KEEP_AWAKE_SETUP_ENABLED && !KEEP_AWAKE_PRIVATE) {
            restoreMonitorUiState();
            const toggleBtn = document.getElementById('uptimerobot-toggle');
            const createBtn = document.getElementById('uptimerobot-btn');
            if (toggleBtn) toggleBtn.addEventListener('click', () => {
                document.getElementById('uptimerobot-shell').classList.toggle('hidden');
            });
            if (createBtn) createBtn.addEventListener('click', setupUptimeRobot);
        }
    </script>
</body>
</html>`;
}

// ============================================================================
// Request body reader
// ============================================================================

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) { reject(new Error("Request too large")); req.destroy(); }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ============================================================================
// HTTP Proxy helpers
// ============================================================================

function buildProxyHeaders(headers) {
  const clientIp = (function() {
    const f = headers["x-forwarded-for"];
    if (typeof f === "string") return f.split(",")[0].trim();
    if (Array.isArray(f) && f.length > 0) return String(f[0]).split(",")[0].trim();
    return "";
  })();
  return {
    ...headers,
    host: `${PAPERCLIP_HOST}:${PAPERCLIP_PORT}`,
    "x-forwarded-for": clientIp,
    "x-forwarded-host": headers.host || "",
    "x-forwarded-proto": headers["x-forwarded-proto"] || "https",
  };
}

function proxyHttp(req, res, overridePath) {
  const targetPath = overridePath !== undefined ? overridePath : req.url;
  let upstreamStarted = false;
  const proxyReq = http.request(
    { hostname: PAPERCLIP_HOST, port: PAPERCLIP_PORT, method: req.method, path: targetPath, headers: buildProxyHeaders(req.headers) },
    (proxyRes) => {
      upstreamStarted = true;
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (error) => {
    if (res.headersSent || upstreamStarted) { res.destroy(); return; }
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", message: "Paperclip unavailable", detail: error.message }));
  });
  res.on("close", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, overridePath) {
  const targetPath = overridePath !== undefined ? overridePath : req.url;
  const proxySocket = net.connect(PAPERCLIP_PORT, PAPERCLIP_HOST);
  proxySocket.on("connect", () => {
    const clientIp = (function() {
      const f = req.headers["x-forwarded-for"];
      if (typeof f === "string") return f.split(",")[0].trim();
      return req.socket.remoteAddress || "";
    })();
    const lines = [
      `${req.method} ${targetPath} HTTP/${req.httpVersion}`,
      ...req.rawHeaders.reduce((acc, val, i) => {
        if (i % 2 === 0) { acc.push(i); } else { acc[acc.length - 1] = `${req.rawHeaders[acc[acc.length - 1]]}: ${val}`; }
        return acc;
      }, []).filter((h) => {
        const lower = (typeof h === "string" ? h : "").toLowerCase();
        return !lower.startsWith("host:") && !lower.startsWith("x-forwarded-");
      }),
      `Host: ${PAPERCLIP_HOST}:${PAPERCLIP_PORT}`,
      `X-Forwarded-For: ${clientIp}`,
      `X-Forwarded-Host: ${req.headers.host || ""}`,
      `X-Forwarded-Proto: ${req.headers["x-forwarded-proto"] || "https"}`,
      "", "",
    ];
    proxySocket.write(lines.join("\r\n"));
    if (head && head.length > 0) proxySocket.write(head);
    socket.pipe(proxySocket).pipe(socket);
  });
  proxySocket.on("error", () => {
    if (socket.writable) socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  socket.on("error", () => proxySocket.destroy());
}

// ============================================================================
// HTTP Server
// ============================================================================

const server = http.createServer((req, res) => {
  const parsedUrl = parseRequestUrl(req.url || "/");
  const pathname = parsedUrl.pathname;
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  // ── Health endpoint ────────────────────────────────────────────────────────
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime,
      uptimeHuman: formatUptime(uptime),
      timestamp: new Date().toISOString(),
      sync: readSyncStatus(),
    }));
    return;
  }

  // ── Status endpoint (JSON, polled by dashboard) ───────────────────────────
  if (pathname === "/status") {
    void (async () => {
      const paperclipStatus = await checkPaperclipHealth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        uptime: formatUptime(uptime),
        paperclipRunning: paperclipStatus.status === "running",
        sync: readSyncStatus(),
        inviteUrl: readInviteUrl(),
      }));
    })();
    return;
  }

  // ── UptimeRobot setup endpoint ─────────────────────────────────────────────
  if (pathname === "/uptimerobot/setup") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Method not allowed" }));
      return;
    }
    void (async () => {
      try {
        if (!UPTIMEROBOT_SETUP_ENABLED) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Uptime setup is disabled." }));
          return;
        }
        if (isRateLimited(req)) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Too many requests." }));
          return;
        }
        if (!isAllowedUptimeSetupOrigin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Invalid request origin." }));
          return;
        }
        const body = await readRequestBody(req);
        const parsed = JSON.parse(body || "{}");
        const apiKey = String(parsed.apiKey || "").trim();
        if (!isValidUptimeApiKey(apiKey)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "A valid API key is required." }));
          return;
        }
        const result = await createUptimeRobotMonitor(apiKey, req.headers.host);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: error?.message || "Failed to create UptimeRobot monitor." }));
      }
    })();
    return;
  }

  // ── Dashboard (root) ───────────────────────────────────────────────────────
  if (pathname === "/" || pathname === "") {
    void (async () => {
      const [paperclipStatus, spacePrivate] = await Promise.all([
        checkPaperclipHealth(),
        resolveSpaceIsPrivate(parsedUrl),
      ]);
      const initialData = {
        paperclipRunning: paperclipStatus.status === "running",
        sync: readSyncStatus(),
        inviteUrl: readInviteUrl(),
        spacePrivate,
      };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboard(initialData));
    })();
    return;
  }

  // ── /app/* → strip prefix, proxy to Paperclip ─────────────────────────────
  // SPA built with basename="/app"; React Router strips /app client-side.
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const stripped = pathname.slice("/app".length) || "/";
    const query = parsedUrl.search || "";
    proxyHttp(req, res, stripped + query);
    return;
  }

  // ── Everything else → proxy directly ──────────────────────────────────────
  proxyHttp(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const pathname = parseRequestUrl(req.url || "/").pathname;
  if (isLocalRoute(pathname)) { socket.destroy(); return; }
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const stripped = pathname.slice("/app".length) || "/";
    proxyUpgrade(req, socket, head, stripped + (parseRequestUrl(req.url).search || ""));
    return;
  }
  proxyUpgrade(req, socket, head);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ Health server listening on port ${PORT}`);
  console.log(`✓ Dashboard: http://localhost:${PORT}/`);
  console.log(`✓ API proxy: http://localhost:${PORT}/api/*`);
  console.log(`✓ App proxy: http://localhost:${PORT}/  (root → Paperclip)`);
});
