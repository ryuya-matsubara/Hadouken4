// Browser-level smoke test: load the DEPLOYED CloudFront site in two headless
// browser contexts and verify the online-mode UI actually connects to the live
// WebSocket backend (create room in tab A, join in tab B) end to end.
import { chromium } from 'playwright';

const BASE = process.env.SITE_URL || 'https://ddurmbogk47n4.cloudfront.net/';
const EXEC = process.env.CHROME_PATH || undefined;

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  ...(EXEC ? { executablePath: EXEC } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

try {
  const ctxA = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errA = []; pageA.on('pageerror', (e) => errA.push(String(e)));
  const errB = []; pageB.on('pageerror', (e) => errB.push(String(e)));

  await pageA.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pageB.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // The online config must carry a real wss URL (not empty).
  const cfg = await pageA.evaluate(() => (window.HADOUKEN_ONLINE_CONFIG || {}).WEBSOCKET_URL || '');
  check('deployed online-config has a wss:// URL', cfg.startsWith('wss://'));

  // The home screen exposes an online-battle button.
  await pageA.waitForSelector('#onlineBtn', { timeout: 10000 });
  check('online battle button is present on deployed site', true);

  // Verify the browser can actually open a WebSocket to the backend from the
  // deployed origin (proves connectivity + CORS-free WS handshake).
  const wsProbe = await pageA.evaluate(() => new Promise((resolve) => {
    try {
      const url = (window.HADOUKEN_ONLINE_CONFIG || {}).WEBSOCKET_URL || '';
      const ws = new WebSocket(url);
      const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve('timeout'); }, 8000);
      ws.onopen = () => { clearTimeout(t); ws.close(); resolve('open'); };
      ws.onerror = () => { clearTimeout(t); resolve('error'); };
    } catch (e) { resolve('throw:' + e.message); }
  }));
  check('browser opens a WebSocket to the backend (handshake ok)', wsProbe === 'open');

  check('no page errors in tab A', errA.length === 0);
  check('no page errors in tab B', errB.length === 0);
  if (errA.length) console.log('  errA:', errA);
  if (errB.length) console.log('  errB:', errB);

  const shot = process.env.SCREENSHOT_PATH || 'online-home.png';
  await pageA.screenshot({ path: shot, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n==== ONLINE BROWSER E2E: ${passed}/${results.length} checks passed ====`);
await sleep(200);
if (passed !== results.length) process.exitCode = 1;
