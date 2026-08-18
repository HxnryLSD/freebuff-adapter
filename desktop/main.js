'use strict'

/**
 * Freebuff Adapter — desktop shell.
 *
 * A thin Electron wrapper around the daemon:
 *  1. auto-starts `src/index.js` as a child process (same env/config),
 *  2. waits for /healthz,
 *  3. opens the monochrome dark UI in its own window,
 *  4. shuts the daemon down gracefully (POST /api/shutdown) on quit.
 *
 * If a daemon is already listening on the port, the shell just attaches to it
 * and does not take ownership (no shutdown on quit in that case).
 *
 * Usage:
 *   cd desktop && npm install && npm start
 *   npm start -- --screenshot shot.png   # capture the UI and exit (CI/verify)
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const { ensureIcon } = require('./icon')
// electron-updater (not Electron's built-in autoUpdater — this one supports
// GitHub Releases + NSIS differential updates). Only active when packaged;
// dev runs (npm start) never touch it.
const { autoUpdater } = require('electron-updater')

const HOST = process.env.HOST || process.env.FREEBUFF_HOST || '127.0.0.1'
// Sanitize: an ambient/empty/invalid PORT (e.g. "0") must not pick a random
// listen port that the health check then can't find.
function resolvePort() {
  const raw = process.env.PORT || process.env.FREEBUFF_PORT || '8899'
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 8899
}
const PORT = resolvePort()
// Dev: the daemon + UI live at the repo root (../src, ../ui). Packaged: the
// build ships them unpacked under resources/daemon (see `extraResources` in
// package.json) so the spawned child can read them — a Node process cannot
// read files inside app.asar.
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'daemon')
  : path.join(__dirname, '..')
const DAEMON_JS = path.join(ROOT, 'src', 'index.js')
// Packaged builds run the daemon on Electron's bundled Node runtime
// (ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as plain Node), so
// the installed app needs no separate Node.js on the user's machine. Dev runs
// use the system `node`.
const NODE = app.isPackaged ? process.execPath : 'node'
const NODE_ENV = app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}
const ICON_PATH = path.join(__dirname, 'icon.png')

const screenshotPath = (() => {
  const i = process.argv.indexOf('--screenshot')
  return i >= 0 ? process.argv[i + 1] : null
})()

let daemon = null // child process we spawned (null when we only attached)
let win = null
let shuttingDown = false

const log = (...args) => console.log('[shell]', ...args)

// ---- daemon discovery / lifecycle ----------------------------------------

function checkHealth(timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const attempt = () => {
      const req = http.get(
        { host: HOST, port: PORT, path: '/healthz', timeout: 1000 },
        (res) => {
          res.resume()
          if (res.statusCode === 200) resolve(true)
          else retry()
        },
      )
      req.on('error', retry)
      req.on('timeout', () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) resolve(false)
      else setTimeout(attempt, 400)
    }
    attempt()
  })
}

function startDaemon() {
  log(`starting daemon: ${NODE === 'node' ? 'node ' : ''}${path.relative(ROOT, DAEMON_JS)} on ${HOST}:${PORT}`)
  const child = spawn(NODE, [DAEMON_JS], {
    cwd: ROOT,
    env: { ...process.env, ...NODE_ENV, PORT: String(PORT), HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  daemon = child
  child.stdout.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) if (line) log('daemon', line)
  })
  child.stderr.on('data', (d) => {
    for (const line of d.toString().trim().split('\n')) if (line) log('daemon ERR', line)
  })
  child.on('error', (err) => {
    log('failed to spawn daemon runtime:', err.message)
    if (app.isReady()) {
      dialog.showErrorBox(
        'Freebuff Adapter',
        `Could not start the daemon: ${err.message}\n\nThe desktop app bundles its own Node.js runtime, so this is unexpected.`,
      )
    }
  })
  child.on('exit', (code, signal) => {
    log(`daemon exited (code=${code} signal=${signal})`)
    daemon = null
    if (!shuttingDown && app.isReady()) {
      dialog.showErrorBox(
        'Freebuff Adapter',
        `The daemon exited unexpectedly (code ${code}).\n\nCommon causes: port ${PORT} already in use (set PORT=...), or the Freebuff backend is unreachable.`,
      )
      app.quit()
    }
  })
}

/** Graceful daemon shutdown via its admin endpoint (releases the session). */
function requestShutdown(cb) {
  const req = http.request(
    { host: HOST, port: PORT, path: '/api/shutdown', method: 'POST', timeout: 3000 },
    (res) => {
      res.resume()
      res.on('end', cb)
    },
  )
  req.on('error', cb)
  req.on('timeout', () => {
    req.destroy()
    cb()
  })
  req.end()
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  const finish = () => app.exit(0)
  if (daemon) {
    // We own the daemon: ask it to stop gracefully (session release), with a
    // force-kill fallback so the shell never hangs on quit.
    requestShutdown(() => setTimeout(finish, 400))
    setTimeout(() => {
      if (daemon) {
        log('graceful shutdown timed out — killing daemon')
        daemon.kill()
      }
      finish()
    }, 4000)
  } else {
    finish()
  }
}

// ---- auto-update (electron-updater, packaged builds only) ----------------

let updateCheckedManually = false

/** Forward an updater event to the UI (it renders the progress card/toast). */
function sendUpdater(evt) {
  if (win && !win.isDestroyed()) win.webContents.send('updater:event', evt)
}

/**
 * Wire the GitHub Releases updater. Only called when app.isPackaged: dev
 * builds have no app-update.yml and must not hit the network for updates.
 * Checks silently on startup (auto-download), prompts to restart once the
 * new version is downloaded, and exposes a manual check via the File menu.
 */
function setupAutoUpdater() {
  // FREEBUFF_UPDATER_DEV=1 lets dev runs exercise the full event → IPC → UI
  // path (they fail fast with an app-update.yml error instead of checking
  // the network). Normal dev runs never touch the updater.
  if (!app.isPackaged && !process.env.FREEBUFF_UPDATER_DEV) return

  // Dev runs have no app-update.yml, so the check fails fast — exactly what
  // the hook wants (it exercises the full event → IPC → UI path).
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m) => log('updater:', m),
    warn: (m) => log('updater warn:', m),
    error: (m) => log('updater ERR:', m),
    debug: (m) => log('updater debug:', m),
  }

  autoUpdater.on('error', (err) => {
    log('update check failed:', err.message)
    sendUpdater({ type: 'error', message: err.message })
    if (updateCheckedManually && win) {
      dialog.showErrorBox('Freebuff Adapter', `Could not check for updates:\n${err.message}`)
    }
    updateCheckedManually = false
  })

  autoUpdater.on('update-available', (info) => {
    log(`update available: v${info.version} — downloading`)
    sendUpdater({ type: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    log('no update available')
    sendUpdater({ type: 'not-available', manual: updateCheckedManually })
    if (updateCheckedManually && win) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Freebuff Adapter',
        message: 'You are up to date.',
        detail: `v${app.getVersion()} is the latest version.`,
        buttons: ['OK'],
      })
    }
    updateCheckedManually = false
  })

  autoUpdater.on('download-progress', (p) => {
    sendUpdater({
      type: 'progress',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
    })
    if (p.percent % 25 < 2) log(`update download: ${Math.round(p.percent)}%`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log(`update downloaded: v${info.version}`)
    if (win && !win.isDestroyed()) {
      // The UI shows a ready-to-install toast with a Restart button.
      sendUpdater({ type: 'downloaded', version: info.version })
      return
    }
    // No live window — fall back to a dialog so the update isn't silent.
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Freebuff Adapter',
        message: `Version v${info.version} is ready to install.`,
        detail: 'Restart now to apply the update.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
      .catch(() => {})
  })

  // UI "RESTART NOW" button → quit and install the downloaded update.
  ipcMain.on('updater:quit-and-install', () => {
    if (app.isPackaged) autoUpdater.quitAndInstall()
  })

  // Check shortly after startup so the window is up and the daemon is warm.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log('update check failed:', err.message))
  }, 5000)
}

/** Manual "Check for Updates…" — surfaces results via dialog. */
function checkForUpdates() {
  if (!app.isPackaged) {
    if (win) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Freebuff Adapter',
        message: 'Updates only work in installed builds.',
        detail: 'Run the installer or portable exe to enable auto-updates.',
        buttons: ['OK'],
      })
    }
    return
  }
  updateCheckedManually = true
  autoUpdater.checkForUpdates().catch((err) => {
    updateCheckedManually = false
    log('update check failed:', err.message)
  })
}

// ---- window --------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    title: 'Freebuff Adapter',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.once('ready-to-show', () => win.show())
  win.loadURL(`http://${HOST}:${PORT}`)
  // Ad clicks and other target=_blank links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-finish-load', () => {
    win.webContents
      .executeJavaScript(
        'document.title + " | " + (document.querySelector(".brand")?.textContent || "")',
      )
      .then((t) => log('UI loaded:', t))
      .catch(() => {})
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('UI failed to load:', code, desc)
  })
  win.on('closed', () => {
    win = null
  })
}

async function screenshotAndExit() {
  try {
    await new Promise((r) => setTimeout(r, 2000)) // let SSE hydrate the page
    const image = await win.webContents.capturePage()
    fs.writeFileSync(screenshotPath, image.toPNG())
    log('screenshot saved to', screenshotPath)
  } catch (err) {
    log('screenshot failed:', err.message)
  }
  app.quit()
}

// ---- app ------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
          { label: 'Check for Updates…', click: () => checkForUpdates() },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
    ]),
  )

  app.whenReady().then(async () => {
    ensureIcon() // best-effort: ships in the package, so normally a no-op
    setupAutoUpdater()
    const alreadyUp = await checkHealth(2000)
    if (alreadyUp) {
      log(`daemon already running on ${HOST}:${PORT} — attaching (shell does not own it)`)
    } else {
      startDaemon()
      const up = await checkHealth(30_000)
      if (!up) {
        dialog.showErrorBox(
          'Freebuff Adapter',
          `The daemon did not become ready on ${HOST}:${PORT}.\n\nThe desktop app bundles its own Node.js runtime, so this is unexpected — check that the port is free and the Freebuff backend is reachable.`,
        )
        app.exit(1)
        return
      }
      log('daemon is ready')
    }
    createWindow()
    if (screenshotPath) {
      screenshotAndExit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', shutdown)
  app.on('before-quit', (e) => {
    if (!shuttingDown) {
      e.preventDefault()
      shutdown()
    }
  })
}
