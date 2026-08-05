# GG IT Toolbox

Internal web tools for City of Garden Grove staff. Live at **https://toolbox.ggcity.org**
(city SSO required).

This project is aimed at simplifying processes that city employees do daily. Tools have
custom presets for GG city usage where applicable. To coordinate correct preset
configuration contact Maria Enciso menciso@ggcity.org

## Tools

| Tool | URL | What it does |
|---|---|---|
| IMAGGE COMPRESSOR | `/compressor` | Batch image compression (JPEG/PNG/WebP/GIF/HEIC), max 50 files |
| QR GGENERATOR | `/qr` | Styled QR codes (logos, colors) + optional scan tracking |
| PDF MERGGER | `/merger` | Merge PDFs client-side (pdf-lib) |
| IMAGGE FORMATTER | `/formatter` | Crop/resize images to preset frames |
| Daily Haiku, GGnator | `/haiku`, `/ggnator` | Extras in the launcher's Snack Shack drawer |

Every tool is a **single self-contained `index.html`** — no build step, no framework.
All file processing happens **in the browser**; documents and images never leave the
user's machine. The only server-side pieces are QR scan tracking, the usage counters,
and the SSO gate.

The `sticky-notes/` folder is **not part of the toolbox** — a personal local-only
experiment, excluded from hosting deploys via the `firebase.json` ignore list.

## Access — city SSO (Keycloak OIDC)

The staff site is limited to city employees via the city Keycloak (realm `internal`,
client `toolbox`, redirect URI `https://toolbox.ggcity.org/oauth2-callback`):

- Unauthenticated visits land on `/auth` (static sign-in screen) → `/login?next=…` →
  Keycloak → `GET /oauth2-callback`. The function verifies `state`, exchanges the code
  (client secret + PKCE verifier), and validates the ID token's issuer, audience,
  expiry, and `nonce` (per OIDC Core §3.1.3.7 — the token comes straight from the
  token endpoint, so no JWKS check needed).
- Any signed-in city account gets an **8-hour session** in the `__session` cookie
  (the only cookie Firebase Hosting forwards to functions), HMAC-signed with a key
  derived from the client secret. `/qradmin/logout` clears it and ends the Keycloak
  SSO session.
- Every page carries a small **STAFF GATE** script that probes `GET /api/session`
  and bounces signed-out visitors to `/auth`. It's a soft gate — the hard,
  server-side enforcement is on the writes: `POST /api/qr {action:"create"}` and
  `POST /api/stats` require a session.
- Resident-facing routes (`/q/**` scans, `/s/**` stats pages) stay public.
- Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_ADMIN_USERS` in `functions/.env`;
  the client secret lives in Cloud Secret Manager
  (`firebase functions:secrets:set OIDC_CLIENT_SECRET`).

## Hosting

Firebase project **`gg-toolbox`** (its own project — migrated out of `ggapp-d2bae`
in July 2026), config in `firebase.json`:

- **Two Hosting targets**:
  - `gg-toolbox` → serves the repo root (staff-facing site, toolbox.ggcity.org /
    ggcity-toolbox.web.app)
  - `ggc-go` → serves `qr-public/` (resident-facing short-link domain, qr.gg.city /
    go-ggcity.web.app; `/` redirects to ggcity.org)
- **One Cloud Function** (`qr`, Node 22, us-central1, codebase `qrtracking` in
  `functions/`). Hosting rewrites route `/q/**`, `/s/**`, `/api/qr`, `/api/stats`,
  `/api/session`, `/login`, `/oauth2-callback`, and `/qradmin` to it (`pinTag: true`);
  the `ggc-go` target only rewrites `/q/**` and `/s/**`.
- **Firestore** stores QR links and counters. `firestore.rules` denies all direct
  client access except **read-only** on `stats/counters`.

Deploy:

```bash
firebase deploy --only hosting:gg-toolbox            # pages only
firebase deploy --only functions,firestore:rules     # backend
```

Function config lives in `functions/.env` (git-ignored; template in `.env.example`).

## QR scan tracking

- "Track this QR" calls `POST /api/qr {action:"create"}` (staff session required) →
  Firestore doc in `qrLinks` (6-char code, destination, label) → the QR encodes
  `https://qr.gg.city/q/CODE`. Older printed codes encode `go-ggcity.web.app` —
  that domain stays attached, so they keep working.
- Each scan of `/q/CODE` increments `hits` + per-day (pruned after 180 days) and
  per-month (kept forever) rollups, then 302s to the destination. Bots, link-preview
  unfurlers, and prefetches are filtered by User-Agent and never counted.
- The creator gets a private **stats link** `/s/TOKEN` — scan count, activity chart,
  a form to re-point the destination (printed codes keep working), and downloads of
  the designed QR (stored via `action:"setdesign"` in the `qrDesigns` collection).
  The token is the only credential; removed/unknown codes redirect to `QR_FALLBACK_URL`.

## Live usage stats

- One Firestore doc `stats/counters` holds six counters: `imagesCompressed`,
  `imagesFormatted`, `pdfsMerged`, `qrGenerated`, `dynamicQrCreated`, `dynamicQrScans`.
- The three browser-side tools + QR downloads report finished work via
  `POST /api/stats {tool, n}` (n clamped to 1–500; honor-system, staff session
  required). The two dynamic-QR counters increment **server-side** in the
  create/scan paths and can't be inflated by clients.
- The **launcher** subscribes with the Firestore web SDK (`onSnapshot`) and shows each
  tool's counters under its tile — live updates count up, flash amber, fade back.
  The console ticker rotates totals. Widgets are fail-soft: no network → no stats,
  tools unaffected.
- `GET /api/stats` returns the counters; the first call ever seeded them from
  existing `qrLinks` history.

## /qradmin — admin directory

Recovery directory listing every tracked code (find lost stats links, delete codes).

City SSO required (see **Access** above) **plus** the `OIDC_ADMIN_USERS` allow-list:
comma-separated usernames matched against the ID token's `preferred_username`
(case-insensitive); empty admits any signed-in city employee. Non-listed staff get
a 403 page. Updating the list = edit `functions/.env`, `firebase deploy --only
functions`. The legacy `QR_ADMIN_KEY` shared-key gate is retired.

## Local development

```bash
cd functions && npm install
firebase emulators:start --only functions,firestore,hosting
```

- Needs Java (Firestore emulator) and `OIDC_CLIENT_SECRET=dummy` in
  `functions/.secret.local` (git-ignored).
- The STAFF GATE skips `localhost` / `127.0.0.1`, so pages work in the emulator
  without SSO.
- Test hooks on the pages: `localStorage.ggstats_fs_emu = "127.0.0.1:8080"` points
  the launcher's stats listener at the Firestore emulator;
  `localStorage.ggstats_ep` / `localStorage.ggqr_track_ep` override the report/track
  endpoints.
- Wipe emulator data:
  `curl -X DELETE 'http://127.0.0.1:8080/emulator/v1/projects/gg-toolbox/databases/(default)/documents'`

## Conventions

New tools follow the family pattern (see PDF MERGGER as reference): navy header bar
with pixel back-arrow + contact-IT button (generic "contact the IT Department"
tooltip/toast — no personal addresses) + theme toggle, hero title riding over the
header, light/dark themes via `data-theme` + per-app localStorage key, Barlow /
Barlow Condensed / Press Start 2P, shared favicon `/logo.svg`, `robots noindex`,
clean-URL rewrite in `firebase.json`, a tile card in the launcher, and the
**STAFF GATE** script right after `</title>` (copy it from any tool page).
