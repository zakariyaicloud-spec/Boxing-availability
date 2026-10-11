// Checks each clinic's online booking system for free BCR1 / boxing medical
// slots over the next 30 days and writes availability.json for the website.
// Runs a few times a day from .github/workflows/check.yml.
//
// If a clinic can't be read on a run, its previous times are kept with their
// old "checked" time; the website stops showing times older than 12 hours.
const { chromium } = require('playwright');
const fs = require('fs');

const DAYS_AHEAD = 30;
const OUT = 'availability.json';
const DEBUG = 'debug';
fs.mkdirSync(DEBUG, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
function londonNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const NOW = londonNow();
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const LAST_DAY = addDays(NOW.date, DAYS_AHEAD);
const inRange = (iso, time) => iso >= NOW.date && iso <= LAST_DAY && (iso > NOW.date || (time || '99:99') > NOW.time);

function addSlot(days, iso, time) {
  if (!inRange(iso, time)) return;
  (days[iso] = days[iso] || []);
  if (!days[iso].includes(time)) days[iso].push(time);
}
function tidy(days) {
  const o = {};
  Object.keys(days).sort().forEach((k) => { if (days[k].length) o[k] = days[k].sort(); });
  return o;
}

// ---------------------------------------------------------------- Just Health
// Their booking site has a plain JSON feed: available dates, then slots per date.
const JUST_HEALTH = [
  { id: 'jh-burnley', clinic: 2 },
  { id: 'jh-dewsbury', clinic: 55 },
  { id: 'jh-edgbaston', clinic: 16 },
];
async function justHealth() {
  const base = 'https://booking.just-health.co.uk/book';
  const res = {};
  for (const c of JUST_HEALTH) {
    try {
      const svc = await (await fetch(`${base}/location-services?clinic_location_id=${c.clinic}`)).json();
      const all = [].concat(...Object.values(svc).filter(Array.isArray));
      const s = all.find((x) => /boxing/i.test(x.slug || x.name));
      if (!s) throw new Error('No boxing service listed at this clinic');
      const dates = (await (await fetch(`${base}/available-dates?clinic_location_id=${c.clinic}&service_id=${s.id}`)).json()).dates || [];
      const days = {};
      for (const d of dates.filter((d) => d >= NOW.date && d <= LAST_DAY)) {
        const j = await (await fetch(`${base}/slots?clinic_location_id=${c.clinic}&date=${d}&service_id=${s.id}`)).json();
        (j.slots || []).forEach((x) => addSlot(days, d, x.time));
        await sleep(300);
      }
      res[c.id] = { ok: true, days: tidy(days) };
    } catch (e) { res[c.id] = { ok: false, error: String(e.message || e) }; }
  }
  return res;
}

// ---------------------------------------------------------------- Dr4D4 (Amelia)
// Amelia's slots feed. Note: online booking only lists "Professional Boxing Medical",
// so these are that doctor's free times; amateur BCR1 bookings are confirmed by phone.
const DR4D4 = [
  { id: 'd4-radcliffe', location: 1 },
  { id: 'd4-chorlton', location: 3 },
  { id: 'd4-levenshulme', location: 20 },
  { id: 'd4-shaw', location: 8 },
  { id: 'd4-rochdale', location: 16 },
  { id: 'd4-rusholme', location: 24 },
  { id: 'd4-victoria', location: 23 },
];
function collectDateTimes(node, onSlot, ctx) {
  // Walk any JSON shape and pick out {"YYYY-MM-DD": {"HH:MM": [...]}} structures.
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [t, info] of Object.entries(v)) if (/^\d{2}:\d{2}$/.test(t)) onSlot(k, t, info);
    } else collectDateTimes(v, onSlot, ctx);
  }
}
async function dr4d4(browser) {
  const res = {};
  const page = await browser.newPage();
  try {
    await page.goto('https://dr4d4.com/book-appointment/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const ent = await page.evaluate(async () => {
      const r = await fetch('/wp-admin/admin-ajax.php?action=wpamelia_api&call=/entities&types=employees,categories,locations&page=booking&lite=true');
      return r.json();
    });
    const data = ent.data || {};
    const services = [].concat(...(data.categories || []).map((c) => c.serviceList || []));
    const svc = services.find((s) => /amateur.*box|box.*amateur|bcr1/i.test(s.name)) || services.find((s) => /^professional boxing medical$/i.test(s.name)) || services.find((s) => /box/i.test(s.name));
    if (!svc) throw new Error('No boxing service found');
    const providers = (data.employees || []).filter((e) => (e.serviceList || []).some((s) => s.id === svc.id)).map((e) => e.id);
    fs.writeFileSync(`${DEBUG}/dr4d4-service.json`, JSON.stringify({ svc: { id: svc.id, name: svc.name, duration: svc.duration, price: svc.price }, providers }, null, 1));
    for (const c of DR4D4) {
      try {
        const qs = new URLSearchParams({ action: 'wpamelia_api', call: '/slots', serviceId: svc.id, serviceDuration: svc.duration || '', locationId: c.location, providerIds: providers.join(','), extras: '[]', excludeAppointmentId: '', group: '1', page: 'booking', persons: '1', monthsLoad: '2', queryTimeZone: 'Europe/London' });
        const raw = await page.evaluate(async (u) => (await fetch(u)).text(), '/wp-admin/admin-ajax.php?' + qs.toString());
        fs.writeFileSync(`${DEBUG}/dr4d4-${c.id}.txt`, raw.slice(0, 20000));
        const j = JSON.parse(raw);
        const days = {};
        collectDateTimes(j.data && (j.data.slots || j.data), (d, t, info) => {
          // Slot info is usually a list of [providerId, locationId, ...]; keep slots at this location.
          const list = Array.isArray(info) ? info : [];
          const here = !list.length || list.some((x) => Array.isArray(x) ? x.includes(c.location) || x[1] === c.location || x[1] == null : true);
          if (here) addSlot(days, d, t);
        });
        res[c.id] = { ok: true, days: tidy(days), service: svc.name };
      } catch (e) { res[c.id] = { ok: false, error: String(e.message || e) }; }
      await sleep(500);
    }
  } catch (e) {
    DR4D4.forEach((c) => { res[c.id] = { ok: false, error: String(e.message || e) }; });
  }
  await page.close();
  return res;
}

// ---------------------------------------------------------------- Simply Medicals (Bookly)
// Bookly is a step-by-step form: pick the location, go to the time step, read the slots.
const SIMPLY = [
  { id: 'sm-oldbury', match: /^oldbury/i },
  { id: 'sm-droitwich', match: /^droitwich/i },
  // Garretts Green, West Bromwich and Willenhall don't open a time step for boxing
  // medicals online, so they stay "request a time" on the website.
];
function parseBookly(html, days) {
  // Each free time is a button whose value holds "YYYY-MM-DD HH:MM:SS".
  const btn = /<button[^>]*class="[^"]*bookly-hour[^"]*"[^>]*>/g;
  let m;
  while ((m = btn.exec(html))) {
    const tag = m[0];
    if (/disabled|bookly-slot-booked/.test(tag)) continue;
    const dt = tag.replace(/&quot;/g, '"').match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}/);
    if (dt) addSlot(days, dt[1], dt[2]);
  }
}
async function simply(browser) {
  const res = {};
  for (const c of SIMPLY) {
    const page = await browser.newPage();
    const htmls = [];
    page.on('response', async (r) => {
      if (/admin-ajax\.php/.test(r.url())) {
        try { const t = await r.text(); if (/bookly-hour|bookly-time-step|bookly-columnizer/.test(t)) htmls.push(JSON.parse(t).html || t); } catch (e) {}
      }
    });
    try {
      await page.goto('https://www.simplymedicals.co.uk/boxing-medical/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const sel = page.locator('.bookly-form select').first();
      await sel.waitFor({ timeout: 30000 });
      const opts = await sel.locator('option').allTextContents();
      const label = opts.find((o) => c.match.test(o.trim()));
      if (!label) throw new Error('Location not offered for boxing medicals');
      await sel.selectOption({ label: label.trim() });
      await page.waitForTimeout(1000);
      for (let step = 0; step < 3 && !htmls.length; step++) {
        await page.locator('.bookly-form .bookly-js-next-step >> visible=true').first().click({ timeout: 15000 });
        await page.waitForTimeout(6000);
      }
      // The time step shows a month calendar. Click each open day (this month and next)
      // and collect the times shown for it.
      let formHtml = '';
      for (let month = 0; month < 2; month++) {
        const open = page.locator('.bookly-form .bookly-calendar-dates-mark div.bookly-calendar-current-month-mark[disabled="false"]');
        const n = await open.count();
        for (let i = 0; i < n; i++) {
          await open.nth(i).click({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2500);
          formHtml += await page.locator('.bookly-form').first().innerHTML().catch(() => '');
        }
        const right = page.locator('.bookly-form .bookly-calendar-right-button-mark >> visible=true').first();
        if (!(await right.count())) break;
        await right.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(5000);
      }
      formHtml += await page.locator('.bookly-form').first().innerHTML().catch(() => '');
      fs.writeFileSync(`${DEBUG}/simply-${c.id}.html`, (htmls.join('\n<!-- next -->\n') + '\n<!-- form -->\n' + formHtml).slice(0, 300000));
      const days = {};
      htmls.forEach((h) => parseBookly(h, days));
      parseBookly(formHtml, days);
      if (!htmls.length && !/bookly-hour/.test(formHtml)) throw new Error('Time step did not load');
      res[c.id] = { ok: true, days: tidy(days) };
    } catch (e) { res[c.id] = { ok: false, error: String(e.message || e).split('\n')[0] }; }
    await page.close();
    await sleep(1500);
  }
  return res;
}

// ---------------------------------------------------------------- Hanover Mayfair (Wix Bookings)
// Open the booking calendar, copy the auth the page uses, then ask Wix for each day's slots.
const HANOVER = [
  { id: 'hm-mayfair', url: 'https://www.hanovermayfairclinic.com/booking-calendar/amateur-boxing-new-medical' },
];
async function hanover(browser) {
  const res = {};
  for (const c of HANOVER) {
    const page = await browser.newPage();
    try {
      const firstReq = page.waitForRequest((r) => /service-availability\/v2\/time-slots/.test(r.url()), { timeout: 60000 });
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const req = await firstReq;
      const headers = req.headers();
      const body = JSON.parse(req.postData() || '{}');
      const keep = {};
      ['authorization', 'x-wix-brand', 'commonconfig', 'content-type', 'x-wix-client-artifact-id', 'x-wix-linguist'].forEach((k) => { if (headers[k]) keep[k] = headers[k]; });
      const days = {};
      for (let i = 0; i <= DAYS_AHEAD; i++) {
        const d = addDays(NOW.date, i);
        const q = { serviceId: body.serviceId, fromLocalDate: `${d}T00:00:00`, toLocalDate: `${d}T23:59:59`, timeZone: 'Europe/London', includeNonBookable: false, shouldReturnAllResources: true };
        const r = await page.request.post('https://www.hanovermayfairclinic.com/_api/service-availability/v2/time-slots', { headers: keep, data: q });
        if (!r.ok()) throw new Error('Wix returned ' + r.status());
        const j = await r.json();
        (j.timeSlots || []).forEach((s) => { if (s.bookable !== false && (s.remainingCapacity == null || s.remainingCapacity > 0)) { const [dd, tt] = s.localStartDate.split('T'); addSlot(days, dd, tt.slice(0, 5)); } });
        await sleep(250);
      }
      res[c.id] = { ok: true, days: tidy(days) };
    } catch (e) { res[c.id] = { ok: false, error: String(e.message || e).split('\n')[0] }; }
    await page.close();
  }
  return res;
}

// ---------------------------------------------------------------- Run
(async () => {
  let prev = { clinics: {} };
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: 'en-GB', timezoneId: 'Europe/London', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });
  const results = {};
  for (const [name, fn] of [['Just Health', justHealth], ['Dr4D4', () => dr4d4(ctx)], ['Simply Medicals', () => simply(ctx)], ['Hanover', () => hanover(ctx)]]) {
    try { Object.assign(results, await fn()); } catch (e) { console.error(name, 'failed:', e); }
  }
  await browser.close();

  const stamp = new Date().toISOString();
  const clinics = { ...(prev.clinics || {}) };
  const summary = [];
  for (const [id, r] of Object.entries(results)) {
    if (r.ok) {
      clinics[id] = { checked: stamp, days: r.days };
      const n = Object.values(r.days).reduce((a, b) => a + b.length, 0);
      summary.push(`OK    ${id}: ${Object.keys(r.days).length} days, ${n} times`);
    } else {
      if (clinics[id]) clinics[id].lastError = r.error;
      summary.push(`FAIL  ${id}: ${r.error}`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ updated: stamp, clinics }, null, 1));
  fs.writeFileSync(`${DEBUG}/last-run.txt`, `Run at ${stamp}\n` + summary.join('\n') + '\n');
  console.log(summary.join('\n'));
})();
