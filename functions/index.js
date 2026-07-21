/*
 * GG QR — dynamic QR redirect + scan counter, on Firebase.
 *
 * A tracked QR encodes  https://<host>/q/CODE .  Every scan is counted here
 * and 302-redirected to the stored destination.  Each code has a private
 * STATS LINK ( /s/TOKEN ) — a page showing the scan count, with a form to
 * re-point the QR later.  Whoever has the stats link owns the code; there
 * are no accounts or passwords.  A recovery directory lives at
 *   /qradmin?key=QR_ADMIN_KEY   (set in functions/.env).
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
const {defineString} = require('firebase-functions/params');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

admin.initializeApp();
const db = admin.firestore();
const {FieldValue} = admin.firestore;

const COLLECTION = 'qrLinks';
// Client-side ambient Tetris animation (same one as the QR generator), read
// once at cold start and injected into the stats/admin pages by pageBottom().
const TETRIS_JS = fs.readFileSync(path.join(__dirname, 'client-tetris.js'), 'utf8');
const KEEP_DAYS = 180;                 // per-day counts kept this long (totals kept forever)
const ADMIN_KEY = defineString('QR_ADMIN_KEY');   // recovery-directory password (functions/.env)
// Public origin the printed QR short-links (/q/…) and stats links (/s/…) are
// built on — a neutral domain residents see instead of the internal toolbox
// host. Empty → fall back to the request's own host (functions/.env).
const PUBLIC_BASE = defineString('QR_PUBLIC_BASE', {default: ''});

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
    '.bars div{flex:1;background:#C0892E;min-height:2px;}' +
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
exports.qr = onRequest({region: 'us-central1', memory: '256MiB', maxInstances: 10}, async (req, res) => {
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
      if (!snap.exists) {
        res.set('Cache-Control', 'private, no-store');
        return res.status(404).type('text/plain').send('Unknown QR code.');
      }
      const dest = snap.data().dest;
      if (!isPreviewRequest(req, method)) {   // don't count unfurl bots / prefetch / HEAD
        const today = ggDay(new Date());
        await ref.update({
          hits: FieldValue.increment(1),
          lastScan: FieldValue.serverTimestamp(),
          ['days.' + today]: FieldValue.increment(1),
        });
      }
      res.set('Cache-Control', 'private, no-store');
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

      // last-14-day bars
      let max = 1;
      const counts = [];
      for (let i = 13; i >= 0; i--) {
        const day = ggDay(new Date(Date.now() - i * 86400000));
        const n = days[day] || 0;
        counts.push(n);
        if (n > max) max = n;
      }
      const bars = counts.map((n) =>
        '<div style="height:' + Math.max(3, Math.round(n / max * 100)) + '%" title="' + n + '"></div>').join('');

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
        '<div class="bars">' + bars + '</div><div class="bl">last 14 days</div>' +
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

    /* ── admin directory  ( /qradmin?key=… ) ─────────────────────────────── */
    if (path === '/qradmin') {
      const key = ADMIN_KEY.value();
      if (!key || req.query.key !== key) {
        return res.status(403).type('text/plain').send('Wrong admin key (or key not set yet).');
      }
      const adminUrl = originOf(req) + '/qradmin?key=' + encodeURIComponent(key);

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
      res.type('text/html');
      let html = pageTop('GG QR — all tracked codes') +
        '<div class="head">GG QR &middot; All tracked codes (' + snap.size + ')</div><div class="body">' +
        '<table><tr><th>Scans</th><th>Name</th><th>Forwards to</th><th>Created</th><th>Active</th><th>Stats</th><th></th></tr>';
      snap.forEach((docSnap) => {
        const l = docSnap.data();
        html += '<tr><td class="hits">' + (l.hits || 0) + '</td>' +
          '<td>' + h(l.label || 'Untitled') + '<br><span class="bl">' + h(docSnap.id) + '</span></td>' +
          '<td>' + h(l.dest) + '</td>' +
          '<td>' + h(fmtStamp(l.created).slice(0, 10)) + '</td>' +
          '<td>' + h(daysActive(l.created)) + '</td>' +
          '<td><a href="' + h(statsUrl(req, l.token || '')) + '">stats</a></td>' +
          '<td><form method="post" action="' + h(adminUrl) + '" ' +
          'onsubmit="return confirm(\'Delete this QR tracking?\\n\\nThe printed code will STOP working and its scan history is erased. This cannot be undone.\')">' +
          '<input type="hidden" name="action" value="delete">' +
          '<input type="hidden" name="code" value="' + h(docSnap.id) + '">' +
          '<button type="submit" class="del">Remove</button></form></td></tr>';
      });
      html += '</table><p class="bl" style="margin-top:14px;">Send an employee their stats link if they lose it — the link is their access. ' +
        'Removing a code deletes its tracking and frees its storage; any printed copies stop working.</p>' +
        pageBottom();
      return res.send(html);
    }

    /* ── JSON API: create / repoint / setdesign  ( POST /api/qr ) ────────── */
    if (path === '/api/qr' && method === 'POST') {
      const inp = req.body || {};
      const action = inp.action || '';

      if (action === 'create') {
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
              lastScan: null, days: {},
            });
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
