'use strict'

/**
 * Freebuff Adapter — preload bridge.
 *
 * The daemon UI is a remote page (http://127.0.0.1:PORT), so it can't
 * require('electron') itself. This preload runs in that page's context and
 * exposes a minimal, read-only updater API through the contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('freebuffUpdater', {
  /** Subscribe to updater events ({ type, ... }). Returns an unsubscribe fn. */
  onEvent(cb) {
    const listener = (_event, payload) => cb(payload)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  },
  /** Ask the main process to quit and install the downloaded update. */
  quitAndInstall() {
    ipcRenderer.send('updater:quit-and-install')
  },
})
