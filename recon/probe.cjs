// S0 probe: loaded via NODE_OPTIONS=--require into whatever process honors it.
// Writes a marker file proving main-process code execution, then logs every
// web-contents-created (page/webview/iframe structure of the client).
const fs = require('fs');
const path = require('path');
const out = process.env.EARS_PROBE_OUT;
if (!out) { /* not a probe run */ }
else {
  try {
    let electronInfo = 'require-failed';
    try {
      const electron = require('electron');
      electronInfo = { hasApp: !!electron.app, hasWebContents: !!electron.webContents };
    } catch (e) { electronInfo = 'ERR:' + e.message; }
    fs.writeFileSync(out, JSON.stringify({
      pid: process.pid, ppid: process.ppid,
      type: process.type || '(none)',
      node: process.versions.node,
      electron: process.versions.electron || '?',
      chrome: process.versions.chrome || '?',
      execPath: process.execPath,
      argv0: process.argv0,
      argv: process.argv.slice(0, 4),
      electronInfo,
      t: new Date().toISOString(),
    }, null, 1));
    const electron = require('electron');
    if (electron.app) {
      const wc = electron.webContents;
      const log = (o) => fs.appendFileSync(out, '\n' + JSON.stringify(o));
      log({ note: 'existing webContents', list: wc.getAllWebContents().map(w => ({ id: w.id, type: w.getType(), url: (w.getURL() || '').slice(0, 100) })) });
      electron.app.on('web-contents-created', (e, w) => {
        try {
          log({ created: w.id, type: w.getType(), url: (w.getURL() || '').slice(0, 120) });
          w.on('did-navigate', (ev, url) => log({ nav: w.id, url: (url || '').slice(0, 120) }));
          w.on('did-attach-webview', (ev, guest) => log({ webviewAttached: guest.id, url: (guest.getURL() || '').slice(0, 120) }));
        } catch (err) { log({ probeErr: err.message }); }
      });
    }
  } catch (e) {
    try { fs.appendFileSync(out, '\nFATAL ' + e.stack); } catch (_) {}
  }
}
