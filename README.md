# GG IT Toolbox

Internal web tools for City of Garden Grove staff. Live at **https://gg-toolbox.web.app**.

Contact: nikitas@ggcity.org

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
user's machine. The only server-side pieces are QR scan tracking and the usage counters.

## Hosting

Firebase project **`ggapp-d2bae`**, config in `firebase.json`:

- **Two Hosting targets**:
  - `gg-toolbox` → serves the repo root (staff-facing site, gg-toolbox.web.app)
  - `ggc-go` → serves `qr-public/` (resident-facing short-link domain, ggc-go.web.app;
    `/` redirects to ggcity.org)
- **One Cloud Function** (`qr`, Node 22, us-central1, codebase `qrtracking` in
  `functions/`). Hosting rewrites route `/q/**`, `/s/**`, `/api/qr`, `/api/stats`,
  and `/qradmin` to it (`pinTag: true`); the `ggc-go` target only rewrites
  `/q/**` and `/s/**`.
- **Firestore** stores QR links and counters. `firestore.rules` denies all direct
  client access except **read-only** on `stats/counters`.

Deploy:

```bash
firebase deploy --only hosting:gg-toolbox            # pages only
firebase deploy --only functions,firestore:rules     # backend
```

Function config lives in `functions/.env` (git-ignored; template in `.env.example`).

## QR scan tracking

- "Track this QR" calls `POST /api/qr {action:"create"}` → Firestore doc in `qrLinks`
  (6-char code, destination, label) → the QR encodes `https://ggc-go.web.app/q/CODE`.
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
  `POST /api/stats {tool, n}` (n clamped to 1–500; honor-system, same trust level as
  the open create API). The two dynamic-QR counters increment **server-side** in the
  create/scan paths and can't be inflated by clients.
- The **launcher** subscribes with the Firestore web SDK (`onSnapshot`) and shows each
  tool's counters under its tile — live updates count up, flash amber, fade back.
  The console ticker rotates totals. Widgets are fail-soft: no network → no stats,
  tools unaffected.
- `GET /api/stats` returns the counters; the first call ever seeded them from
  existing `qrLinks` history.

## /qradmin — admin directory

Recovery directory listing every tracked code (find lost stats links, delete codes).

**Current state: shared-key access.** `/qradmin?key=…` with `QR_ADMIN_KEY` from
`functions/.env`. The wrong/no key → 403.

**Target state: city SSO (Keycloak OIDC).** The full implementation is committed —
see `git revert 0e5275f` — but needs the Secret Manager API enabled by a project
owner before it can deploy. The workflow:

1. `GET /qradmin` with no session → the function generates `state`, `nonce`, and a
   PKCE verifier, stores them in a short-lived HMAC-signed cookie, and 302s to
   Keycloak (`OIDC_ISSUER`, realm `internal`, endpoints from OIDC discovery).
2. User signs in with city AD credentials → Keycloak redirects to
   `GET /oauth2-callback?code=…&state=…`.
3. The function verifies `state`, exchanges the code for tokens over TLS
   (client secret + PKCE verifier), and validates the ID token's issuer, audience,
   expiry, and `nonce` (per OIDC Core §3.1.3.7, no JWKS check needed — the token
   comes straight from the token endpoint).
4. Optional allow-list: `OIDC_ADMIN_USERS` (comma-separated AD usernames); empty
   admits any signed-in city employee.
5. An 8-hour session is written to the **`__session`** cookie (the only cookie
   Firebase Hosting forwards to functions), HMAC-signed with a key derived from the
   client secret. `/qradmin/logout` clears it and ends the Keycloak SSO session.

To switch over: a project owner enables Secret Manager
(`console.cloud.google.com/apis/library/secretmanager.googleapis.com?project=ggapp-d2bae`),
IT registers a Keycloak client with redirect URI
`https://gg-toolbox.web.app/oauth2-callback`, then:

```bash
firebase functions:secrets:set OIDC_CLIENT_SECRET   # the Keycloak client secret
# set OIDC_CLIENT_ID in functions/.env, then:
git revert 0e5275f
firebase deploy --only functions
```

## Local development

```bash
cd functions && npm install
firebase emulators:start --only functions,firestore,hosting
```

- Needs Java (Firestore emulator) and `OIDC_CLIENT_SECRET=dummy` in
  `functions/.secret.local` (git-ignored).
- Test hooks on the pages: `localStorage.ggstats_fs_emu = "127.0.0.1:8080"` points
  the launcher's stats listener at the Firestore emulator;
  `localStorage.ggstats_ep` / `localStorage.ggqr_track_ep` override the report/track
  endpoints.
- Wipe emulator data:
  `curl -X DELETE 'http://127.0.0.1:8080/emulator/v1/projects/ggapp-d2bae/databases/(default)/documents'`

## Conventions

New tools follow the family pattern (see PDF MERGGER as reference): navy header bar
with pixel back-arrow + contact-IT button (generic "contact the IT Department"
tooltip/toast — no personal addresses) + theme toggle, hero title riding over the
header, light/dark themes via `data-theme` + per-app localStorage key, Barlow /
Barlow Condensed / Press Start 2P, shared favicon `/logo.svg`, `robots noindex`,
clean-URL rewrite in `firebase.json`, a tile card in the launcher.
