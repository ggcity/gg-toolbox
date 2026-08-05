/*
 * GG QR — dynamic QR redirect + scan counter, on Firebase.
 *
 * A tracked QR encodes  https://<host>/q/CODE .  Every scan is counted here
 * and 302-redirected to the stored destination.  Each code has a private
 * STATS LINK ( /s/TOKEN ) — a page showing the scan count, with a form to
 * re-point the QR later.  Whoever has the stats link owns the code; there
 * are no accounts or passwords.  A recovery directory lives at /qradmin,
 * protected by the city's Keycloak SSO (see the OIDC block below) plus the
 * OIDC_ADMIN_USERS allow-list.
 *
 * The same SSO session also soft-gates the staff toolbox site: /login starts
 * the flow for any city account, /api/session lets the static pages probe the
 * cookie, and the writing APIs (POST /api/qr create, POST /api/stats) require
 * a session.  Resident-facing scan/stats routes stay public.
 *
 * This is the Firebase port of the old server/q.php.  The flat JSON file is
 * replaced by a Firestore collection ("qrLinks", one doc per code) and the
 * flock read-modify-write by atomic FieldValue.increment(), so concurrent
 * scans can't lose counts.  All reads/writes go through the Admin SDK, so
 * Firestore security rules deny every direct client access (see
 * firestore.rules) — the stats token is the only key to a code.
 */
'use strict';

const {onRequest} = require('firebase-functions/v2/https');
const {defineString, defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

admin.initializeApp();
const db = admin.firestore();
// Subpath import instead of `admin.firestore.FieldValue`: the functions
// emulator's admin-SDK proxy drops the statics on the firestore namespace,
// so the old form crashed every counted scan under `firebase emulators` —
// identical class in production.
const {FieldValue} = require('firebase-admin/firestore');

const COLLECTION = 'qrLinks';
// Global usage counters shown live on the tool pages. One well-known doc,
// publicly *readable* (see firestore.rules) so the pages can subscribe with
// onSnapshot; every write still goes through this function (Admin SDK).
const STATS_DOC = ['stats', 'counters'];
// POST /api/stats {tool, n} increments one of these — the client-side tools
// (compress/format/merge happen entirely in the browser) report their wins.
const STATS_TOOLS = {
  compressor: 'imagesCompressed',
  formatter: 'imagesFormatted',
  merger: 'pdfsMerged',
  qr: 'qrGenerated',
};
// The two dynamic-QR counters are maintained server-side in the scan/create
// paths below — clients can't inflate those.
const STATS_FIELDS = Object.values(STATS_TOOLS).concat(['dynamicQrCreated', 'dynamicQrScans']);
function statsRef() {
  return db.collection(STATS_DOC[0]).doc(STATS_DOC[1]);
}
// Client-side ambient Tetris animation (same one as the QR generator), read
// once at cold start and injected into the stats/admin pages by pageBottom().
const TETRIS_JS = fs.readFileSync(path.join(__dirname, 'client-tetris.js'), 'utf8');
const KEEP_DAYS = 180;                 // per-day counts kept this long (totals kept forever)
// Public origin the printed QR short-links (/q/…) and stats links (/s/…) are
// built on — a neutral domain residents see instead of the internal toolbox
// host. Empty → fall back to the request's own host (functions/.env).
const PUBLIC_BASE = defineString('QR_PUBLIC_BASE', {default: ''});
// Where a scan of an unknown/removed code goes, so a retired printed QR still
// lands somewhere legitimate instead of a dead 404 (functions/.env).
const FALLBACK_URL = defineString('QR_FALLBACK_URL', {default: 'https://www.ggcity.org'});

/* ── helpers ────────────────────────────────────────────────────────────── */

// URL-safe, no look-alike characters (no 0/O/1/l/I) — matches the old q.php.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function randomId(len) {
  const crypto = require('crypto');
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

const TZ = 'America/Los_Angeles';                 // Garden Grove local time

// YYYY-MM-DD in Garden Grove local time — the days-map key.
function ggDay(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
// YYYY-MM-DD HH:MM:SS in Garden Grove local time (was UTC before).
function fmtStamp(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
// How long a code has been live, from its created timestamp — for the admin list.
function daysActive(ts) {
  if (!ts || !ts.toDate) return '';
  const d = Math.max(0, Math.floor((Date.now() - ts.toDate().getTime()) / 86400000));
  return d === 0 ? 'today' : d + (d === 1 ? ' day' : ' days');
}
// Month key "YYYY-MM" in Garden Grove time — the unbounded monthly rollup that
// lets a years-long campaign keep its history after daily counts are pruned.
function ggMonth(d) {
  const p = new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit'})
    .formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return p.year + '-' + p.month;
}
// Adaptive activity chart. The window and granularity grow with the campaign:
//   ≤ 20 days  → 14 daily bars
//   ≤ 133 days → weekly bars (rolling 7-day buckets, from the daily map)
//   older      → monthly bars (from the never-pruned monthly rollup)
// so a code that runs for weeks, months, or years always reads clearly.
function buildChart(created, days, months) {
  const now = Date.now();
  const createdMs = (created && created.toDate) ? created.toDate().getTime() : now;
  const ageDays = Math.max(0, Math.floor((now - createdMs) / 86400000));
  const dm = (dt) => new Intl.DateTimeFormat('en-US', {timeZone: TZ, month: 'short', day: 'numeric'}).format(dt);
  const bars = [];
  let unit;

  if (ageDays <= 20) {
    unit = 'days';
    const dayFmt = (dt) => new Intl.DateTimeFormat('en-US',
      {timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric'}).format(dt);
    for (let i = 13; i >= 0; i--) {
      const dt = new Date(now - i * 86400000);
      bars.push({n: days[ggDay(dt)] || 0, label: i === 0 ? 'Today' : dayFmt(dt)});
    }
  } else if (ageDays <= 133) {
    unit = 'weeks';
    const count = Math.min(19, Math.max(4, Math.ceil((ageDays + 1) / 7)));
    const monShort = (dt) => new Intl.DateTimeFormat('en-US', {timeZone: TZ, month: 'short'}).format(dt);
    const dayNum = (dt) => new Intl.DateTimeFormat('en-US', {timeZone: TZ, day: 'numeric'}).format(dt);
    for (let i = count - 1; i >= 0; i--) {
      const end = new Date(now - i * 7 * 86400000);
      const start = new Date(end.getTime() - 6 * 86400000);
      let sum = 0;
      for (let k = 0; k < 7; k++) sum += days[ggDay(new Date(end.getTime() - k * 86400000))] || 0;
      const label = monShort(start) === monShort(end) ?
        monShort(start) + ' ' + dayNum(start) + '–' + dayNum(end) :
        dm(start) + ' – ' + dm(end);
      bars.push({n: sum, label: i === 0 ? 'This week · ' + label : label});
    }
  } else {
    unit = 'months';
    const cur = ggMonth(new Date(now)).split('-');
    const baseIdx = parseInt(cur[0], 10) * 12 + (parseInt(cur[1], 10) - 1);
    const count = Math.min(24, Math.max(5, Math.ceil((ageDays + 1) / 30)));
    for (let i = count - 1; i >= 0; i--) {
      const idx = baseIdx - i;
      const yy = Math.floor(idx / 12);
      const mm = (idx % 12) + 1;
      const key = yy + '-' + String(mm).padStart(2, '0');
      const label = new Intl.DateTimeFormat('en-US',
        {timeZone: 'UTC', month: 'short', year: 'numeric'}).format(new Date(Date.UTC(yy, mm - 1, 1)));
      bars.push({n: (months && months[key]) || 0, label: i === 0 ? 'This month · ' + label : label});
    }
  }
  return {bars, caption: 'last ' + bars.length + ' ' + unit};
}
function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return proto + '://' + host;
}
// Base for the resident-facing short/stats links: the configured neutral
// domain if set, else whatever host this request arrived on.
function publicBase(req) {
  const b = PUBLIC_BASE.value();
  return b ? b.replace(/\/+$/, '') : originOf(req);
}
function shortUrl(req, code) {
  return publicBase(req) + '/q/' + code;
}
function statsUrl(req, token) {
  return publicBase(req) + '/s/' + token;
}
function isHttpUrl(s) {
  return /^https?:\/\//i.test(s || '');
}

// Link-preview unfurlers and crawlers hit the short link when it's shared in
// chat/email — those must not inflate the scan count. On a plain server q.php
// keyed this off the HTTP method (previews send HEAD), but Firebase Hosting
// rewrites a HEAD into a GET before it reaches the function, so that signal is
// gone. Instead we match the well-known bot/unfurler User-Agents (the same
// approach every URL shortener uses) plus the browser prefetch/preview hints.
const BOT_RE = /(bot\b|crawler|spider|facebookexternalhit|facebot|slackbot|whatsapp|telegrambot|discordbot|twitterbot|linkedinbot|embedly|iframely|pinterest|redditbot|applebot|bingbot|googlebot|yandex|baiduspider|skypeuripreview|vkshare|flipboard|nuzzel|bitlybot|curl|wget|python-requests|okhttp|libwww|go-http-client|headlesschrome)/i;
function isPreviewRequest(req, method) {
  if (method === 'HEAD') return true;
  const ua = String(req.headers['user-agent'] || '');
  if (BOT_RE.test(ua)) return true;
  const purpose = String(
    req.headers['sec-purpose'] || req.headers['purpose'] || req.headers['x-purpose'] || '');
  return /prefetch|preview/i.test(purpose);
}
function h(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}
function sendJson(res, status, data) {
  res.set('Access-Control-Allow-Origin', '*');
  res.status(status).json(data);
}

async function findByToken(token) {
  if (!token) return null;
  const q = await db.collection(COLLECTION).where('token', '==', token).limit(1).get();
  return q.empty ? null : q.docs[0];
}

/* ── OIDC admin sign-on (city Keycloak, internal realm) ──────────────────────
 * /qradmin is protected by the city SSO instead of a shared ?key= secret.
 * There is no httpd/mod_auth_openidc in front of Firebase, so this function
 * runs the standard authorization-code flow (with PKCE) itself:
 *   GET /qradmin (no session) → 302 to Keycloak → GET /oauth2-callback
 *   → exchange code for tokens → signed session cookie → back to /qradmin.
 * Notes:
 *   - Firebase Hosting forwards ONLY the cookie named "__session" to
 *     functions, so the in-flight login state and the session both live there
 *     (one at a time), HMAC-signed with a key derived from the client secret.
 *   - The ID token comes straight from the token endpoint over TLS, so per
 *     OIDC Core §3.1.3.7 its claims are validated without a JWKS signature
 *     check — keeps the function dependency-free.
 */
const OIDC_ISSUER = defineString('OIDC_ISSUER', {default: 'https://auth.ggcity.org/realms/internal'});
const OIDC_CLIENT_ID = defineString('OIDC_CLIENT_ID', {default: ''});
const OIDC_CLIENT_SECRET = defineSecret('OIDC_CLIENT_SECRET');   // Cloud Secret Manager
// Optional comma-separated allow-list of AD usernames (preferred_username)
// admitted to /qradmin. Empty = any signed-in city user ("Require valid-user").
const OIDC_ADMIN_USERS = defineString('OIDC_ADMIN_USERS', {default: ''});

const SESSION_COOKIE = '__session';        // the only cookie Hosting forwards
const SESSION_HOURS = 8;
const CALLBACK_PATH = '/oauth2-callback';

function oidcReady() {
  return Boolean(OIDC_CLIENT_ID.value() && OIDC_CLIENT_SECRET.value());
}

// Endpoint metadata from the realm's discovery URL, cached for the instance.
let oidcMeta = null;
async function oidcDiscover() {
  if (!oidcMeta) {
    const url = OIDC_ISSUER.value().replace(/\/+$/, '') + '/.well-known/openid-configuration';
    const r = await fetch(url);
    if (!r.ok) throw new Error('OIDC discovery failed: HTTP ' + r.status);
    oidcMeta = await r.json();
  }
  return oidcMeta;
}

function sessionCookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === SESSION_COOKIE) return part.slice(i + 1);
  }
  return '';
}
function setSessionCookie(res, value, maxAgeSec) {
  res.set('Set-Cookie', SESSION_COOKIE + '=' + value + '; Max-Age=' + maxAgeSec +
    '; Path=/; HttpOnly; Secure; SameSite=Lax');
}
function sessionHmacKey() {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update('gg-qr-session|' + OIDC_CLIENT_SECRET.value()).digest();
}
function signSession(obj) {
  const crypto = require('crypto');
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionHmacKey()).update(body).digest('base64url');
  return body + '.' + mac;
}
// Returns the verified, unexpired session payload of the given type
// ('s' = signed-in admin, 'p' = login in flight), or null.
function readSession(req, typ) {
  const crypto = require('crypto');
  const tok = sessionCookieOf(req);
  const dot = tok.lastIndexOf('.');
  if (dot < 1) return null;
  const body = tok.slice(0, dot);
  const mac = Buffer.from(crypto.createHmac('sha256', sessionHmacKey()).update(body).digest('base64url'));
  const got = Buffer.from(tok.slice(dot + 1));
  if (mac.length !== got.length || !crypto.timingSafeEqual(mac, got)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (obj.t !== typ || !obj.exp || obj.exp * 1000 < Date.now()) return null;
    return obj;
  } catch (e) {
    return null;
  }
}

// Only ever bounce back to a local path — never an absolute or
// protocol-relative URL smuggled into ?next= (open-redirect guard).
function safeNext(v) {
  const s = String(v || '');
  return (s.startsWith('/') && !s.startsWith('//') && !s.includes('\\')) ? s : '/';
}

// Kick off the authorization-code flow: stash state/nonce/PKCE verifier (and
// where to land afterwards) in a short-lived signed cookie, then send the
// browser to Keycloak.
async function startLogin(req, res, next) {
  const crypto = require('crypto');
  const meta = await oidcDiscover();
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  setSessionCookie(res, signSession({
    t: 'p', st: state, no: nonce, cv: verifier, nx: safeNext(next),
    exp: Math.floor(Date.now() / 1000) + 600,
  }), 600);
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', OIDC_CLIENT_ID.value());
  u.searchParams.set('redirect_uri', originOf(req) + CALLBACK_PATH);
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  res.set('Cache-Control', 'private, no-store');
  return res.redirect(302, u.toString());
}

/* Shared chrome for the human pages (stats + admin) — the generator's cream theme. */
function pageTop(title) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + h(title) + '</title><style>' +
    'body{font-family:"Segoe UI",system-ui,sans-serif;background:#E9E1CF;color:#4A3A28;margin:0;padding:24px;}' +
    '.card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #D6CAB0;position:relative;z-index:1;}' +
    '#tetris-bg{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;display:block;}' +
    '.head{background:#2C2018;color:#C9B48C;padding:10px 18px;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;}' +
    '.body{padding:20px 18px;}' +
    '.big{font-size:64px;font-weight:800;color:#6E4E14;line-height:1;}' +
    '.big small{display:block;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8A7860;font-weight:700;margin-top:4px;}' +
    '.kv{margin:14px 0;font-size:14px;line-height:1.7;overflow-wrap:anywhere;}' +
    '.kv b{display:inline-block;min-width:110px;color:#8A7860;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;}' +
    '.bars{display:flex;align-items:flex-end;gap:3px;height:56px;margin:10px 0 4px;}' +
    '.bar-col{flex:1;height:100%;display:flex;align-items:flex-end;position:relative;}' +
    '.bar-fill{width:100%;background:#C0892E;min-height:2px;border-radius:1px;transition:background .12s;}' +
    '.bar-col:hover .bar-fill{background:#6E4E14;}' +
    '.bar-col::after{content:attr(data-label);position:absolute;left:50%;bottom:calc(100% + 7px);transform:translateX(-50%);background:#2C2018;color:#F3E9D6;padding:5px 9px;border-radius:3px;font-size:11px;font-weight:600;letter-spacing:.4px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .1s;z-index:6;}' +
    '.bar-col::before{content:"";position:absolute;left:50%;bottom:calc(100% + 2px);transform:translateX(-50%);border:5px solid transparent;border-top-color:#2C2018;opacity:0;pointer-events:none;transition:opacity .1s;z-index:6;}' +
    '.bar-col:hover::after,.bar-col:hover::before{opacity:1;}' +
    '.bl{font-size:10px;color:#8A7860;letter-spacing:1px;text-transform:uppercase;}' +
    'input[type=url],input[type=text]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #D6CAB0;background:#F7F2E7;font-size:14px;}' +
    'button{margin-top:8px;padding:9px 18px;border:1px solid #6E3E12;background:#2C2018;color:#F3E9D6;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-size:13px;cursor:pointer;}' +
    '.ok{background:#EDF7ED;border:1px solid #9CC79C;color:#1A5E38;padding:8px 12px;font-size:13px;margin-bottom:12px;}' +
    'table{width:100%;border-collapse:collapse;font-size:13px;}' +
    'th{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#8A7860;padding:6px 8px;text-align:left;border-bottom:2px solid #D6CAB0;}' +
    'td{padding:8px;border-bottom:1px solid #EAE1CE;vertical-align:top;overflow-wrap:anywhere;}' +
    'td.hits{font-size:20px;font-weight:800;color:#6E4E14;white-space:nowrap;}' +
    '.qrwrap{text-align:center;margin:18px 0;padding:16px;background:#F7F2E7;border:1px solid #EAE1CE;}' +
    '.qrimg{display:inline-block;background:#fff;padding:10px;border:1px solid #D6CAB0;line-height:0;}' +
    '.qrimg svg{display:block;width:220px;height:220px;}' +
    '.dlrow{margin-top:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}' +
    '.dl{padding:8px 16px;background:#2C2018;color:#F3E9D6;text-decoration:none;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border:1px solid #6E3E12;}' +
    '.del{margin:0;padding:5px 12px;font-size:11px;background:#7A0D0D;border:1px solid #4A0808;color:#F3E9D6;letter-spacing:1px;text-transform:uppercase;cursor:pointer;white-space:nowrap;}' +
    'th:last-child,td:last-child{white-space:nowrap;}' +
    'td form{margin:0;}' +
    'a{color:#7A5A32;}' +
    '</style></head><body><canvas id="tetris-bg" aria-hidden="true"></canvas><div class="card">';
}
// Closes the card + body, injecting the ambient Tetris animation script.
function pageBottom() {
  return '</div></div><script>' + TETRIS_JS + '</script></body></html>';
}

/* ── the single HTTP entry point (hosting rewrites /q, /s, /api/qr, /qradmin here) ── */
exports.qr = onRequest({
  region: 'us-central1', memory: '256MiB', maxInstances: 10,
  secrets: [OIDC_CLIENT_SECRET],
}, async (req, res) => {
  if (req.method === 'OPTIONS') {           // CORS preflight for the JSON API
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }

  const path = (req.path || '/').replace(/\/+$/, '') || '/';   // trim trailing slash
  const method = req.method;

  try {
    /* ── scan: count + redirect  ( /q/CODE ) ─────────────────────────────── */
    let m = path.match(/^\/q\/([A-Za-z0-9]+)$/);
    if (m && (method === 'GET' || method === 'HEAD')) {
      const code = m[1];
      const ref = db.collection(COLLECTION).doc(code);
      const snap = await ref.get();
      res.set('Cache-Control', 'private, no-store');
      if (!snap.exists) {
        // Removed or unknown code — don't dead-end the resident; forward to the
        // city site so a retired printed QR still lands somewhere legitimate.
        return res.redirect(302, FALLBACK_URL.value() || 'https://www.ggcity.org');
      }
      const dest = snap.data().dest || (FALLBACK_URL.value() || 'https://www.ggcity.org');
      if (!isPreviewRequest(req, method)) {   // don't count unfurl bots / prefetch / HEAD
        const nowD = new Date();
        const batch = db.batch();
        batch.update(ref, {
          hits: FieldValue.increment(1),
          lastScan: FieldValue.serverTimestamp(),
          ['days.' + ggDay(nowD)]: FieldValue.increment(1),      // pruned to 180 days
          ['months.' + ggMonth(nowD)]: FieldValue.increment(1),  // kept forever
        });
        // global live counter for the toolbox stat widgets
        batch.set(statsRef(), {dynamicQrScans: FieldValue.increment(1)}, {merge: true});
        await batch.commit();
      }
      return res.redirect(302, dest);
    }

    /* ── stats page  ( /s/TOKEN ) ────────────────────────────────────────── */
    m = path.match(/^\/s\/([A-Za-z0-9]+)$/);
    if (m && method === 'GET') {
      const token = m[1];
      const doc = await findByToken(token);
      res.type('text/html');
      if (!doc) {
        return res.status(404).send(pageTop('Not found') +
          '<div class="head">GG QR</div><div class="body">This stats link is not valid.' + pageBottom());
      }
      const d = doc.data();
      const days = d.days || {};

      // prune day-history beyond KEEP_DAYS (lazy — only when it actually grows past)
      const dayKeys = Object.keys(days);
      if (dayKeys.length > KEEP_DAYS) {
        const keep = dayKeys.sort().slice(-KEEP_DAYS);
        const trimmed = {};
        keep.forEach((k) => (trimmed[k] = days[k]));
        await doc.ref.update({days: trimmed});
      }

      // adaptive activity chart: daily → weekly → monthly as the campaign ages
      const chart = buildChart(d.created, days, d.months || {});
      let max = 1;
      chart.bars.forEach((b) => { if (b.n > max) max = b.n; });
      const bars = chart.bars.map((b) => {
        const scans = b.n === 1 ? '1 scan' : b.n + ' scans';
        const hpct = Math.max(3, Math.round(b.n / max * 100));
        return '<div class="bar-col" data-label="' + h(b.label + ' · ' + scans) + '">' +
          '<div class="bar-fill" style="height:' + hpct + '%"></div></div>';
      }).join('');

      const saved = req.query.saved ?
        '<div class="ok">Destination updated — your printed QR now forwards to the new page.</div>' : '';

      // The scannable code for this link, shown on the page and downloadable.
      // Prefer the fully-designed QR the employee built (stored at track time);
      // fall back to a plain generated one for codes made before that existed.
      let qrBlock = '';
      try {
        let design = null;
        try {
          const dsnap = await db.collection('qrDesigns').doc(doc.id).get();
          if (dsnap.exists) design = dsnap.data();
        } catch (e) { /* fall through to generated */ }

        let imgTag; let dls; let caption;
        if (design && design.png) {
          imgTag = '<img src="' + design.png + '" alt="QR code" style="display:block;width:220px;height:220px;">';
          dls = '<a class="dl" href="' + design.png + '" download="gg-qr-' + doc.id + '.png">Download PNG</a>';
          if (design.svg) {
            dls += '<a class="dl" href="' + design.svg + '" download="gg-qr-' + doc.id + '.svg">Download SVG</a>';
          }
          caption = 'Your designed code for this link';
        } else {
          const link = shortUrl(req, doc.id);
          const svg = await QRCode.toString(link, {type: 'svg', margin: 1, width: 220});
          const png = await QRCode.toDataURL(link, {margin: 1, width: 1024});
          const svgB64 = Buffer.from(svg).toString('base64');
          imgTag = svg;
          dls = '<a class="dl" href="' + png + '" download="gg-qr-' + doc.id + '.png">Download PNG</a>' +
            '<a class="dl" href="data:image/svg+xml;base64,' + svgB64 + '" download="gg-qr-' + doc.id + '.svg">Download SVG</a>';
          caption = 'Scannable code for this link';
        }
        qrBlock = '<div class="qrwrap"><div class="qrimg">' + imgTag + '</div>' +
          '<div class="dlrow">' + dls + '</div>' +
          '<div class="bl" style="margin-top:8px;">' + caption + '</div></div>';
      } catch (e) {
        console.error('qr image gen failed', e);
      }

      return res.send(pageTop('Scans — ' + (d.label || doc.id)) +
        '<div class="head">GG QR &middot; Scan stats</div><div class="body">' + saved +
        '<div class="big">' + (d.hits || 0) + '<small>total scans</small></div>' +
        '<div class="bars">' + bars + '</div><div class="bl">' + h(chart.caption) + '</div>' +
        qrBlock +
        '<div class="kv">' +
        '<div><b>Name</b> ' + h(d.label || 'Untitled') + '</div>' +
        '<div><b>QR points to</b> ' + h(shortUrl(req, doc.id)) + '</div>' +
        '<div><b>Forwards to</b> <a href="' + h(d.dest) + '">' + h(d.dest) + '</a></div>' +
        '<div><b>Created</b> ' + h(fmtStamp(d.created)) + ' PT</div>' +
        '<div><b>Last scan</b> ' + (d.lastScan ? h(fmtStamp(d.lastScan)) + ' PT' : 'never') + '</div>' +
        '</div><hr style="border:none;border-top:1px solid #EAE1CE;margin:16px 0;">' +
        '<div class="bl" style="margin-bottom:6px;">Change where the QR forwards (the printed code keeps working)</div>' +
        '<form method="post" action="' + h(statsUrl(req, token)) + '">' +
        '<input type="url" name="dest" required placeholder="https://…" value="' + h(d.dest) + '">' +
        '<button type="submit">Save new destination</button></form>' +
        '<p class="bl" style="margin-top:16px;">Bookmark this page — it is your key to this QR code.</p>' +
        pageBottom());
    }

    /* ── repoint from the stats-page form  ( POST /s/TOKEN ) ──────────────── */
    if (m && method === 'POST') {
      const token = m[1];
      const dest = String((req.body && req.body.dest) || '').trim();
      const doc = await findByToken(token);
      if (!doc) return res.status(404).type('text/plain').send('Unknown stats token.');
      if (!isHttpUrl(dest)) return res.status(400).type('text/plain').send('Destination must start with http:// or https://');
      await doc.ref.update({dest});
      return res.redirect(303, statsUrl(req, token) + '?saved=1');
    }

    /* ── sign-in problems get a small themed page ────────────────────────── */
    const authErrorPage = (status, msg) => {
      res.set('Cache-Control', 'private, no-store');
      return res.status(status).type('text/html').send(pageTop('Sign-in — GG QR admin') +
        '<div class="head">GG QR &middot; Admin sign-in</div><div class="body"><p>' + h(msg) +
        '</p><p><a href="/qradmin">Try again</a></p>' + pageBottom());
    };

    /* ── OIDC callback  ( GET /oauth2-callback ) ─────────────────────────── */
    if (path === CALLBACK_PATH && method === 'GET') {
      if (!oidcReady()) {
        return authErrorPage(503, 'Admin sign-in is not configured yet (OIDC_CLIENT_ID / OIDC_CLIENT_SECRET missing).');
      }
      if (req.query.error) {
        return authErrorPage(403, 'Sign-in was cancelled or failed: ' + req.query.error);
      }
      const pending = readSession(req, 'p');
      if (!pending || !req.query.code || String(req.query.state || '') !== pending.st) {
        return authErrorPage(400, 'Your sign-in attempt expired or did not match — please try again.');
      }
      const meta = await oidcDiscover();
      const tr = await fetch(meta.token_endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(req.query.code),
          redirect_uri: originOf(req) + CALLBACK_PATH,
          client_id: OIDC_CLIENT_ID.value(),
          client_secret: OIDC_CLIENT_SECRET.value(),
          code_verifier: pending.cv,
        }).toString(),
      });
      if (!tr.ok) {
        console.error('OIDC token exchange failed', tr.status, await tr.text());
        return authErrorPage(502, 'Could not complete sign-in with the city login server.');
      }
      const tokens = await tr.json();
      let claims;
      try {
        claims = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString('utf8'));
      } catch (e) {
        return authErrorPage(502, 'The login server returned an unreadable ID token.');
      }
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const nowS = Math.floor(Date.now() / 1000);
      if (claims.iss !== meta.issuer || !aud.includes(OIDC_CLIENT_ID.value()) ||
          !(claims.exp > nowS) || claims.nonce !== pending.no) {
        return authErrorPage(403, 'The sign-in response failed validation — please try again.');
      }
      // Any authenticated city account gets a site session; the QR-admin
      // allow-list is enforced where it applies — on the /qradmin route.
      const username = String(claims.preferred_username || '').toLowerCase();
      setSessionCookie(res, signSession({
        t: 's', sub: claims.sub, u: username, n: claims.name || username,
        exp: nowS + SESSION_HOURS * 3600,
      }), SESSION_HOURS * 3600);
      res.set('Cache-Control', 'private, no-store');
      return res.redirect(302, safeNext(pending.nx));
    }

    /* ── site sign-in  ( GET /login?next=/path ) — any city account ──────── */
    if (path === '/login' && method === 'GET') {
      if (!oidcReady()) {
        return authErrorPage(503, 'Sign-in is not configured yet (OIDC_CLIENT_ID / OIDC_CLIENT_SECRET missing).');
      }
      const next = safeNext(req.query.next);
      if (readSession(req, 's')) {
        res.set('Cache-Control', 'private, no-store');
        return res.redirect(302, next);
      }
      return startLogin(req, res, next);
    }

    /* ── session probe for the static pages  ( GET /api/session ) ────────── */
    if (path === '/api/session' && method === 'GET') {
      res.set('Cache-Control', 'private, no-store');
      const sess = readSession(req, 's');
      if (!sess) return sendJson(res, 401, {ok: false});
      return sendJson(res, 200, {ok: true, user: sess.u, name: sess.n});
    }

    /* ── admin sign-out  ( GET /qradmin/logout ) ─────────────────────────── */
    if (path === '/qradmin/logout' && method === 'GET') {
      setSessionCookie(res, '', 0);
      const meta = await oidcDiscover().catch(() => null);
      res.set('Cache-Control', 'private, no-store');
      // End the Keycloak SSO session too (Keycloak shows a confirm page since
      // we don't keep the id_token around for an id_token_hint).
      return res.redirect(302, (meta && meta.end_session_endpoint) ?
        meta.end_session_endpoint + '?client_id=' + encodeURIComponent(OIDC_CLIENT_ID.value()) :
        '/qradmin');
    }

    /* ── admin directory  ( /qradmin — city SSO required ) ───────────────── */
    if (path === '/qradmin') {
      if (!oidcReady()) {
        return authErrorPage(503, 'Admin sign-in is not configured yet (OIDC_CLIENT_ID / OIDC_CLIENT_SECRET missing).');
      }
      const sess = readSession(req, 's');
      if (!sess) {
        if (method !== 'GET') {
          return res.status(403).type('text/plain').send('Session expired — reload the admin page and sign in again.');
        }
        return startLogin(req, res, '/qradmin');
      }
      // The allow-list guards this directory only; empty list = any city user.
      const allowed = OIDC_ADMIN_USERS.value().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (allowed.length && !allowed.includes(sess.u)) {
        return authErrorPage(403, 'You are signed in as ' + (sess.n || sess.u) +
          ', but this account is not on the QR admin list.');
      }
      const adminUrl = originOf(req) + '/qradmin';

      // Remove a code: deletes its Firestore doc (frees that storage) and its
      // tracking — the short link 404s afterward, so any printed copies stop.
      if (method === 'POST') {
        if (req.body && req.body.action === 'delete') {
          const code = String(req.body.code || '').replace(/[^A-Za-z0-9]/g, '');
          if (code) {
            await db.collection(COLLECTION).doc(code).delete();
            await db.collection('qrDesigns').doc(code).delete().catch(() => {});   // its stored design, if any
          }
        }
        return res.redirect(303, adminUrl);
      }

      const snap = await db.collection(COLLECTION).orderBy('created', 'desc').get();
      res.set('Cache-Control', 'private, no-store');
      res.type('text/html');
      let html = pageTop('GG QR — all tracked codes') +
        '<div class="head">GG QR &middot; All tracked codes (' + snap.size + ')</div><div class="body">' +
        '<div class="bl" style="margin-bottom:10px;">Signed in as ' + h(sess.n) +
        ' &middot; <a href="/qradmin/logout">Sign out</a></div>' +
        '<input type="text" id="qadmin-search" autocomplete="off" autofocus ' +
        'placeholder="Filter by name, code, or destination…" style="margin-bottom:6px;">' +
        '<div class="bl" id="qadmin-count" style="margin-bottom:12px;"></div>' +
        '<table><thead><tr><th>Scans</th><th>Name</th><th>Forwards to</th><th>Created</th><th>Active</th><th>Stats</th><th></th></tr></thead>' +
        '<tbody id="qadmin-rows">';
      snap.forEach((docSnap) => {
        const l = docSnap.data();
        const search = ((l.label || 'Untitled') + ' ' + docSnap.id + ' ' + (l.dest || '')).toLowerCase();
        html += '<tr data-s="' + h(search) + '"><td class="hits">' + (l.hits || 0) + '</td>' +
          '<td>' + h(l.label || 'Untitled') + '<br><span class="bl">' + h(docSnap.id) + '</span></td>' +
          '<td>' + h(l.dest) + '</td>' +
          '<td>' + h(fmtStamp(l.created).slice(0, 10)) + '</td>' +
          '<td>' + h(daysActive(l.created)) + '</td>' +
          '<td><a href="' + h(statsUrl(req, l.token || '')) + '">stats</a></td>' +
          '<td><form method="post" action="' + h(adminUrl) + '" ' +
          'onsubmit="return confirm(\'Delete this QR tracking?\\n\\nScans of any printed copies will forward to the city website instead, and the scan history is erased. This cannot be undone.\')">' +
          '<input type="hidden" name="action" value="delete">' +
          '<input type="hidden" name="code" value="' + h(docSnap.id) + '">' +
          '<button type="submit" class="del">Remove</button></form></td></tr>';
      });
      html += '</tbody></table>' +
        '<p class="bl" id="qadmin-empty" style="margin-top:14px;display:none;">No codes match your filter.</p>' +
        '<p class="bl" style="margin-top:14px;">Send an employee their stats link if they lose it — the link is their access. ' +
        'Removing a code deletes its tracking and frees its storage; scans of any printed copies then forward to the city website.</p>' +
        '<script>(function(){' +
        'var q=document.getElementById("qadmin-search"),' +
        'rows=[].slice.call(document.querySelectorAll("#qadmin-rows tr")),' +
        'count=document.getElementById("qadmin-count"),' +
        'empty=document.getElementById("qadmin-empty"),total=rows.length;' +
        'function apply(){' +
        'var t=q.value.trim().toLowerCase(),shown=0;' +
        'rows.forEach(function(r){' +
        'var ok=!t||r.getAttribute("data-s").indexOf(t)!==-1;' +
        'r.style.display=ok?"":"none";if(ok)shown++;});' +
        'count.textContent=t?("Showing "+shown+" of "+total):(total+" total");' +
        'empty.style.display=shown?"none":"";' +
        '}' +
        'q.addEventListener("input",apply);apply();' +
        '})();</script>' +
        pageBottom();
      return res.send(html);
    }

    /* ── JSON API: global usage counters  ( /api/stats ) ─────────────────────
     * GET  → current counters (also lazily seeds the doc from qrLinks the
     *        first time, so historical scan/code totals aren't lost).
     * POST {tool: compressor|formatter|merger|qr, n} → increment. The three
     * browser-side tools do their work entirely client-side, so this is an
     * honor-system report — same trust level as the open /api/qr create. */
    if (path === '/api/stats' && method === 'GET') {
      const seeded = await db.runTransaction(async (tx) => {
        const s = await tx.get(statsRef());
        if (s.exists && s.data().seeded) return s.data();
        // First run: fold the pre-existing dynamic-QR history into the
        // counters. hits sums are authoritative — they overwrite whatever
        // few live increments landed between deploy and this first read.
        const links = await tx.get(db.collection(COLLECTION));
        let scans = 0;
        links.forEach((d) => { scans += d.data().hits || 0; });
        const cur = s.exists ? s.data() : {};
        const out = {};
        STATS_FIELDS.forEach((f) => { out[f] = cur[f] || 0; });
        out.dynamicQrCreated = links.size;
        out.dynamicQrScans = scans;
        out.seeded = true;
        tx.set(statsRef(), out, {merge: true});
        return out;
      });
      const counters = {};
      STATS_FIELDS.forEach((f) => { counters[f] = seeded[f] || 0; });
      return sendJson(res, 200, counters);
    }
    if (path === '/api/stats' && method === 'POST') {
      if (!readSession(req, 's')) return sendJson(res, 401, {error: 'Sign-in required.'});
      const field = STATS_TOOLS[String((req.body || {}).tool || '')];
      if (!field) return sendJson(res, 400, {error: 'Unknown tool.'});
      // clamp: a report is 1..500 events (500 = the biggest real batch; the
      // compressor caps uploads at 50 files, so anything huge is garbage)
      const n = Math.min(500, Math.max(1, Math.floor(Number((req.body || {}).n) || 1)));
      await statsRef().set({[field]: FieldValue.increment(n)}, {merge: true});
      return sendJson(res, 200, {ok: true});
    }

    /* ── JSON API: create / repoint / setdesign  ( POST /api/qr ) ────────── */
    if (path === '/api/qr' && method === 'POST') {
      const inp = req.body || {};
      const action = inp.action || '';

      if (action === 'create') {
        // Creating tracked codes is a staff action; repoint/setdesign below
        // stay open — possession of the per-code stats token is their auth.
        if (!readSession(req, 's')) {
          return sendJson(res, 401, {error: 'Your sign-in expired — reload the page and sign in again.'});
        }
        const dest = String(inp.dest || '').trim();
        if (!isHttpUrl(dest)) return sendJson(res, 400, {error: 'Destination must start with http:// or https://'});
        const label = String(inp.label || '').trim().slice(0, 120);
        const token = randomId(12);
        let code;
        for (let tries = 0; tries < 8; tries++) {           // find a free 6-char code
          code = randomId(6);
          const ref = db.collection(COLLECTION).doc(code);
          // eslint-disable-next-line no-await-in-loop
          const created = await db.runTransaction(async (tx) => {
            const s = await tx.get(ref);
            if (s.exists) return false;
            tx.set(ref, {
              dest, label, token, hits: 0,
              created: FieldValue.serverTimestamp(),
              lastScan: null, days: {}, months: {},
            });
            // same transaction, so a retried allocation can't double-count
            tx.set(statsRef(), {dynamicQrCreated: FieldValue.increment(1)}, {merge: true});
            return true;
          });
          if (created) {
            return sendJson(res, 200, {
              code, token, url: shortUrl(req, code), stats: statsUrl(req, token),
            });
          }
        }
        return sendJson(res, 500, {error: 'Could not allocate a code — please try again.'});
      }

      if (action === 'repoint') {
        const dest = String(inp.dest || '').trim();
        if (!isHttpUrl(dest)) return sendJson(res, 400, {error: 'Destination must start with http:// or https://'});
        const token = String(inp.token || '').replace(/[^A-Za-z0-9]/g, '');
        const doc = await findByToken(token);
        if (!doc) return sendJson(res, 404, {error: 'Unknown stats token.'});
        await doc.ref.update({dest});
        return sendJson(res, 200, {ok: true, stats: statsUrl(req, token)});
      }

      // Store the fully-designed QR (logo, colours, dot styles) the employee
      // built, so the stats page shows their real code, not a plain one. Kept
      // in a separate collection so the scan path (qrLinks) stays small.
      if (action === 'setdesign') {
        const token = String(inp.token || '').replace(/[^A-Za-z0-9]/g, '');
        const doc = await findByToken(token);
        if (!doc) return sendJson(res, 404, {error: 'Unknown stats token.'});
        const png = (typeof inp.png === 'string' && inp.png.startsWith('data:image/png')) ? inp.png : null;
        let svg = (typeof inp.svg === 'string' && inp.svg.startsWith('data:image/svg')) ? inp.svg : null;
        if (!png && !svg) return sendJson(res, 400, {error: 'No image provided.'});
        // stay clear of Firestore's 1 MB doc cap — drop the SVG first if huge
        if (svg && png && (png.length + svg.length) > 900000) svg = null;
        await db.collection('qrDesigns').doc(doc.id).set({
          png: png || null, svg: svg || null, updated: FieldValue.serverTimestamp(),
        });
        return sendJson(res, 200, {ok: true});
      }

      return sendJson(res, 400, {error: 'Unknown action.'});
    }

    /* ── nothing matched ─────────────────────────────────────────────────── */
    res.set('Access-Control-Allow-Origin', '*');
    return res.status(400).type('text/plain').send('Bad request.');
  } catch (err) {
    console.error('qr function error', err);
    return sendJson(res, 500, {error: 'Server error.'});
  }
});
