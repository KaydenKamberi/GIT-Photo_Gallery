#!/usr/bin/env node
//
// Smoke test. Run before every push:  node scripts/smoke.js
//
// FROZEN FILE — see CONTRACTS.md. Do not edit while parallel work is in
// progress; ask the repo owner if you need a change here.
//
// This project has no unit tests and no type checking, so this script is the
// only thing standing between three agents and a silently broken main. It
// checks plumbing and response shapes, never AI output quality, so it needs
// no GROQ_API_KEY and calls Groq zero times.
//
// Checks belonging to unimplemented phases report PENDING and do not fail the
// run. That way the script is green from day one and gets stricter on its own
// as each phase lands.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT || 3001;
const BASE = `http://localhost:${PORT}`;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const results = [];
function pass(name, detail) { results.push({ state: 'PASS', name, detail }); }
function fail(name, detail) { results.push({ state: 'FAIL', name, detail }); }

// PENDING: a phase nobody has built yet. Expected, not a problem.
function pending(name, detail) { results.push({ state: 'PENDING', name, detail }); }

// SKIPPED: we could not run the check at all, so we do not know whether it
// passes. That is NOT the same as passing, and the run is not green. Set
// SMOKE_ALLOW_NO_BROWSER=1 to acknowledge it deliberately.
function skipped(name, detail) { results.push({ state: 'SKIPPED', name, detail }); }

async function get(pathname) {
  const response = await fetch(BASE + pathname);
  let body = null;
  try { body = await response.json(); } catch (e) { /* not JSON */ }
  return { status: response.status, body };
}

async function post(pathname, payload) {
  const response = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await response.json(); } catch (e) { /* not JSON */ }
  return { status: response.status, body };
}

// --- Static files and manifest integrity -----------------------------------

async function checkStatic() {
  for (const file of ['index.html', 'image.html', 'flowers.json']) {
    const response = await fetch(`${BASE}/${file}`);
    if (response.ok) pass(`GET /${file}`);
    else fail(`GET /${file}`, 'status ' + response.status);
  }
}

function checkManifest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'flowers.json'), 'utf8'));
  const dir = manifest.imageDir || 'Images';
  const listed = [];
  let broken = 0;

  for (const color of manifest.colors) {
    for (const flower of color.flowers) {
      listed.push(flower.file);
      if (!fs.existsSync(path.join(ROOT, dir, flower.file))) {
        fail('manifest: file on disk', flower.file + ' is listed but missing');
        broken++;
      }
      if (!flower.name || !flower.alt) {
        fail('manifest: metadata', flower.file + ' is missing name or alt');
        broken++;
      }
    }
  }

  const onDisk = fs.readdirSync(path.join(ROOT, dir));
  for (const file of onDisk) {
    if (!listed.includes(file)) {
      fail('manifest: unlisted image', file + ' is on disk but not in flowers.json');
      broken++;
    }
  }

  if (!broken) pass('manifest matches disk', listed.length + ' flowers');
}

function checkBouquetSchema() {
  const feedPath = path.join(ROOT, 'bouquets.json');
  if (!fs.existsSync(feedPath)) {
    fail('bouquets.json exists', 'file is missing');
    return;
  }

  const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  if (!Array.isArray(feed.bouquets)) {
    fail('bouquets.json schema', 'expected a "bouquets" array');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'flowers.json'), 'utf8'));
  const valid = new Set(manifest.colors.flatMap(c => c.flowers.map(f => f.file)));
  const required = ['id', 'name', 'question', 'occasion', 'flowers', 'reason', 'createdAt'];
  let broken = 0;

  for (const bouquet of feed.bouquets) {
    for (const field of required) {
      if (bouquet[field] === undefined) {
        fail('bouquet schema', `${bouquet.id || '?'} is missing "${field}"`);
        broken++;
      }
    }
    if (!Array.isArray(bouquet.flowers) || bouquet.flowers.length < 2 || bouquet.flowers.length > 3) {
      fail('bouquet picks', `${bouquet.id} must have 2-3 flowers`);
      broken++;
    } else {
      // The contract's most important rule: a stored bouquet never references
      // a flower that isn't in the gallery.
      for (const file of bouquet.flowers) {
        if (!valid.has(file)) {
          fail('bouquet picks', `${bouquet.id} references unknown flower "${file}"`);
          broken++;
        }
      }
    }
  }

  if (!broken) pass('bouquets.json schema', feed.bouquets.length + ' entries');
}

// --- Endpoints -------------------------------------------------------------

async function checkDescribe() {
  // Phase 1 flips this from { imageUrl } to { file }. Detect which contract is
  // live rather than hardcoding one, so this passes across the transition.
  //
  // Probe with a VALID filename: the old contract 400s on it (no imageUrl),
  // the new one accepts it. A rejected filename is useless as a probe because
  // both contracts 400 on it, for different reasons.
  const probe = await post('/api/describe-image', { file: 'red-roses.jpeg' });

  const missing = await post('/api/describe-image', {});
  if (missing.status === 400) pass('describe: rejects empty body');
  else fail('describe: rejects empty body', 'got ' + missing.status);

  if (probe.status === 400) {
    pending('describe: { file } contract', 'still on the old { imageUrl } contract — Agent A, Phase 1');
    return;
  }

  // Without an API key this should report configuration, not crash.
  if ([200, 500, 502].includes(probe.status)) pass('describe: valid file handled', 'status ' + probe.status);
  else fail('describe: valid file handled', 'unexpected status ' + probe.status);

  const traversal = await post('/api/describe-image', { file: '../server.js' });
  if (traversal.status === 400) pass('describe: rejects non-gallery file');
  else fail('describe: rejects non-gallery file', 'got ' + traversal.status);

  const invented = await post('/api/describe-image', { file: 'white-lily.jpeg' });
  if (invented.status === 400) pass('describe: rejects unlisted flower');
  else fail('describe: rejects unlisted flower', 'got ' + invented.status);
}

async function checkBouquetsEndpoint() {
  const response = await get('/api/bouquets');
  if (response.status !== 200) {
    fail('GET /api/bouquets', 'status ' + response.status);
    return;
  }
  if (!response.body || !Array.isArray(response.body.bouquets)) {
    fail('GET /api/bouquets', 'expected { bouquets: [...] }');
    return;
  }
  pass('GET /api/bouquets', response.body.bouquets.length + ' entries');
}

async function checkRecommend() {
  const response = await post('/api/recommend', { question: 'flowers for a wedding' });

  if (response.status === 501) {
    pending('POST /api/recommend', 'not implemented — Agent B, Phase 2');
    return;
  }

  // Once implemented, enforce the full contract.
  const tooLong = await post('/api/recommend', { question: 'x'.repeat(101) });
  if (tooLong.status === 400) pass('recommend: rejects over-long question');
  else fail('recommend: rejects over-long question', 'got ' + tooLong.status);

  const empty = await post('/api/recommend', { question: '' });
  if (empty.status === 400) pass('recommend: rejects empty question');
  else fail('recommend: rejects empty question', 'got ' + empty.status);

  if (response.status === 200) {
    const { bouquet, reused } = response.body || {};
    if (typeof reused !== 'boolean') {
      fail('recommend: response shape', 'missing boolean "reused"');
    } else if (!bouquet || !Array.isArray(bouquet.flowers)) {
      fail('recommend: response shape', 'missing bouquet.flowers');
    } else {
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'flowers.json'), 'utf8'));
      const valid = new Set(manifest.colors.flatMap(c => c.flowers.map(f => f.file)));
      const bogus = bouquet.flowers.filter(f => !valid.has(f));
      if (bogus.length) fail('recommend: picks are real flowers', 'invented: ' + bogus.join(', '));
      else if (bouquet.flowers.length < 2 || bouquet.flowers.length > 3) {
        fail('recommend: pick count', 'expected 2-3, got ' + bouquet.flowers.length);
      } else {
        pass('recommend: returns a valid bouquet', bouquet.name || '');
      }
    }
  } else if ([500, 502].includes(response.status)) {
    // No API key in CI is fine; the endpoint still has to fail cleanly.
    if (response.body && response.body.error) pass('recommend: fails cleanly without a key', 'status ' + response.status);
    else fail('recommend: fails cleanly without a key', 'no error field');
  } else {
    fail('POST /api/recommend', 'unexpected status ' + response.status);
  }
}

// --- Browser ---------------------------------------------------------------

async function checkBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (error) {
    skipped('browser checks', 'playwright not installed');
    return;
  }

  const launchOptions = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    skipped('browser checks', 'could not launch chromium: ' + error.message.split('\n')[0]);
    return;
  }

  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });

    const cards = await page.$$eval('.card', els => els.length);
    const sections = await page.$$eval('.color-section', els => els.length);
    if (cards === 9 && sections === 3) pass('gallery renders', '3 sections, 9 cards');
    else fail('gallery renders', `expected 3 sections / 9 cards, got ${sections} / ${cards}`);

    const brokenImages = await page.$$eval('.card img', imgs => imgs.filter(i => !i.naturalWidth).length);
    if (!brokenImages) pass('gallery images load');
    else fail('gallery images load', brokenImages + ' broken');

    // Phase 3: the sidebar. Absent until Agent C builds it.
    const sidebar = await page.$('#sidebar, .sidebar');
    if (!sidebar) {
      pending('sidebar present', 'not built yet — Agent C, Phase 3');
    } else {
      pass('sidebar present');
      const toggle = await page.$('#sidebarToggle, .sidebar-toggle');
      if (toggle) pass('sidebar toggle present');
      else fail('sidebar toggle present', 'no toggle control found');

      const entries = await page.$$eval('.bouquet-entry', els => els.length).catch(() => 0);
      if (entries > 0) pass('feed renders', entries + ' entries');
      else fail('feed renders', 'no .bouquet-entry elements');
    }

    // Detail page
    await page.goto(BASE + '/image.html?file=red-roses.jpeg', { waitUntil: 'networkidle' });
    const heading = await page.textContent('#flowerName').catch(() => '');
    if ((heading || '').trim() === 'Red Roses') pass('detail page resolves flower');
    else fail('detail page resolves flower', 'heading was "' + heading + '"');

    const imageOk = await page.$eval('#displayImage', i => i.naturalWidth > 0).catch(() => false);
    if (imageOk) pass('detail image loads');
    else fail('detail image loads', 'image did not load');

    await page.goto(BASE + '/image.html?file=not-a-real-flower.jpeg', { waitUntil: 'networkidle' });
    const rejected = await page.textContent('#captionDisplay').catch(() => '');
    if (/not in the gallery/i.test(rejected || '')) pass('detail page rejects unknown file');
    else fail('detail page rejects unknown file', 'got "' + rejected + '"');

    if (errors.length) fail('no uncaught page errors', errors.join(' | '));
    else pass('no uncaught page errors');
  } finally {
    await browser.close();
  }
}

// --- Runner ----------------------------------------------------------------

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => reject(new Error('server did not start within 10s')), 10000);
    child.stdout.on('data', data => {
      if (data.toString().includes('Server running')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function main() {
  let server = null;
  try {
    server = await startServer();

    checkManifest();
    checkBouquetSchema();
    await checkStatic();
    await checkDescribe();
    await checkBouquetsEndpoint();
    await checkRecommend();
    await checkBrowser();
  } catch (error) {
    fail('smoke run', error.message);
  } finally {
    if (server) server.kill();
  }

  const MARKS = { PASS: '  ok  ', FAIL: ' FAIL ', PENDING: ' pend ', SKIPPED: ' SKIP ' };
  const width = Math.max(...results.map(r => r.name.length));
  console.log('');
  for (const result of results) {
    console.log(`${MARKS[result.state]} ${result.name.padEnd(width)}  ${result.detail || ''}`);
  }

  const failed = results.filter(r => r.state === 'FAIL').length;
  const pendingCount = results.filter(r => r.state === 'PENDING').length;
  const skippedCount = results.filter(r => r.state === 'SKIPPED').length;
  const passed = results.filter(r => r.state === 'PASS').length;

  console.log('');
  console.log(`${passed} passed, ${failed} failed, ${pendingCount} pending, ${skippedCount} skipped`);

  // A skipped check is not a passing check. Browser checks cover the whole
  // front end, including the sidebar, so treating "could not run them" as
  // green would let broken UI through claiming a clean test.
  const acknowledged = process.env.SMOKE_ALLOW_NO_BROWSER === '1';

  if (failed) {
    console.log('\nSmoke test FAILED — do not push.');
  } else if (skippedCount && !acknowledged) {
    console.log(`
Smoke test INCOMPLETE — ${skippedCount} check(s) could not run, so the front
end was never verified. This is not a pass.

Install the browser and re-run:

  npm i --no-save playwright && npx playwright install chromium
  npm run smoke

If you genuinely cannot install it and are only changing backend code, you
can acknowledge the gap explicitly:

  SMOKE_ALLOW_NO_BROWSER=1 npm run smoke

Do not do that if you touched index.html or image.html.`);
  } else {
    let message = '\nSmoke test green.';
    if (pendingCount) message += ' (Pending checks are unbuilt phases, not failures.)';
    if (skippedCount) message += `\nWARNING: ${skippedCount} browser check(s) skipped and explicitly acknowledged — the front end was NOT verified.`;
    console.log(message);
  }

  process.exit(failed || (skippedCount && !acknowledged) ? 1 : 0);
}

main();
