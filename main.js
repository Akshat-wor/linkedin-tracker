// ============================================================
//  LinkedIn Tracker — Production-Grade Main Process
//  Author: Faisal
// ============================================================

"use strict";

// ── Electron & Node core ──────────────────────────────────────
// NOTE: `clipboard` is Electron's built-in — zero packaging issues.
// clipboardy v4 is ESM-only and BREAKS inside packaged asar. Removed.
const {
    app, BrowserWindow, ipcMain, Tray, Menu, shell, clipboard: electronClipboard
} = require("electron");

const AutoLaunch = require("auto-launch");
const axios      = require("axios");
const fs         = require("fs");
const path       = require("path");

// ── Paths ─────────────────────────────────────────────────────
const USER_DATA   = app.getPath("userData");
const CONFIG_PATH = path.join(USER_DATA, "config.json");
const LOG_PATH    = path.join(USER_DATA, "tracker.log");
const QUEUE_PATH   = path.join(USER_DATA, "pending.json");
const COUNTER_PATH = path.join(USER_DATA, "daily_counter.json");

// ── API ───────────────────────────────────────────────────────
const API_URL = "https://script.google.com/macros/s/AKfycbwHWMIIDndNuKk7F2O4WWT4cfAnqDmoiNqYfngXCrIJzZHVUWz181O5XBCiERb_7bzz/exec";

// ── Constants ─────────────────────────────────────────────────
const CLIPBOARD_INTERVAL    = 3000;
const HEARTBEAT_INTERVAL    = 5 * 60 * 1000;   // 5 min
const WATCHDOG_INTERVAL     = 10 * 60 * 1000;  // 10 min stall threshold
const QUEUE_FLUSH_INTERVAL  = 60 * 1000;       // retry queue every 60 s
const CONVERSATION_COOLDOWN = 5000;
const API_TIMEOUT           = 12000;
const MAX_API_RETRIES       = 3;

// ── Mutable state ─────────────────────────────────────────────
let AGENT_NAME              = "";
let lastClipboard           = "";
let currentLinkedInAccount  = "";
let lastConversationLogTime = 0;
let tray                    = null;
let clipboardIntervalId     = null;
let lastHeartbeatTime       = Date.now();
let trackerActive           = false;
let clipboardFailureCount   = 0;
let apiDegraded             = false;
let queueActive             = false;
let queriesReplied          = 0;  // loaded from disk on startup

// ── Auto-launch ───────────────────────────────────────────────
// FIX: When packaged, auto-launch MUST point to the real executable path.
// On macOS, it needs the path to the .app bundle, while on Windows it needs the .exe.
const autoLauncher = new AutoLaunch({
    name: "LinkedIn Tracker",
    path: app.isPackaged 
        ? (process.platform === "darwin" ? path.join(process.execPath, "../../..") : process.execPath)
        : undefined
});

// ============================================================
//  1. PERSISTENT LOGGING
// ============================================================

function writeLog(message) {
    try {
        const ts   = new Date().toISOString();
        const line = `[${ts}] ${message}\n`;
        fs.appendFileSync(LOG_PATH, line, "utf8");
        console.log(line.trimEnd());
    } catch (_) {
        // Logging must NEVER crash the app
    }
}

// ============================================================
//  1b. DAILY QUERY COUNTER PERSISTENCE
// ============================================================

function getTodayKey() {
    return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
}

function loadDailyCount() {
    try {
        if (fs.existsSync(COUNTER_PATH)) {
            const data = JSON.parse(fs.readFileSync(COUNTER_PATH, "utf8"));
            const today = getTodayKey();
            if (data.date === today && typeof data.count === "number") {
                writeLog(`Daily counter loaded: ${data.count} queries for ${today}`);
                return data.count;
            }
            writeLog(`Counter file is from ${data.date || "unknown"}, today is ${today} — starting fresh.`);
        }
    } catch (err) {
        writeLog(`COUNTER LOAD ERROR: ${err.message}`);
    }
    return 0;
}

function saveDailyCount(count) {
    try {
        const payload = { date: getTodayKey(), count };
        fs.writeFileSync(COUNTER_PATH, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
        writeLog(`COUNTER SAVE ERROR: ${err.message}`);
    }
}

// ============================================================
//  2. GLOBAL ERROR PROTECTION
// ============================================================

process.on("uncaughtException", (err) => {
    writeLog(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    // Do NOT exit — let the watchdog recover the polling loop
});

process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error
        ? `${reason.message}\n${reason.stack}`
        : String(reason);
    writeLog(`UNHANDLED REJECTION: ${msg}`);
});

// ============================================================
//  UTILITIES
// ============================================================

function normalizeUrl(url) {
    return url
        .split("?")[0]
        .split("#")[0]
        .replace(/\/$/, "")
        .toLowerCase()
        .trim();
}

function resolveIconPath() {
    const iconName = process.platform === "darwin" ? "iconTemplate.png" : "icon.ico";
    return app.isPackaged
        ? path.join(process.resourcesPath, "assets", iconName)
        : path.join(__dirname, "assets", iconName);
}

// ============================================================
//  3. CLIPBOARD  (Electron built-in — works in dev AND packaged)
// ============================================================
//
//  WHY THIS CHANGED:
//  clipboardy v4 is a pure ESM package. In a packaged Electron app,
//  dynamic import("clipboardy") fails because the asar virtual
//  filesystem does not support ESM module resolution the same way
//  Node.js does outside of asar. Electron's own `clipboard` API is
//  always available, synchronous, and requires zero packaging config.

function readClipboard() {
    // Synchronous — no async, no ESM, no packaging issues
    return electronClipboard.readText();
}

// ============================================================
//  4. OFFLINE QUEUE SYSTEM
// ============================================================

function loadQueueSilent() {
    // Internal version — no logging (used in self-test & flush to avoid noise)
    try {
        if (fs.existsSync(QUEUE_PATH)) {
            const raw    = fs.readFileSync(QUEUE_PATH, "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (_) {}
    return [];
}

function loadQueue() {
    try {
        if (fs.existsSync(QUEUE_PATH)) {
            const raw    = fs.readFileSync(QUEUE_PATH, "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                writeLog(`Queue loaded — ${parsed.length} pending item(s).`);
                return parsed;
            }
        }
    } catch (err) {
        writeLog(`QUEUE LOAD ERROR (resetting): ${err.message}`);
    }
    return [];
}

function saveQueue(queue) {
    try {
        fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2), "utf8");
    } catch (err) {
        writeLog(`QUEUE SAVE ERROR: ${err.message}`);
    }
}

function enqueue(payload) {
    const queue = loadQueueSilent();
    queue.push({ ...payload, queuedAt: new Date().toISOString() });
    saveQueue(queue);
    queueActive = true;
    updateTrayStatus();
    writeLog(`Request queued. Queue depth: ${queue.length}`);
}

async function flushQueue() {
    const queue = loadQueueSilent();
    if (queue.length === 0) {
        if (queueActive) {
            queueActive = false;
            updateTrayStatus();
        }
        return;
    }

    writeLog(`Flushing queue — ${queue.length} item(s) pending...`);
    const remaining = [];

    for (const item of queue) {
        const ok = await sendToApi(item, false); // no re-queueing during flush
        if (!ok) remaining.push(item);
    }

    saveQueue(remaining);
    queueActive = remaining.length > 0;
    updateTrayStatus();
    writeLog(`Queue flush complete — ${remaining.length} item(s) remaining.`);
}

// ============================================================
//  5. API RELIABILITY LAYER  (retry + exponential backoff)
// ============================================================

async function sendToApi(payload, allowQueue = true) {
    for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
        try {
            const response = await axios.post(API_URL, payload, {
                timeout: API_TIMEOUT
            });
            let logMsg = `API success (attempt ${attempt})`;
            if (response.data !== "duplicate_ignored") {
                logMsg += `: ${JSON.stringify(response.data)}`;
            }
            writeLog(logMsg);
            if (apiDegraded) {
                apiDegraded = false;
                updateTrayStatus();
            }
            return true;
        } catch (err) {
            const delay = Math.pow(2, attempt) * 500; // 1s → 2s → 4s
            writeLog(`API failure (attempt ${attempt}/${MAX_API_RETRIES}): ${err.message}. Retrying in ${delay}ms...`);
            if (attempt < MAX_API_RETRIES) {
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    apiDegraded = true;
    writeLog(`API UNREACHABLE after ${MAX_API_RETRIES} attempts. Payload queued.`);
    if (allowQueue) enqueue(payload);
    updateTrayStatus();
    return false;
}

// ============================================================
//  6. TRAY HEALTH INDICATOR
// ============================================================

function updateTrayStatus() {
    if (!tray) return;

    let status;
    if (!trackerActive) {
        status = "LinkedIn Tracker — Starting...";
    } else if (clipboardFailureCount > 5) {
        status = "LinkedIn Tracker — WARNING Clipboard Error";
    } else if (queueActive && apiDegraded) {
        status = "LinkedIn Tracker — OFFLINE (Queue Active)";
    } else if (queueActive) {
        status = "LinkedIn Tracker — Syncing Queue...";
    } else if (apiDegraded) {
        status = "LinkedIn Tracker — API Degraded";
    } else {
        status = "LinkedIn Tracker — Running";
    }

    try {
        tray.setToolTip(status);
    } catch (_) {}
}

function createTray() {
    tray = new Tray(resolveIconPath());

    const contextMenu = Menu.buildFromTemplate([
        {
            label: "Open Log File",
            click: () => shell.openPath(LOG_PATH)
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() }
    ]);

    tray.setContextMenu(contextMenu);
    updateTrayStatus();
    writeLog("System tray created.");
}

// ============================================================
//  7. CONFIG
// ============================================================

function loadConfig() {
    writeLog("Loading config...");
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
            if (!config.agent_name) throw new Error("agent_name missing in config");
            AGENT_NAME = config.agent_name;
            writeLog(`Config loaded. Agent: ${AGENT_NAME}`);
            return true;
        }
    } catch (err) {
        writeLog(`CONFIG LOAD ERROR: ${err.message}`);
    }
    return false;
}

// ============================================================
//  8. SETUP / ONBOARDING WINDOW  (UX unchanged)
// ============================================================

function createSetupWindow() {
    writeLog("Opening setup window...");

    const win = new BrowserWindow({
        width: 400,
        height: 250,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadURL(`data:text/html,
    <html>
      <body style="font-family:sans-serif; padding:30px;">
        <h2>Enter Your Name</h2>
        <input
          id="name"
          style="width:100%; padding:10px; font-size:16px;"
        />
        <button
          onclick="saveName()"
          style="margin-top:20px; padding:10px 20px;"
        >
          Save
        </button>
        <script>
          const { ipcRenderer } = require('electron');
          function saveName() {
            const name = document.getElementById('name').value;
            ipcRenderer.send('save-agent-name', name);
          }
        </script>
      </body>
    </html>`);

    win.on("closed", () => {
        // If the config hasn't been saved yet, we quit the app instead of staying in the background
        if (!AGENT_NAME) {
            writeLog("Setup window closed without configuration. Quitting app.");
            app.quit();
        }
    });
}

ipcMain.on("save-agent-name", (event, name) => {
    try {
        fs.writeFileSync(
            CONFIG_PATH,
            JSON.stringify({ agent_name: name }, null, 2),
            "utf8"
        );
        writeLog(`Onboarding complete. Agent name saved: ${name}`);
    } catch (err) {
        writeLog(`ONBOARDING SAVE ERROR: ${err.message}`);
    }
    app.relaunch();
    app.exit();
});

// ============================================================
//  9. CLIPBOARD POLLING  (hardened — sync, no async/ESM)
// ============================================================

function checkClipboard() {
    // Update heartbeat — watchdog uses this to detect stalls
    lastHeartbeatTime = Date.now();

    let text = "";
    try {
        text = readClipboard();
        clipboardFailureCount = 0; // reset streak on success
    } catch (err) {
        clipboardFailureCount++;
        // Log first failure and every 10th — no spam
        if (clipboardFailureCount === 1 || clipboardFailureCount % 10 === 0) {
            writeLog(`CLIPBOARD READ FAILURE (#${clipboardFailureCount}): ${err.message}`);
            updateTrayStatus();
        }
        return;
    }

    // Performance Optimization: Skip processing and log spam if the clipboard text hasn't changed.
    if (text === lastClipboard) {
        return;
    }
    lastClipboard = text;

    const cleanUrl = normalizeUrl(text);

    // ── LinkedIn profile URL (sets account context) ───────────
    if (/linkedin\.com\/in\//i.test(cleanUrl)) {
        currentLinkedInAccount = cleanUrl;
        writeLog(`Account set: ${currentLinkedInAccount}`);
        return;
    }

    // ── LinkedIn Recruiter inbox conversation URL ─────────────
    if (/linkedin\.com\/talent\/inbox\//i.test(cleanUrl)) {

        if (!currentLinkedInAccount) {
            writeLog("Conversation URL detected but no account context set yet — skipped.");
            return;
        }

        const now = Date.now();
        if (now - lastConversationLogTime < CONVERSATION_COOLDOWN) {
            writeLog("Cooldown active — conversation URL ignored.");
            return;
        }
        lastConversationLogTime = now;

        queriesReplied++;
        saveDailyCount(queriesReplied);
        writeLog(`Conversation detected: ${cleanUrl} | Total queries replied today: ${queriesReplied}`);

        // Fire-and-forget async send — does not block the polling loop
        const now_ts = new Date();
        sendToApi({
            agent:            AGENT_NAME,
            linkedin_account: currentLinkedInAccount,
            conversation_url: cleanUrl,
            date:             now_ts.toLocaleDateString("en-CA"),   // YYYY-MM-DD
            timestamp:        now_ts.toISOString()
        }).catch(err => writeLog(`sendToApi unhandled: ${err.message}`));
    }
}

// ============================================================
//  10. HEARTBEAT MONITORING
// ============================================================

function startHeartbeat() {
    setInterval(() => {
        writeLog(
            `HEARTBEAT — active=${trackerActive} | agent=${AGENT_NAME} ` +
            `| account=${currentLinkedInAccount || "none"} ` +
            `| queue=${queueActive} | apiDegraded=${apiDegraded}`
        );
    }, HEARTBEAT_INTERVAL);
    writeLog("Heartbeat monitor started (5 min interval).");
}

// ============================================================
//  11. WATCHDOG RECOVERY
// ============================================================

function startWatchdog() {
    setInterval(() => {
        const elapsed = Date.now() - lastHeartbeatTime;
        if (trackerActive && elapsed > WATCHDOG_INTERVAL) {
            writeLog(`WATCHDOG: Stall detected (${Math.round(elapsed / 1000)}s). Restarting polling...`);
            restartPolling();
        }
    }, WATCHDOG_INTERVAL);
    writeLog("Watchdog started (10 min stall threshold).");
}

function restartPolling() {
    if (clipboardIntervalId) {
        clearInterval(clipboardIntervalId);
        clipboardIntervalId = null;
    }
    lastHeartbeatTime   = Date.now();
    clipboardIntervalId = setInterval(checkClipboard, CLIPBOARD_INTERVAL);
    writeLog("Clipboard polling loop restarted by watchdog.");
}

// ============================================================
//  12. STARTUP SELF-TEST
// ============================================================

async function runStartupSelfTest() {
    writeLog("=== STARTUP SELF-TEST BEGIN ===");

    // 1. Clipboard — test a real read with the Electron API
    try {
        electronClipboard.readText();
        writeLog("  [OK] Clipboard: Electron built-in accessible.");
    } catch (err) {
        writeLog(`  [WARN] Clipboard: ${err.message}`);
    }

    // 2. Config presence
    const configExists = fs.existsSync(CONFIG_PATH);
    writeLog(`  [${configExists ? "OK" : "INFO"}] Config: ${configExists ? CONFIG_PATH : "not found — onboarding will run"}`);

    // 3. Queue (silent — no noisy "Queue loaded" log during self-test)
    const pending = loadQueueSilent();
    writeLog(`  [INFO] Pending queue: ${pending.length} item(s)`);

    // 4. API reachability (best-effort, non-blocking)
    try {
        await axios.get(API_URL, { timeout: 8000 });
        writeLog("  [OK] API: reachable");
        apiDegraded = false;
    } catch (err) {
        writeLog(`  [WARN] API: ${err.message} — will retry on first event`);
        apiDegraded = true;
    }

    writeLog("=== STARTUP SELF-TEST END ===");
}

// ============================================================
//  13. TRACKER STARTUP
// ============================================================

function startTracker() {
    createTray();
    trackerActive = true;
    updateTrayStatus();

    // Load persisted daily counter so we resume from where we left off
    queriesReplied = loadDailyCount();

    writeLog("=== TRACKER STARTED ===");
    writeLog(`Agent: ${AGENT_NAME} | Queries replied today so far: ${queriesReplied}`);

    // Clipboard polling — guard prevents duplicate intervals
    if (!clipboardIntervalId) {
        clipboardIntervalId = setInterval(checkClipboard, CLIPBOARD_INTERVAL);
    }

    // Queue retry
    setInterval(flushQueue, QUEUE_FLUSH_INTERVAL);

    // Reliability monitors
    startHeartbeat();
    startWatchdog();
}

// ============================================================
//  APP ENTRY POINT
// ============================================================

app.whenReady().then(async () => {
    writeLog("=== APP STARTING ===");
    writeLog(`Platform:  ${process.platform} | packaged: ${app.isPackaged}`);
    writeLog(`userData:  ${USER_DATA}`);
    writeLog(`log:       ${LOG_PATH}`);
    writeLog(`execPath:  ${process.execPath}`);

    // Auto-launch (fire-and-forget, non-fatal)
    autoLauncher.isEnabled()
        .then(isEnabled => {
            if (!isEnabled) {
                autoLauncher.enable();
                writeLog("Auto-launch enabled.");
            } else {
                writeLog("Auto-launch already enabled.");
            }
        })
        .catch(err => writeLog(`AUTO-LAUNCH CHECK ERROR: ${err.message}`));

    app.setAppUserModelId("LinkedIn Tracker");

    // Startup diagnostics
    await runStartupSelfTest();

    // Route: onboarding or tracker
    const configLoaded = loadConfig();
    if (!configLoaded) {
        createSetupWindow();
    } else {
        startTracker();
        // macOS specific optimization: Hide dock icon when running in the background/tray
        if (process.platform === "darwin" && app.dock) {
            app.dock.hide();
        }
    }
});

// FIX: `window-all-closed` does NOT receive a cancellable event.
// The correct pattern is to simply not call `app.quit()` here.
// The tray and its setInterval keep the Node event loop alive automatically.
app.on("window-all-closed", () => {
    // Intentionally empty — tray keeps app alive without any windows.
});

app.on("before-quit", () => {
    writeLog("=== APP SHUTTING DOWN ===");
});
