<?php
/*  GG QR — dynamic QR redirect + scan counter. One file, no database server,
    no PHP extensions beyond the core. Works on any Apache/nginx + PHP host.

    HOW IT WORKS
      A tracked QR encodes   q.php?c=CODE   on this server. Every scan is
      counted here, then 302-redirected to the stored destination.
      Each code has a private STATS LINK (q.php?s=TOKEN) — a friendly page
      showing the scan count, with a form to re-point the QR later.
      Whoever has the stats link owns the code. No accounts, no passwords.

    DEPLOY (5 minutes)
      1. Put this file on the web server (same folder as gg-qr-generator.html
         is easiest — the generator finds it automatically).
      2. Change ADMIN_KEY below (protects the recovery directory).
      3. Make sure PHP can write to this directory (it creates qr-links.json).

    LOST STATS LINK?
      Everything is stored server-side. Open   q.php?admin=YOUR-ADMIN-KEY
      for a directory of every code with its stats link.                      */

const ADMIN_KEY   = 'CHANGE-ME-BEFORE-DEPLOY';
const PRETTY_BASE = '';                 // e.g. 'https://ggcity.org/q/' if you add the rewrite rule
const DATA_FILE   = __DIR__ . '/qr-links.json';
const KEEP_DAYS   = 180;                // per-day counts kept this long (totals kept forever)

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

/* ── helpers ────────────────────────────────────────────────────────────── */

function out($data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}
function baseUrl(): string {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    return $scheme . '://' . $_SERVER['HTTP_HOST'] . strtok($_SERVER['REQUEST_URI'], '?');
}
function shortUrl(string $code): string {
    return PRETTY_BASE !== '' ? PRETTY_BASE . $code : baseUrl() . '?c=' . $code;
}
function statsUrl(string $token): string { return baseUrl() . '?s=' . $token; }
function randomId(int $len): string {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    $s = '';
    for ($i = 0; $i < $len; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return $s;
}
function h(?string $s): string { return htmlspecialchars($s ?? '', ENT_QUOTES); }

/* Locked read-modify-write around the JSON store — flock keeps concurrent scans safe. */
function withStore(callable $fn, bool $write = true) {
    $fh = fopen(DATA_FILE, 'c+');
    if (!$fh) out(['error' => 'Cannot open data file — check directory permissions.'], 500);
    flock($fh, $write ? LOCK_EX : LOCK_SH);
    $raw  = stream_get_contents($fh);
    $data = $raw ? (json_decode($raw, true) ?: ['links' => []]) : ['links' => []];
    $result = $fn($data);
    if ($write) {
        rewind($fh);
        ftruncate($fh, 0);
        fwrite($fh, json_encode($data));
        fflush($fh);
    }
    flock($fh, LOCK_UN);
    fclose($fh);
    return $result;
}
function findByToken(array $links, string $token): ?string {
    if ($token === '') return null;
    foreach ($links as $code => $l) if (($l['token'] ?? '') === $token) return $code;
    return null;
}

/* Shared look for the human pages (stats + admin) — matches the generator's cream theme. */
function pageTop(string $title): string {
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' . h($title) . '</title><style>
body{font-family:"Segoe UI",system-ui,sans-serif;background:#E9E1CF;color:#4A3A28;margin:0;padding:24px;}
.card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #D6CAB0;}
.head{background:#2C2018;color:#C9B48C;padding:10px 18px;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;}
.body{padding:20px 18px;}
.big{font-size:64px;font-weight:800;color:#6E4E14;line-height:1;}
.big small{display:block;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#8A7860;font-weight:700;margin-top:4px;}
.kv{margin:14px 0;font-size:14px;line-height:1.7;overflow-wrap:anywhere;}
.kv b{display:inline-block;min-width:110px;color:#8A7860;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;}
.bars{display:flex;align-items:flex-end;gap:3px;height:56px;margin:10px 0 4px;}
.bars div{flex:1;background:#C0892E;min-height:2px;}
.bl{font-size:10px;color:#8A7860;letter-spacing:1px;text-transform:uppercase;}
input[type=url],input[type=text]{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #D6CAB0;background:#F7F2E7;font-size:14px;}
button{margin-top:8px;padding:9px 18px;border:1px solid #6E3E12;background:#2C2018;color:#F3E9D6;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-size:13px;cursor:pointer;}
.ok{background:#EDF7ED;border:1px solid #9CC79C;color:#1A5E38;padding:8px 12px;font-size:13px;margin-bottom:12px;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#8A7860;padding:6px 8px;text-align:left;border-bottom:2px solid #D6CAB0;}
td{padding:8px;border-bottom:1px solid #EAE1CE;vertical-align:top;overflow-wrap:anywhere;}
td.hits{font-size:20px;font-weight:800;color:#6E4E14;white-space:nowrap;}
a{color:#7A5A32;}
</style></head><body><div class="card">';
}

$method = $_SERVER['REQUEST_METHOD'];

/* ── scan: count + redirect ─────────────────────────────────────────────── */
if (($method === 'GET' || $method === 'HEAD') && isset($_GET['c'])) {
    $code = preg_replace('/[^A-Za-z0-9]/', '', $_GET['c']);
    $dest = withStore(function (&$d) use ($code, $method) {
        if (!isset($d['links'][$code])) return null;
        $link = &$d['links'][$code];
        if ($method === 'GET') {                       // link previews send HEAD — don't count those
            $today = gmdate('Y-m-d');
            $link['hits']      = ($link['hits'] ?? 0) + 1;
            $link['last_scan'] = gmdate('Y-m-d H:i:s');
            $link['days'][$today] = ($link['days'][$today] ?? 0) + 1;
            if (count($link['days']) > KEEP_DAYS) {
                ksort($link['days']);
                $link['days'] = array_slice($link['days'], -KEEP_DAYS, null, true);
            }
        }
        return $link['dest'];
    }, $method === 'GET');
    if (!$dest) { http_response_code(404); header('Content-Type: text/plain'); exit('Unknown QR code.'); }
    header('Location: ' . $dest, true, 302);
    exit;
}

/* ── stats page (the employee's private link) ───────────────────────────── */
if ($method === 'GET' && isset($_GET['s'])) {
    $token = preg_replace('/[^A-Za-z0-9]/', '', $_GET['s']);
    $found = withStore(function (&$d) use ($token) {
        $code = findByToken($d['links'], $token);
        return $code ? ['code' => $code] + $d['links'][$code] : null;
    }, false);
    header('Content-Type: text/html; charset=UTF-8');
    if (!$found) { http_response_code(404); echo pageTop('Not found') . '<div class="head">GG QR</div><div class="body">This stats link is not valid.</div></div></body></html>'; exit; }

    // last-14-day bars
    $bars = '';
    $max = 1;
    $daysArr = [];
    for ($i = 13; $i >= 0; $i--) {
        $day = gmdate('Y-m-d', time() - $i * 86400);
        $n = $found['days'][$day] ?? 0;
        $daysArr[] = $n;
        if ($n > $max) $max = $n;
    }
    foreach ($daysArr as $n) $bars .= '<div style="height:' . max(3, round($n / $max * 100)) . '%" title="' . $n . '"></div>';

    echo pageTop('Scans — ' . ($found['label'] ?: $found['code']))
        . '<div class="head">GG QR &middot; Scan stats</div><div class="body">'
        . (isset($_GET['saved']) ? '<div class="ok">Destination updated — your printed QR now forwards to the new page.</div>' : '')
        . '<div class="big">' . (int)($found['hits'] ?? 0) . '<small>total scans</small></div>'
        . '<div class="bars">' . $bars . '</div><div class="bl">last 14 days</div>'
        . '<div class="kv">'
        . '<div><b>Name</b> ' . h($found['label'] ?: 'Untitled') . '</div>'
        . '<div><b>QR points to</b> ' . h(shortUrl($found['code'])) . '</div>'
        . '<div><b>Forwards to</b> <a href="' . h($found['dest']) . '">' . h($found['dest']) . '</a></div>'
        . '<div><b>Created</b> ' . h($found['created'] ?? '') . '</div>'
        . '<div><b>Last scan</b> ' . h($found['last_scan'] ?: 'never') . '</div>'
        . '</div><hr style="border:none;border-top:1px solid #EAE1CE;margin:16px 0;">'
        . '<div class="bl" style="margin-bottom:6px;">Change where the QR forwards (the printed code keeps working)</div>'
        . '<form method="post" action="' . h(baseUrl()) . '">'
        . '<input type="hidden" name="action" value="repoint">'
        . '<input type="hidden" name="token" value="' . h($token) . '">'
        . '<input type="url" name="dest" required placeholder="https://…" value="' . h($found['dest']) . '">'
        . '<button type="submit">Save new destination</button></form>'
        . '<p class="bl" style="margin-top:16px;">Bookmark this page — it is your key to this QR code.</p>'
        . '</div></div></body></html>';
    exit;
}

/* ── admin directory (recovery for lost stats links) ────────────────────── */
if ($method === 'GET' && isset($_GET['admin'])) {
    if ($_GET['admin'] !== ADMIN_KEY || ADMIN_KEY === 'CHANGE-ME-BEFORE-DEPLOY') {
        http_response_code(403); header('Content-Type: text/plain'); exit('Wrong admin key (or key not set yet).');
    }
    $links = withStore(fn(&$d) => $d['links'], false);
    uasort($links, fn($a, $b) => strcmp($b['created'] ?? '', $a['created'] ?? ''));
    header('Content-Type: text/html; charset=UTF-8');
    echo pageTop('GG QR — all tracked codes')
        . '<div class="head">GG QR &middot; All tracked codes (' . count($links) . ')</div><div class="body">'
        . '<table><tr><th>Scans</th><th>Name</th><th>Forwards to</th><th>Created</th><th>Stats link</th></tr>';
    foreach ($links as $code => $l) {
        echo '<tr><td class="hits">' . (int)($l['hits'] ?? 0) . '</td>'
           . '<td>' . h($l['label'] ?: 'Untitled') . '<br><span class="bl">' . h($code) . '</span></td>'
           . '<td>' . h($l['dest']) . '</td>'
           . '<td>' . h(substr($l['created'] ?? '', 0, 10)) . '</td>'
           . '<td><a href="' . h(statsUrl($l['token'] ?? '')) . '">stats page</a></td></tr>';
    }
    echo '</table><p class="bl" style="margin-top:14px;">Send an employee their stats link if they lose it — the link is their access.</p>'
       . '</div></div></body></html>';
    exit;
}

/* ── create (from the generator) & repoint (from the stats page) ────────── */
if ($method === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true) ?: $_POST;
    $action = $in['action'] ?? '';
    $dest   = trim($in['dest'] ?? '');
    if (!preg_match('~^https?://~i', $dest)) out(['error' => 'Destination must start with http:// or https://'], 400);

    if ($action === 'create') {
        $label = mb_substr(trim($in['label'] ?? ''), 0, 120);
        $r = withStore(function (&$d) use ($dest, $label) {
            do { $code = randomId(6); } while (isset($d['links'][$code]));
            $token = randomId(12);
            $d['links'][$code] = [
                'dest' => $dest, 'label' => $label, 'token' => $token, 'hits' => 0,
                'created' => gmdate('Y-m-d H:i:s'), 'last_scan' => '', 'days' => [],
            ];
            return ['code' => $code, 'token' => $token];
        });
        out(['code' => $r['code'], 'url' => shortUrl($r['code']), 'stats' => statsUrl($r['token'])]);
    }

    if ($action === 'repoint') {
        $token = preg_replace('/[^A-Za-z0-9]/', '', $in['token'] ?? '');
        $ok = withStore(function (&$d) use ($token, $dest) {
            $code = findByToken($d['links'], $token);
            if (!$code) return false;
            $d['links'][$code]['dest'] = $dest;
            return true;
        });
        if (!$ok) out(['error' => 'Unknown stats token.'], 404);
        header('Location: ' . baseUrl() . '?s=' . $token . '&saved=1', true, 303);   // back to the stats page
        exit;
    }

    out(['error' => 'Unknown action.'], 400);
}

out(['error' => 'Bad request.'], 400);
