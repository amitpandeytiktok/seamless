// Regenerate the README screenshot: boot the real server, render the dashboard
// offscreen in Electron's Chromium, and save a PNG to docs/screenshot.png. Also
// serves as an end-to-end smoke test of the full desktop stack.
// Run with: npx electron scripts/shoot.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server/server.js';

app.commandLine.appendSwitch('no-proxy-server');
app.disableHardwareAcceleration();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'docs', 'screenshot.png');
const PORT = 4399;

app.whenReady().then(async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const win = new BrowserWindow({
    width: 1360,
    height: 2000,
    show: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(2);
  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/?static`);
  } catch (e) {
    console.log('LOAD_ERR', e.message);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  const sz = fs.statSync(OUT).size;
  console.log('SHOT_OK', sz, 'bytes ->', OUT);
  app.quit();
});

setTimeout(() => {
  console.log('TIMEOUT');
  app.quit();
}, 25000);
