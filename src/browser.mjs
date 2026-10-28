import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AdapterError } from './errors.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VENDOR = path.join(ROOT, 'vendor', 'abox');
const ORIGIN = 'http://127.0.0.1:48371';

export async function findBrowser() {
  const configured = process.env.ABOX_BROWSER_PATH;
  const candidates = configured ? [configured] : [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Stable Chrome has the sandbox helper and Ubuntu AppArmor profile its package installs.
    '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate); return candidate; } catch { /* Try another installed browser. */ }
  }
  return null;
}

export async function withBrowser(work, { signal, wasm = false, workers = false, pdfjs = false } = {}) {
  const executablePath = await findBrowser();
  if (!executablePath) throw new AdapterError('BROWSER_NOT_FOUND', 'Install Edge, Chrome, or Chromium, or set ABOX_BROWSER_PATH to its absolute executable path.');
  const { chromium } = await import('playwright-core');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath, headless: true, chromiumSandbox: true,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'],
      timeout: 30000,
    });
  } catch {
    throw new AdapterError('BROWSER_LAUNCH_FAILED', 'The installed browser could not start with its sandbox enabled. Check the browser installation and OS sandbox support, or select a working installation with ABOX_BROWSER_PATH.');
  }
  const abort = () => { void browser.close().catch(() => {}); };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 120000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, offline: true });
    // Every browser request is either a bundled module fulfilled from disk or aborted.
    // No listener is opened, and user files are never exposed at an HTTP address.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN || route.request().method() !== 'GET') return route.abort('blockedbyclient');
      if (url.pathname === '/') {
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'content-security-policy': `default-src 'none'; script-src 'self'${wasm ? " 'wasm-unsafe-eval'" : ''}; worker-src ${workers || pdfjs ? "'self' blob:" : "'none'"}; img-src blob: data:; connect-src ${pdfjs ? "'self'" : "'none'"}; font-src ${pdfjs ? 'blob: data:' : "'none'"}; base-uri 'none'; form-action 'none'` },
          body: '<!doctype html><meta charset="utf-8"><title>abox.tools local adapter</title><input id="input" type="file">',
        });
      }
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { return route.abort(); }
      if (pdfjs && decoded.startsWith('/pdfjs/')) {
        const relative = decoded.slice('/pdfjs/'.length);
        // Only the pinned renderer's executable modules and passive font/CMap
        // assets are exposed. A PDF never chooses a local filesystem path.
        if (!/^(?:legacy\/build\/pdf(?:\.worker)?\.mjs|standard_fonts\/[a-zA-Z0-9_.-]+\.(?:otf|pfb|ttf)|cmaps\/[a-zA-Z0-9_.-]+\.bcmap)$/.test(relative)) return route.abort();
        const base = path.join(ROOT, 'node_modules', 'pdfjs-dist');
        const file = path.resolve(base, relative);
        if (path.relative(base, file).startsWith('..')) return route.abort();
        try { return await route.fulfill({ contentType: relative.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream', body: await readFile(file) }); }
        catch { return route.abort(); }
      }
      if (!decoded.startsWith('/vendor/abox/') || !decoded.endsWith('.js')) return route.abort();
      const file = path.resolve(ROOT, `.${decoded}`);
      const relative = path.relative(VENDOR, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return route.abort();
      try { return await route.fulfill({ contentType: 'text/javascript', body: await readFile(file) }); }
      catch { return route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    await page.goto(`${ORIGIN}/`);
    return await work(page);
  } catch (error) {
    if (timedOut) throw new AdapterError('OPERATION_TIMEOUT', 'Image processing exceeded the two-minute limit.');
    signal?.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await browser.close();
  }
}
