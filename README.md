# LinkedIn Tracker

A lightweight desktop app that automatically tracks LinkedIn Recruiter activity — clipboard-based, offline-resilient, and runs silently in your system tray.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![Electron](https://img.shields.io/badge/electron-30-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

---

## 📥 Download

Grab the latest installer for your platform from the **[Releases](../../releases/latest)** page:

| Platform | File | Type |
|----------|------|------|
| **Windows** | `LinkedIn Tracker Setup x.x.x.exe` | Installer (NSIS) |
| **macOS** | `LinkedIn Tracker-x.x.x-arm64.dmg` | Disk Image |

> **Note:** On macOS, you may need to right-click → Open the first time to bypass Gatekeeper.

---

## 🚀 Installation

### Windows
1. Download `LinkedIn Tracker Setup x.x.x.exe` from [Releases](../../releases/latest)
2. Run the installer — choose your install directory
3. The app launches automatically and sits in the system tray

### macOS
1. Download `LinkedIn Tracker-x.x.x-arm64.dmg` from [Releases](../../releases/latest)
2. Open the DMG and drag **LinkedIn Tracker** into Applications
3. Launch from Applications — it will appear in your menu bar

---

## ⚙️ How It Works

LinkedIn Tracker runs in the background and monitors your clipboard for LinkedIn URLs:

1. **Copy a LinkedIn profile URL** (`linkedin.com/in/...`) → sets the active account context
2. **Copy a Recruiter inbox conversation URL** (`linkedin.com/talent/inbox/...`) → logs the interaction with timestamp, agent name, and account
3. Data is sent to a Google Sheets backend via Apps Script API
4. If the network is down, events are **queued offline** and synced automatically when connectivity resumes

### Key Features

- 🔄 **Auto-launch** — starts with your OS
- 📋 **Clipboard monitoring** — polls every 3 seconds
- 🌐 **Offline queue** — never lose data, even without internet
- 🔁 **Retry with exponential backoff** — up to 3 retries per API call
- 💓 **Heartbeat & watchdog** — self-healing if the polling loop stalls
- 🖥️ **System tray** — runs silently, shows health status on hover
- 📊 **Daily counter** — tracks queries replied per day, persisted across restarts

---

## 🛠️ Build from Source

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- npm (comes with Node.js)

### Setup
```bash
git clone https://github.com/Akshat-wor/linkedin-tracker.git
cd linkedin-tracker
npm install
```

### Run in Development
```bash
npm start
```

### Build Installers

**macOS (DMG):**
```bash
npm run dist:mac
```

**Windows (EXE):**
```bash
npm run dist -- --win
```

**Both platforms:**
```bash
npm run dist
```

> Built installers appear in the `dist/` directory.

---

## 📁 Project Structure

```
linkedin-tracker/
├── main.js            # Electron main process (all app logic)
├── package.json       # Dependencies & electron-builder config
├── assets/
│   ├── icon.png       # macOS app icon
│   ├── icon.ico       # Windows app icon
│   └── iconTemplate.png  # macOS tray icon (template image)
└── dist/              # Build output (not tracked in git)
```

---

## 🔐 Configuration

On first launch, the app prompts for your **agent name**. This is stored locally at:

- **Windows:** `%APPDATA%/linkedin-tracker/config.json`
- **macOS:** `~/Library/Application Support/linkedin-tracker/config.json`

---

## 📄 License

[MIT](LICENSE) © Faisal
