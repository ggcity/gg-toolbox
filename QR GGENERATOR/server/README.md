# GG QR — dynamic (trackable) QR codes

A tracked QR doesn't encode the destination directly — it encodes a short link
on **our own server** (`q.php?c=CODE`). Each scan is counted there and instantly
302-redirected to the real page. Because the printed code points at us, the
destination can be **changed later without reprinting**.

Everything is one PHP file with a JSON data store. No database server, no
frameworks, no PHP extensions beyond the core — and no accounts or passwords
for employees.

## How employees use it (the whole flow)

1. In the QR generator, type the web address in **Content**.
2. Open **Scan tracking**, name the QR ("Fall Festival flyer"), click
   **Track this QR**. The QR on screen now counts scans.
3. They get a private **stats link** — a friendly page with the scan count,
   a 14-day activity chart, and a form to change the destination later.
   **The stats link is the key**: whoever has it can view stats and re-point
   that code. They should bookmark it (the panel has Copy / Open buttons).

The generator also remembers every code created **in that browser** under
"Your tracked QRs on this computer", with one-click Stats / Make QR buttons.

## Lost stats links — three layers of storage

1. **Browser** — the generator lists codes created on that computer.
2. **Server** — everything lives permanently in `qr-links.json`.
3. **Admin directory** — open `q.php?admin=YOUR-ADMIN-KEY` for a page listing
   every code with its name, scan count, destination, and stats link. If
   someone loses their link, look it up there and send it to them.

## Deploy (5 minutes)

1. Copy `q.php` onto the web server — easiest is the **same folder** as
   `index.html` (the generator auto-detects it there).
2. Edit `q.php` and change `ADMIN_KEY` (the admin directory refuses to open
   while the key is still the placeholder).
3. Make sure PHP can **write to that directory** (it creates `qr-links.json`).

## Optional: pretty short URLs

`/q.php?c=Ab3xYz` works everywhere with zero config. For
`https://ggcity.org/q/Ab3xYz`, add a rewrite and set `PRETTY_BASE` in `q.php`:

Apache (`.htaccess` at the site root):

    RewriteEngine On
    RewriteRule ^q/([A-Za-z0-9]+)$ /path/to/q.php?c=$1 [L]

nginx:

    location ~ ^/q/([A-Za-z0-9]+)$ { rewrite ^ /path/to/q.php?c=$1 last; }

## Notes

- **Counting**: every HTTP GET on the short link counts as one scan; `HEAD`
  requests (chat/email link previews) are ignored. Treat counts as
  very-close-to-exact, not forensic.
- **Creating codes is open** to anyone who can reach `q.php` — it's meant to
  sit on the city network next to the generator. Keep it off the public
  internet, or put the folder behind your normal intranet access control.
- **Per-day history** is kept 180 days per code (for the stats chart);
  lifetime totals are kept forever.
- **Backup** = copy `qr-links.json`. It's human-readable.
- **Capacity**: flock-guarded JSON is comfortably fine into many thousands of
  scans/day; the same API could be re-backed with SQLite later without
  touching the generator.
