// E2E test for Hadouken Battle deployed on AWS CloudFront.
// Drives a full game: home -> char select (both players) -> multiple turns
// -> a winner is declared. Uses the pre-installed Chromium in the sandbox.
import { chromium } from 'playwright';
import assert from 'node:assert';

// Target site. Override with SITE_URL, e.g.
//   SITE_URL=https://xxxx.cloudfront.net/ node e2e/hadouken.e2e.mjs
const BASE = process.env.SITE_URL || 'https://ddurmbogk47n4.cloudfront.net/';
// Chromium executable. When installed via `npx playwright install chromium`
// this can be left unset; CHROME_PATH lets you point at an existing browser.
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

const consoleErrors = [];
const pageErrors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  check('page loads with HTTP 200', resp && resp.status() === 200);
  check('served over HTTPS', page.url().startsWith('https://'));

  await page.waitForSelector('#startBtn', { timeout: 10000 });
  check('title is "Hadouken Battle"', (await page.title()) === 'Hadouken Battle');

  // Home screen visible
  const homeShown = await page.$eval('#home', (el) => el.classList.contains('show'));
  check('home screen is shown on load', homeShown);

  // Title image (external asset) actually renders. It is loaded from an
  // external CDN, so give it time to finish decoding rather than checking
  // instantaneously.
  const titleOk = await page.waitForFunction(() => {
    const img = document.querySelector('.title-img');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check('title image (external asset) loaded', titleOk);

  // Start game
  await page.click('#startBtn');
  await page.waitForSelector('#charScreen.show', { timeout: 5000 });
  const p1Prompt = await page.textContent('#charPrompt');
  check('P1 character select prompt shown', /プレイヤー1/.test(p1Prompt));

  // Helper: select a character by data-id and confirm.
  async function pickChar(id) {
    await page.click(`.char-opt[data-id="${id}"]`);
    await page.waitForSelector('#charConfirmBtn:not([disabled])', { timeout: 3000 });
    await page.click('#charConfirmBtn');
  }

  // P1 picks hadou (波動拳: cost 3, 1 dmg, unguardable)
  await pickChar('hadou');
  await page.waitForFunction(() => document.querySelector('#charPrompt').textContent.includes('プレイヤー2'), null, { timeout: 5000 });
  check('advances to P2 character select', true);
  // P2 picks hadou too
  await pickChar('hadou');

  // Now in the turn loop. Helper to play one action for the current player.
  async function playAction(key) {
    await page.waitForSelector('#passScreen.show', { timeout: 5000 });
    await page.click('#passBtn');
    await page.waitForSelector('#selectScreen.show', { timeout: 5000 });
    // Click desired action; fall back to charge if unaffordable.
    const affordable = await page.$eval(`#actionButtons .action[data-key="${key}"]`,
      (el) => !el.classList.contains('unaffordable')).catch(() => false);
    const useKey = affordable ? key : 'charge';
    await page.click(`#actionButtons .action[data-key="${useKey}"]`);
    await page.waitForSelector('#selectConfirmBtn:not([disabled])', { timeout: 3000 });
    await page.click('#selectConfirmBtn');
    return useKey;
  }

  // Run the battle after both players chose; wait for either result or next-turn.
  async function runBattleAndAdvance() {
    await page.waitForSelector('#readyScreen.show', { timeout: 5000 });
    await page.click('#fightBtn');
    await page.waitForSelector('#battle.show', { timeout: 5000 });
    // Battle choreography takes several seconds; wait for outcome.
    await page.waitForFunction(() => {
      const result = document.querySelector('#result').classList.contains('show');
      const nextWrap = document.querySelector('#battleNextWrap').classList.contains('show');
      return result || nextWrap;
    }, null, { timeout: 30000 });
    const onResult = await page.$eval('#result', (el) => el.classList.contains('show'));
    if (onResult) return 'result';
    await page.click('#nextTurnBtn');
    return 'next';
  }

  // Read a player's HP (count of filled 🟢).
  async function hp(p) {
    return page.$eval(`#hp${p}`, (el) => el.querySelectorAll('span:not(.empty)').length);
  }

  let winnerReached = false;
  let sawDamage = false;
  const MAX_TURNS = 40;
  for (let turn = 1; turn <= MAX_TURNS && !winnerReached; turn++) {
    // P1: try 波動拳 (special) if affordable, else charge.
    const a1 = await playAction('special');
    // P2: always charge (so it just accumulates and takes hits).
    const a2 = await playAction('charge');
    const before2 = await hp(2);
    const phase = await runBattleAndAdvance();
    if (phase === 'result') { winnerReached = true; break; }
    const after2 = await hp(2);
    if (after2 < before2) sawDamage = true;
  }

  check('a damaging attack (波動拳) reduced opponent HP at least once', sawDamage);
  check('game reached a result screen (a winner) within turn budget', winnerReached);

  if (winnerReached) {
    const winnerText = await page.textContent('#winnerText');
    check('winner text is shown', /勝ち|引き分け/.test(winnerText));
    console.log('    winnerText =', JSON.stringify(winnerText));
    // Loser HP should be 0.
    const finalHp2 = await hp(2);
    check('losing player (P2) HP is 0', finalHp2 === 0);
    // Restart / home buttons present
    check('restart button present', await page.$('#restartBtn') !== null);
  }

  // Manifest & icon reachable from the deployed origin
  const manifestStatus = await page.evaluate(async (base) => {
    const r = await fetch(new URL('manifest.webmanifest', base).href);
    return r.status;
  }, BASE);
  check('manifest.webmanifest reachable (200)', manifestStatus === 200);

  check('no uncaught page errors', pageErrors.length === 0);
  if (pageErrors.length) console.log('  pageErrors:', pageErrors);
  // Console errors: allow none (report them for visibility)
  if (consoleErrors.length) console.log('  consoleErrors:', consoleErrors);
  check('no console errors', consoleErrors.length === 0);

  const shotPath = process.env.SCREENSHOT_PATH || 'hadouken-result.png';
  await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n==== E2E summary: ${passed}/${results.length} checks passed ====`);
if (passed !== results.length) process.exitCode = 1;
