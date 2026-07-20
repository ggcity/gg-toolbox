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

admin.initializeApp();
const db = admin.firestore();
const {FieldValue} = admin.firestore;

const COLLECTION = 'qrLinks';
const KEEP_DAYS = 180;                 // per-day counts kept this long (totals kept forever)
const ADMIN_KEY = defineString('QR_ADMIN_KEY');   // recovery-directory password (functions/.env)

/* ── helpers ────────────────────────────────────────────────────────────── */

// URL-safe, no look-alike characters (no 0/O/1/l/I) — matches the old q.php.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function randomId(len) {
  const crypto = require('crypto');
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function utcDay(d) {
  return d.toISOString().slice(0, 10);            // YYYY-MM-DD (UTC), the days-map key
}
function fmtStamp(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0, 19).replace('T', ' ');   // YYYY-MM-DD HH:MM:SS
}
function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return proto + '://' + host;
}
function shortUrl(req, code) {
  return originOf(req) + '/q/' + code;
}
function statsUrl(req, token) {
  return originOf(req) + '/s/' + token;
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
    '.card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #D6CAB0;}' +
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
    'a{color:#7A5A32;}' +
    '</style></head><body><div class="card">';
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
        const today = utcDay(new Date());
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
          '<div class="head">GG QR</div><div class="body">This stats link is not valid.</div></div></body></html>');
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
        const day = utcDay(new Date(Date.now() - i * 86400000));
        const n = days[day] || 0;
        counts.push(n);
        if (n > max) max = n;
      }
      const bars = counts.map((n) =>
        '<div style="height:' + Math.max(3, Math.round(n / max * 100)) + '%" title="' + n + '"></div>').join('');

      const saved = req.query.saved ?
        '<div class="ok">Destination updated — your printed QR now forwards to the new page.</div>' : '';

      return res.send(pageTop('Scans — ' + (d.label || doc.id)) +
        '<div class="head">GG QR &middot; Scan stats</div><div class="body">' + saved +
        '<div class="big">' + (d.hits || 0) + '<small>total scans</small></div>' +
        '<div class="bars">' + bars + '</div><div class="bl">last 14 days</div>' +
        '<div class="kv">' +
        '<div><b>Name</b> ' + h(d.label || 'Untitled') + '</div>' +
        '<div><b>QR points to</b> ' + h(shortUrl(req, doc.id)) + '</div>' +
        '<div><b>Forwards to</b> <a href="' + h(d.dest) + '">' + h(d.dest) + '</a></div>' +
        '<div><b>Created</b> ' + h(fmtStamp(d.created)) + '</div>' +
        '<div><b>Last scan</b> ' + h(fmtStamp(d.lastScan) || 'never') + '</div>' +
        '</div><hr style="border:none;border-top:1px solid #EAE1CE;margin:16px 0;">' +
        '<div class="bl" style="margin-bottom:6px;">Change where the QR forwards (the printed code keeps working)</div>' +
        '<form method="post" action="' + h(statsUrl(req, token)) + '">' +
        '<input type="url" name="dest" required placeholder="https://…" value="' + h(d.dest) + '">' +
        '<button type="submit">Save new destination</button></form>' +
        '<p class="bl" style="margin-top:16px;">Bookmark this page — it is your key to this QR code.</p>' +
        '</div></div></body></html>');
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
    if (path === '/qradmin' && method === 'GET') {
      const key = ADMIN_KEY.value();
      if (!key || req.query.key !== key) {
        return res.status(403).type('text/plain').send('Wrong admin key (or key not set yet).');
      }
      const snap = await db.collection(COLLECTION).orderBy('created', 'desc').get();
      res.type('text/html');
      let html = pageTop('GG QR — all tracked codes') +
        '<div class="head">GG QR &middot; All tracked codes (' + snap.size + ')</div><div class="body">' +
        '<table><tr><th>Scans</th><th>Name</th><th>Forwards to</th><th>Created</th><th>Stats link</th></tr>';
      snap.forEach((docSnap) => {
        const l = docSnap.data();
        html += '<tr><td class="hits">' + (l.hits || 0) + '</td>' +
          '<td>' + h(l.label || 'Untitled') + '<br><span class="bl">' + h(docSnap.id) + '</span></td>' +
          '<td>' + h(l.dest) + '</td>' +
          '<td>' + h(fmtStamp(l.created).slice(0, 10)) + '</td>' +
          '<td><a href="' + h(statsUrl(req, l.token || '')) + '">stats page</a></td></tr>';
      });
      html += '</table><p class="bl" style="margin-top:14px;">Send an employee their stats link if they lose it — the link is their access.</p>' +
        '</div></div></body></html>';
      return res.send(html);
    }

    /* ── JSON API: create (from the generator) & repoint  ( POST /api/qr ) ── */
    if (path === '/api/qr' && method === 'POST') {
      const inp = req.body || {};
      const action = inp.action || '';
      const dest = String(inp.dest || '').trim();
      if (!isHttpUrl(dest)) return sendJson(res, 400, {error: 'Destination must start with http:// or https://'});

      if (action === 'create') {
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
              code, url: shortUrl(req, code), stats: statsUrl(req, token),
            });
          }
        }
        return sendJson(res, 500, {error: 'Could not allocate a code — please try again.'});
      }

      if (action === 'repoint') {
        const token = String(inp.token || '').replace(/[^A-Za-z0-9]/g, '');
        const doc = await findByToken(token);
        if (!doc) return sendJson(res, 404, {error: 'Unknown stats token.'});
        await doc.ref.update({dest});
        return sendJson(res, 200, {ok: true, stats: statsUrl(req, token)});
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
