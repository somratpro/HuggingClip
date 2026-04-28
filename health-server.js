const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const http = require("http");
const net = require("net");

const app = express();
const PORT = 7861; // always public-facing port, never read from PORT (that's for Paperclip)
const PAPERCLIP_HOST = "127.0.0.1";
const PAPERCLIP_PORT = 3100;

// Middleware
app.use(cors());
// Skip logging for health polling, static assets, and WebSocket upgrade attempts
app.use(morgan("tiny", {
  skip: (req) => req.path === "/health" || req.path === "/sw.js" ||
                 req.path.startsWith("/assets/") || req.path === "/favicon.ico" ||
                 req.path.endsWith("/events/ws")
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// Health Check Endpoint
// ============================================================================
app.get("/health", async (req, res) => {
  try {
    const syncStatus = readSyncStatus();
    const now = Math.floor(Date.now() / 1000);
    const uptime = process.uptime();

    // Try to check if Paperclip is responding
    const paperclipStatus = await checkPaperclipHealth();

    const inviteUrl = readInviteUrl();

    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(uptime),
      startTime: new Date(Date.now() - uptime * 1000).toISOString(),
      setupUrl: inviteUrl || null,
      services: {
        healthServer: {
          status: "running",
          port: PORT,
          uptime: Math.floor(uptime),
        },
        paperclip: {
          status: paperclipStatus.status,
          port: PAPERCLIP_PORT,
          url: `http://${PAPERCLIP_HOST}:${PAPERCLIP_PORT}`,
        },
        database: {
          status: syncStatus.db_status || "unknown",
          lastSync: syncStatus.last_sync_time || null,
          lastSyncError: syncStatus.last_error || null,
        },
      },
      backup: {
        enabled: process.env.SYNC_DISABLED !== "true",
        interval: process.env.SYNC_INTERVAL || 180,
        lastSync: syncStatus.last_sync_time,
        nextSync: syncStatus.last_sync_time
          ? new Date(
              new Date(syncStatus.last_sync_time).getTime() +
                parseInt(process.env.SYNC_INTERVAL || 180) * 1000,
            ).toISOString()
          : null,
      },
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================================================
// Dashboard Route
// ============================================================================
app.get("/", (req, res) => {
  res.send(getDashboardHTML());
});

app.get("/_status", (req, res) => {
  res.send(getDashboardHTML());
});

app.get("/_status/", (req, res) => {
  res.send(getDashboardHTML());
});

app.get("/dashboard/", (req, res) => {
  res.redirect("/");
});

app.get("/dashboard/status", (req, res) => {
  const syncStatus = readSyncStatus();
  const uptime = process.uptime();

  res.json({
    uptime: Math.floor(uptime),
    startTime: new Date(Date.now() - uptime * 1000).toISOString(),
    syncStatus: syncStatus,
    environment: {
      syncDisabled: process.env.SYNC_DISABLED === "true",
      syncInterval: process.env.SYNC_INTERVAL || 180,
      paperclipHome: process.env.PAPERCLIP_HOME || "/paperclip",
    },
  });
});

// ============================================================================
// UptimeRobot Setup Route
// ============================================================================
app.post("/dashboard/uptimerobot/setup", (req, res) => {
  const { webhookUrl } = req.body;

  if (!webhookUrl) {
    return res.status(400).json({ error: "webhookUrl required" });
  }

  // Store webhook URL in environment or file
  process.env.WEBHOOK_URL = webhookUrl;

  res.json({
    success: true,
    message: "UptimeRobot webhook configured",
    details: "Health checks will now notify UptimeRobot to prevent sleep",
  });
});

// ============================================================================
// Reverse Proxy Routes
// ============================================================================

// Proxy /app/* to Paperclip, stripping the /app prefix.
// The SPA is built with BrowserRouter basename="/app" so React Router
// strips the prefix on the client — Paperclip receives clean paths.
app.all("/app/*", async (req, res) => {
  const targetPath = req.path.replace("/app", "") || "/";
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const targetUrl = `http://${PAPERCLIP_HOST}:${PAPERCLIP_PORT}${targetPath}${query}`;

  try {
    const response = await proxyRequest(req.method, targetUrl, req.headers, req.body);
    Object.keys(response.headers).forEach((key) => res.setHeader(key, response.headers[key]));
    res.status(response.statusCode).send(response.body);
  } catch (error) {
    console.error(`Proxy error: ${error.message}`);
    res.status(503).json({ error: "Paperclip service unavailable", details: error.message });
  }
});

// Proxy all /api/* requests to Paperclip
app.all("/api/*", async (req, res) => {
  const targetPath = req.path;
  const targetUrl = `http://${PAPERCLIP_HOST}:${PAPERCLIP_PORT}${targetPath}`;

  try {
    const response = await proxyRequest(
      req.method,
      targetUrl,
      req.headers,
      req.body,
    );

    Object.keys(response.headers).forEach((key) => {
      res.setHeader(key, response.headers[key]);
    });

    res.status(response.statusCode).send(response.body);
  } catch (error) {
    console.error(`API proxy error: ${error.message}`);
    res.status(503).json({
      error: "Paperclip API unavailable",
      details: error.message,
    });
  }
});

// Catch-all: proxy /assets/*, /site.webmanifest, /favicon.* and any other
// paths Paperclip's UI references with absolute URLs directly to Paperclip.
// Note: /health is handled above and never reaches here.
app.all("*", async (req, res) => {
  const targetUrl = `http://${PAPERCLIP_HOST}:${PAPERCLIP_PORT}${req.url}`;

  try {
    const response = await proxyRequest(
      req.method,
      targetUrl,
      req.headers,
      req.body,
    );

    Object.keys(response.headers).forEach((key) => {
      res.setHeader(key, response.headers[key]);
    });

    res.status(response.statusCode).send(response.body);
  } catch (error) {
    const starting = error.message && error.message.includes("ECONNREFUSED");
    res.status(503).json({
      error: starting ? "Paperclip starting up, please wait..." : "Paperclip service unavailable",
      details: error.message,
    });
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

function readSyncStatus() {
  try {
    if (fs.existsSync("/tmp/sync-status.json")) {
      const data = fs.readFileSync("/tmp/sync-status.json", "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error reading sync status:", error.message);
  }

  return {
    db_status: "unknown",
    last_sync_time: null,
    last_error: null,
    sync_count: 0,
  };
}

function readInviteUrl() {
  try {
    if (fs.existsSync("/tmp/invite-url.txt")) {
      return fs.readFileSync("/tmp/invite-url.txt", "utf8").trim();
    }
  } catch (error) {
    // ignore
  }
  return null;
}

function checkPaperclipHealth() {
  return new Promise((resolve) => {
    const healthUrl = `http://${PAPERCLIP_HOST}:${PAPERCLIP_PORT}/health`;

    const timeout = setTimeout(() => {
      resolve({ status: "unreachable", reason: "timeout" });
    }, 5000);

    http
      .get(healthUrl, (res) => {
        clearTimeout(timeout);
        resolve({ status: "running", statusCode: res.statusCode });
      })
      .on("error", (err) => {
        clearTimeout(timeout);
        resolve({ status: "unreachable", reason: err.message });
      });
  });
}

function proxyRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        ...headers,
        host: `${PAPERCLIP_HOST}:${PAPERCLIP_PORT}`,
      },
      timeout: 30000,
    };

    const req = http.request(url, options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (body && Object.keys(body).length > 0) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HuggingClip - Paperclip on HF Spaces</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            color: white;
            margin-bottom: 40px;
            animation: slideDown 0.6s ease-out;
        }

        @keyframes slideDown {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .header h1 {
            font-size: 2.5em;
            margin-bottom: 10px;
            font-weight: 700;
        }

        .header p {
            font-size: 1.1em;
            opacity: 0.9;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .card {
            background: white;
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
            animation: fadeIn 0.6s ease-out;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .card:nth-child(1) { animation-delay: 0.1s; }
        .card:nth-child(2) { animation-delay: 0.2s; }
        .card:nth-child(3) { animation-delay: 0.3s; }
        .card:nth-child(4) { animation-delay: 0.4s; }

        .card h2 {
            color: #333;
            font-size: 1.3em;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
        }

        .status-indicator.running {
            background-color: #4ade80;
            box-shadow: 0 0 10px rgba(74, 222, 128, 0.5);
        }

        .status-indicator.stopped {
            background-color: #ef4444;
        }

        .status-indicator.unknown {
            background-color: #eab308;
        }

        .stat {
            margin: 12px 0;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid #f0f0f0;
        }

        .stat:last-child {
            border-bottom: none;
        }

        .stat-label {
            color: #666;
            font-size: 0.95em;
        }

        .stat-value {
            color: #333;
            font-weight: 600;
            font-size: 0.95em;
        }

        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 16px;
        }

        .button {
            flex: 1;
            padding: 10px 16px;
            border: none;
            border-radius: 6px;
            font-size: 0.9em;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .button-primary {
            background: #667eea;
            color: white;
        }

        .button-primary:hover {
            background: #5568d3;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }

        .button-secondary {
            background: #f3f4f6;
            color: #333;
            border: 1px solid #e5e7eb;
        }

        .button-secondary:hover {
            background: #e5e7eb;
        }

        .footer {
            text-align: center;
            color: white;
            margin-top: 40px;
            opacity: 0.8;
            font-size: 0.9em;
        }

        .footer a {
            color: white;
            text-decoration: underline;
        }

        .error {
            color: #dc2626;
            font-size: 0.85em;
        }

        .success {
            color: #16a34a;
            font-size: 0.85em;
        }

        .pending {
            color: #ea580c;
            font-size: 0.85em;
        }

        .code {
            background: #f3f4f6;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 0.85em;
        }

        .loading {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #667eea;
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }

        .setup-banner {
            background: linear-gradient(135deg, #f59e0b, #d97706);
            color: white;
            border-radius: 12px;
            padding: 24px 28px;
            margin-bottom: 24px;
            box-shadow: 0 10px 30px rgba(245, 158, 11, 0.4);
            animation: fadeIn 0.5s ease-out;
        }

        .setup-banner h2 {
            font-size: 1.3em;
            margin-bottom: 10px;
        }

        .setup-banner p {
            opacity: 0.9;
            margin-bottom: 16px;
            font-size: 0.95em;
        }

        .setup-banner .invite-link {
            background: rgba(255,255,255,0.2);
            border: 1px solid rgba(255,255,255,0.4);
            border-radius: 8px;
            padding: 12px 16px;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 0.85em;
            word-break: break-all;
            margin-bottom: 16px;
            display: block;
        }

        .setup-banner .btn-setup {
            display: inline-block;
            background: white;
            color: #d97706;
            font-weight: 700;
            padding: 10px 24px;
            border-radius: 6px;
            text-decoration: none;
            font-size: 0.95em;
            transition: all 0.2s;
        }

        .setup-banner .btn-setup:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📎 HuggingClip</h1>
            <p>Paperclip AI Agent Orchestration on Hugging Face Spaces</p>
        </div>

        <!-- First-time Setup Banner (hidden by default, shown if invite URL exists) -->
        <div class="setup-banner" id="setup-banner" style="display:none;">
            <h2>🔑 Admin Setup Required</h2>
            <p>No admin account exists yet. Open the link below to create your first admin account, then complete onboarding to start using Paperclip.</p>
            <span class="invite-link" id="invite-url-text">Loading...</span>
            <a href="#" class="btn-setup" id="invite-url-link" target="_blank">Open Setup Page &rarr;</a>
        </div>

        <div class="grid">
            <!-- Paperclip Status Card -->
            <div class="card">
                <h2>
                    <span class="status-indicator running"></span>
                    Paperclip Service
                </h2>
                <div class="stat">
                    <span class="stat-label">Status</span>
                    <span class="stat-value" id="paperclip-status">
                        <span class="loading"></span> Checking...
                    </span>
                </div>
                <div class="stat">
                    <span class="stat-label">Port</span>
                    <span class="stat-value">3100</span>
                </div>
                <div class="stat">
                    <span class="stat-label">UI URL</span>
                    <span class="stat-value"><span class="code">/app/</span></span>
                </div>
                <div class="button-group">
                    <a href="/app/" class="button button-primary" target="_blank">Open Paperclip UI</a>
                </div>
            </div>

            <!-- Database Status Card -->
            <div class="card">
                <h2>
                    <span class="status-indicator running"></span>
                    Database
                </h2>
                <div class="stat">
                    <span class="stat-label">Status</span>
                    <span class="stat-value" id="db-status">PostgreSQL</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Location</span>
                    <span class="stat-value"><span class="code">/paperclip</span></span>
                </div>
                <div class="stat">
                    <span class="stat-label">Last Backup</span>
                    <span class="stat-value" id="last-backup">Never</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Backup Status</span>
                    <span class="stat-value" id="backup-status">
                        <span class="loading"></span> Checking...
                    </span>
                </div>
            </div>

            <!-- System Health Card -->
            <div class="card">
                <h2>
                    <span class="status-indicator running"></span>
                    System Health
                </h2>
                <div class="stat">
                    <span class="stat-label">Uptime</span>
                    <span class="stat-value" id="uptime">Calculating...</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Start Time</span>
                    <span class="stat-value" id="start-time">Calculating...</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Health Server</span>
                    <span class="stat-value success">Running</span>
                </div>
                <div class="stat">
                    <span class="stat-label">API Port</span>
                    <span class="stat-value"><span class="code">7861</span></span>
                </div>
            </div>

            <!-- Quick Links Card -->
            <div class="card">
                <h2>📚 Resources</h2>
                <div class="button-group" style="flex-direction: column;">
                    <a href="/app/" class="button button-primary" target="_blank">Paperclip Dashboard</a>
                    <a href="/api/" class="button button-secondary" target="_blank">API Reference</a>
                </div>
                <div class="stat" style="margin-top: 16px;">
                    <span class="stat-label">Documentation</span>
                    <span class="stat-value"><a href="https://docs.paperclip.ing" target="_blank" style="color: #667eea; text-decoration: underline;">paperclip.ing</a></span>
                </div>
                <div class="stat">
                    <span class="stat-label">GitHub</span>
                    <span class="stat-value"><a href="https://github.com/paperclipai/paperclip" target="_blank" style="color: #667eea; text-decoration: underline;">paperclipai/paperclip</a></span>
                </div>
            </div>
        </div>

        <div class="footer">
            <p>HuggingClip v1.0 • Running on Hugging Face Spaces</p>
            <p style="margin-top: 10px; opacity: 0.6;">Last updated: <span id="footer-time">loading...</span></p>
        </div>
    </div>

    <script>
        // Update status every 5 seconds
        async function updateStatus() {
            try {
                const response = await fetch('/health');
                const data = await response.json();

                // Update Paperclip status
                const paperclipEl = document.getElementById('paperclip-status');
                if (data.services.paperclip.status === 'running') {
                    paperclipEl.innerHTML = '<span class="success">Running ✓</span>';
                } else {
                    paperclipEl.innerHTML = '<span class="error">Unreachable</span>';
                }

                // Update DB status
                const dbEl = document.getElementById('db-status');
                const dbStatus = data.services.database.status;
                if (dbStatus === 'connected' || dbStatus === 'unknown') {
                    dbEl.innerHTML = '<span class="success">PostgreSQL ✓</span>';
                } else {
                    dbEl.innerHTML = '<span class="error">Unavailable</span>';
                }

                // Update last backup
                const lastBackupEl = document.getElementById('last-backup');
                if (data.services.database.lastSync) {
                    const lastSync = new Date(data.services.database.lastSync).toLocaleString();
                    lastBackupEl.textContent = lastSync;
                } else {
                    lastBackupEl.textContent = 'Never';
                }

                // Update backup status
                const backupStatusEl = document.getElementById('backup-status');
                if (!data.backup.enabled) {
                    backupStatusEl.innerHTML = '<span class="pending">Disabled (no HF_TOKEN)</span>';
                } else if (data.services.database.lastSyncError) {
                    backupStatusEl.innerHTML = '<span class="error">Error</span>';
                } else if (data.backup.lastSync) {
                    backupStatusEl.innerHTML = '<span class="success">Enabled ✓</span>';
                } else {
                    backupStatusEl.innerHTML = '<span class="pending">Pending first sync</span>';
                }

                // Update uptime
                const uptimeEl = document.getElementById('uptime');
                const uptime = data.uptime;
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);
                uptimeEl.textContent = \`\${hours}h \${minutes}m \${seconds}s\`;

                // Update start time
                const startTimeEl = document.getElementById('start-time');
                const startTime = new Date(data.startTime).toLocaleString();
                startTimeEl.textContent = startTime;

                // Show setup banner if invite URL exists
                const setupBanner = document.getElementById('setup-banner');
                if (data.setupUrl) {
                    document.getElementById('invite-url-text').textContent = data.setupUrl;
                    document.getElementById('invite-url-link').href = data.setupUrl;
                    setupBanner.style.display = 'block';
                } else {
                    setupBanner.style.display = 'none';
                }

                // Update footer time
                document.getElementById('footer-time').textContent = new Date().toLocaleString();
            } catch (error) {
                console.error('Status update failed:', error);
            }
        }

        // Initial update
        updateStatus();

        // Update every 30 seconds — reduce log noise
        setInterval(updateStatus, 30000);
    </script>
</body>
</html>`;
}

// ============================================================================
// Start Server + WebSocket Proxy
// ============================================================================
const server = http.createServer(app);

// Proxy WebSocket upgrades (e.g. /api/companies/:id/events/ws) directly to Paperclip.
// Without this, the browser gets 403 and spams reconnect attempts.
server.on("upgrade", (req, socket, head) => {
  const targetSocket = net.connect(PAPERCLIP_PORT, "127.0.0.1", () => {
    let upgradeReq = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key, val] of Object.entries(req.headers)) {
      upgradeReq += `${key}: ${val}\r\n`;
    }
    upgradeReq += "\r\n";
    targetSocket.write(upgradeReq);
    if (head && head.length > 0) targetSocket.write(head);
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });
  targetSocket.on("error", () => {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
  });
  socket.on("error", () => targetSocket.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ Health server listening on port ${PORT}`);
  console.log(`✓ Dashboard: http://localhost:${PORT}/`);
  console.log(`✓ API proxy: http://localhost:${PORT}/api/*`);
  console.log(`✓ App proxy: http://localhost:${PORT}/  (root → Paperclip)`);
});
