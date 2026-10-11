// Discovery run: opens each clinic's booking page in a real browser and records
// how the page loads its appointment times (network requests + JSON responses),
// so we can write an exact checker for each clinic. Results go in discovery/.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGETS = [
  { id: 'just-health-edgbaston', url: 'https://booking.just-health.co.uk/book?ser=boxing-medical-england-boxing-bcr1&clinic=16' },
  { id: 'dr4d4', url: 'https://dr4d4.com/book-appointment/' },
  { id: 'simply-medicals', url: 'https://www.simplymedicals.co.uk/book-an-appointment-new/' },
  { id: 'hanover-mayfair', url: 'https://www.hanovermayfairclinic.com/booking-calendar/amateur-boxing-new-medical' },
];

const SKIP = /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css)(\?|$)|google-analytics|googletagmanager|facebook|doubleclick|hotjar|clarity\.ms/i;

async function run(browser, t) {
  const dir = path.join('discovery', t.id);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'en-GB', timezoneId: 'Europe/London',
  });
  const page = await ctx.newPage();
  const log = [];
  page.on('request', (r) => {
    if (SKIP.test(r.url())) return;
    if (['xhr', 'fetch', 'document', 'script'].includes(r.resourceType())) {
      log.push({ kind: 'request', type: r.resourceType(), method: r.method(), url: r.url(), postData: (r.postData() || '').slice(0, 3000), headers: r.headers() });
    }
  });
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (SKIP.test(res.url()) || !['xhr', 'fetch'].includes(req.resourceType())) return;
      const ct = res.headers()['content-type'] || '';
      const body = await res.text();
      log.push({ kind: 'response', status: res.status(), url: res.url(), contentType: ct, body: body.slice(0, 8000) });
    } catch (e) { /* ignore */ }
  });
  const frames = [];
  try {
    await page.goto(t.url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) { log.push({ kind: 'error', step: 'goto', message: String(e) }); }
  await page.waitForTimeout(8000);
  // Record any embedded booking iframes
  for (const f of page.frames()) frames.push(f.url());
  await page.screenshot({ path: path.join(dir, 'page-1.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(dir, 'page.html'), await page.content().catch(() => ''));
  // Try a few gentle clicks that usually reveal times: a service/boxing option, then a date.
  const clickTries = [
    'text=/boxing/i',
    'button:has-text("Next")', 'text=/next available/i',
    '[class*="day"]:not([class*="disabled"]) >> nth=10',
    'button[aria-label*="2026"] >> nth=0',
  ];
  for (const sel of clickTries) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ timeout: 4000 }); log.push({ kind: 'click', selector: sel }); await page.waitForTimeout(4000); }
    } catch (e) { log.push({ kind: 'click-failed', selector: sel }); }
  }
  await page.screenshot({ path: path.join(dir, 'page-2.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify({ url: t.url, frames, log }, null, 1));
  await ctx.close();
  console.log(t.id, 'requests logged:', log.length, 'frames:', frames.length);
}

(async () => {
  const browser = await chromium.launch();
  for (const t of TARGETS) {
    try { await run(browser, t); } catch (e) { console.error(t.id, 'failed', e); }
  }
  await browser.close();
})();
