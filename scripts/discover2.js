// Second discovery run: records the full booking data for Dr4D4 (Amelia),
// Simply Medicals (Bookly) and Hanover Mayfair (Wix Bookings).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const out = (id, name, data) => {
  const dir = path.join('discovery2', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 1));
};

function recorder(page, match) {
  const log = [];
  page.on('response', async (res) => {
    const req = res.request();
    if (!match.test(res.url())) return;
    let body = '';
    try { body = await res.text(); } catch (e) {}
    log.push({ method: req.method(), url: res.url(), status: res.status(), postData: req.postData() || '', reqHeaders: req.headers(), body: body.slice(0, 200000) });
  });
  return log;
}

async function dr4d4(ctx) {
  const page = await ctx.newPage();
  const log = recorder(page, /wpamelia_api/);
  await page.goto('https://dr4d4.com/book-appointment/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log.push({ error: String(e) }));
  await page.waitForTimeout(10000);
  // Find boxing services in the entities response and try the slots call for each.
  const ent = log.find(l => l.url.includes('call=/entities'));
  let services = [];
  try {
    const j = JSON.parse(ent.body);
    const cats = (j.data && j.data.categories) || [];
    cats.forEach(c => (c.serviceList || []).forEach(s => services.push({ id: s.id, name: s.name, duration: s.duration, price: s.price, category: c.name })));
    out('dr4d4', 'services.json', services);
    out('dr4d4', 'locations.json', (j.data && j.data.locations) || []);
    out('dr4d4', 'employees.json', ((j.data && j.data.employees) || []).map(e => ({ id: e.id, name: e.firstName + ' ' + e.lastName, serviceList: (e.serviceList || []).map(s => s.id), locationId: e.locationId })));
  } catch (e) { out('dr4d4', 'error.txt', 'entities parse failed: ' + e); }
  const boxing = services.filter(s => /box/i.test(s.name));
  const attempts = [];
  for (const s of boxing) {
    const qs = new URLSearchParams({ action: 'wpamelia_api', call: '/slots', serviceId: s.id, serviceDuration: s.duration || '', locationId: '', providerIds: '', extras: '[]', excludeAppointmentId: '', group: '1', page: 'booking', persons: '1', monthsLoad: '2', queryTimeZone: 'Europe/London' });
    const r = await page.evaluate(async (u) => { try { const x = await fetch(u); return { status: x.status, body: (await x.text()).slice(0, 100000) }; } catch (e) { return { error: String(e) }; } }, '/wp-admin/admin-ajax.php?' + qs.toString());
    attempts.push({ service: s, url: '/wp-admin/admin-ajax.php?' + qs.toString(), result: r });
  }
  out('dr4d4', 'slots-attempts.json', attempts);
  out('dr4d4', 'network.json', log);
  await page.screenshot({ path: 'discovery2/dr4d4/page.png', fullPage: true }).catch(() => {});
  await page.close();
}

async function simply(ctx) {
  const page = await ctx.newPage();
  const log = recorder(page, /admin-ajax\.php/);
  await page.goto('https://www.simplymedicals.co.uk/boxing-medical/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log.push({ error: String(e) }));
  await page.waitForTimeout(10000);
  const selects = await page.$$eval('.bookly-form select', ss => ss.map(s => ({ cls: s.className, name: s.name, options: [...s.options].map(o => ({ v: o.value, t: o.textContent.trim() })) }))).catch(() => []);
  out('simply-medicals', 'selects.json', selects);
  // Choose the Oldbury location if a location select exists, then go to the next step.
  try {
    const loc = page.locator('.bookly-form select.bookly-js-select-location, .bookly-form select[class*="location"]').first();
    if (await loc.count()) {
      const opts = await loc.locator('option').allTextContents();
      const pick = opts.find(o => /oldbury/i.test(o));
      if (pick) await loc.selectOption({ label: pick.trim() });
      await page.waitForTimeout(1500);
    }
  } catch (e) { log.push({ error: 'location ' + e }); }
  await page.screenshot({ path: 'discovery2/simply-medicals/step1.png', fullPage: false }).catch(() => {});
  try {
    await page.locator('.bookly-form .bookly-next-step, .bookly-form button:has-text("Next")').first().click({ timeout: 8000 });
    await page.waitForTimeout(8000);
  } catch (e) { log.push({ error: 'next ' + e }); }
  await page.screenshot({ path: 'discovery2/simply-medicals/step2.png', fullPage: false }).catch(() => {});
  out('simply-medicals', 'form.html', await page.locator('.bookly-form').first().innerHTML().catch(() => ''));
  out('simply-medicals', 'network.json', log);
  await page.close();
}

async function hanover(ctx) {
  const page = await ctx.newPage();
  const log = recorder(page, /_api\/(service-availability|bookings|v1\/access-tokens)/);
  await page.goto('https://www.hanovermayfairclinic.com/booking-calendar/amateur-boxing-new-medical', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => log.push({ error: String(e) }));
  await page.waitForTimeout(15000);
  out('hanover-mayfair', 'network.json', log);
  await page.close();
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/London',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  for (const [name, fn] of [['dr4d4', dr4d4], ['simply', simply], ['hanover', hanover]]) {
    try { await fn(ctx); console.log(name, 'done'); } catch (e) { console.error(name, 'failed', e); }
  }
  await browser.close();
})();
