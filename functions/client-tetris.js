/* GG QR — ambient self-playing Tetris wells for the stats & admin pages.
   Ported VERBATIM from the QR generator's background animation (same
   beveled amber 3D blocks), with two tweaks for these pages: the clear
   zone matches the ~720px card, and the first block drops sooner.
   Served as text and injected inside <script> by the Cloud Function. */
(function tetrisBackground() {
  const canvas = document.getElementById('tetris-bg');
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');

  const CONTENT_W = 800;    // == card width + margins; the clear zone in the middle
  const GUTTER_MIN = 120;   // minimum side room before a well is worth drawing
  const CELL_TARGET = 40;   // preferred block size — actual size flexes to fill
  const CELL_MIN = 32, CELL_MAX = 64;
  const COLS_MIN = 3, COLS_MAX = 16;

  const TETROMINOES = {
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[1,0],[0,1],[1,1],[2,1]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]],
  };
  const KEYS = Object.keys(TETROMINOES);

  // One warm amber→bronze family, echoing the page accent. Cells store an INDEX
  // into this ramp; the actual colour is resolved per-theme at draw time, so a
  // theme toggle just recolours the same running game — no rebuild, no reset.
  const SHADES = {
    light: ['#E4BE6A', '#D2A24C', '#C08A38', '#A87430', '#8E5F26'],
    dark:  ['#F0CE7E', '#E0B25E', '#CE9846', '#B87E36', '#9E6A2E'],
  };
  const SHADE_N = SHADES.light.length;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = a => a[(Math.random() * a.length) | 0];
  const widthOf = cells => Math.max(...cells.map(c => c[0])) + 1;

  function normalize(cells) {
    const mx = Math.min(...cells.map(c => c[0])), my = Math.min(...cells.map(c => c[1]));
    return cells.map(([x, y]) => [x - mx, y - my]);
  }
  function rotate(cells, times) {
    let c = cells.map(p => [p[0], p[1]]);
    for (let t = 0; t < (times & 3); t++) {
      const maxY = Math.max(...c.map(p => p[1]));
      c = c.map(([x, y]) => [maxY - y, x]);
    }
    return normalize(c);
  }
  function rotations(key) {   // unique rotation states, as cell arrays
    const seen = {}, out = [];
    for (let r = 0; r < 4; r++) {
      const cells = rotate(TETROMINOES[key], r);
      const sig = cells.map(c => c.join(':')).sort().join('|');
      if (!seen[sig]) { seen[sig] = 1; out.push(cells); }
    }
    return out;
  }

  function shade(hex, amt) {   // amt<0 → toward black, amt>0 → toward white
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const f = amt < 0 ? 0 : 255, p = Math.abs(amt);
    r = Math.round((f - r) * p + r); g = Math.round((f - g) * p + g); b = Math.round((f - b) * p + b);
    return `rgb(${r},${g},${b})`;
  }

  // ── board logic ─────────────────────────────────────────────────────────────
  function collide(grid, cells, ox, oy, cols, rows) {
    for (const [dx, dy] of cells) {
      const cx = ox + dx, cy = oy + dy;
      if (cx < 0 || cx >= cols || cy >= rows) return true;
      if (cy >= 0 && grid[cy][cx]) return true;
    }
    return false;
  }
  function dropRow(grid, cells, ox, cols, rows) {
    let oy = -4;
    while (!collide(grid, cells, ox, oy + 1, cols, rows)) oy++;
    return oy;
  }
  // classic heuristic (Yiyuan Lee weights) → flat, hole-free, line-clearing play
  function score(grid, cols, rows) {
    const h = new Array(cols).fill(0);
    let holes = 0;
    for (let x = 0; x < cols; x++) {
      let seen = false;
      for (let y = 0; y < rows; y++) {
        if (grid[y][x]) { if (!seen) { h[x] = rows - y; seen = true; } }
        else if (seen) holes++;
      }
    }
    let agg = 0, bump = 0, lines = 0;
    for (let x = 0; x < cols; x++) agg += h[x];
    for (let x = 0; x < cols - 1; x++) bump += Math.abs(h[x] - h[x + 1]);
    for (let y = 0; y < rows; y++) { let f = true; for (let x = 0; x < cols; x++) if (!grid[y][x]) { f = false; break; } if (f) lines++; }
    return -0.510066 * agg + 0.760666 * lines - 0.35663 * holes - 0.184483 * bump;
  }
  function bestPlacement(well, key) {
    const { grid, cols, rows } = well;
    const rots = rotations(key);
    let best = null;
    for (let ri = 0; ri < rots.length; ri++) {
      const cells = rots[ri], w = widthOf(cells);
      for (let x = 0; x <= cols - w; x++) {
        const oy = dropRow(grid, cells, x, cols, rows);
        if (oy < 0) continue;
        for (const [dx, dy] of cells) grid[oy + dy][x + dx] = 1;
        const s = score(grid, cols, rows);
        for (const [dx, dy] of cells) grid[oy + dy][x + dx] = null;
        if (!best || s > best.s) best = { s, ri, x, oy };
      }
    }
    return best;
  }

  function clearFullRows(well) {
    const keep = [];
    for (let y = 0; y < well.rows; y++) {
      let full = true;
      for (let x = 0; x < well.cols; x++) if (!well.grid[y][x]) { full = false; break; }
      if (!full) keep.push(well.grid[y]);
    }
    const removed = well.rows - keep.length;
    for (let i = 0; i < removed; i++) keep.unshift(new Array(well.cols).fill(null));
    well.grid = keep;
    return removed;
  }

  function spawn(well) {
    const key = pick(KEYS);
    const rots = rotations(key), rotN = rots.length;
    const best = bestPlacement(well, key);
    if (!best) { gameOver(well); return; }           // no room left → topple the board
    const start = rots[0], sw = widthOf(start);
    // Like a real player mulling it over, flip the piece a few extra whole turns
    // before committing — always landing on the smart target orientation.
    let extra = 0;
    if (rotN > 1 && Math.random() < 0.7) extra = rotN * (1 + (Math.random() * 2 | 0));   // 1–2 extra spins
    const a = {
      key, rots, shade: (Math.random() * SHADE_N) | 0,
      ri: 0, targetX: best.x,
      spins: best.ri + extra,                        // rotation steps it would like to make
      x: Math.max(0, Math.min(well.cols - sw, (well.cols - sw) >> 1)),
      yf: -Math.max(...start.map(c => c[1])) - 1,    // start just above the top
      vy: Math.random() < 0.25 ? rand(7, 10) : rand(4.5, 7.5),   // calm, steady fall — never a slam
      cols: well.cols, fallAcc: 0, actInterval: rand(0.5, 1.4),
    };
    well.active = a;
  }

  // Flips/shifts still pending as it tries to reach the smart target placement.
  const actionsLeft = a => a.spins + Math.abs(a.targetX - a.x);

  function lockPiece(well, oy) {
    const a = well.active, cells = a.rots[a.ri];
    let hitCeiling = false, ogx = a.x, ogy = 0;
    for (const [dx, dy] of cells) {
      const cy = oy + dy, cx = a.x + dx;
      if (cy <= 0 && !hitCeiling) { hitCeiling = true; ogx = cx; }   // stack reached the top
      if (cy >= 0 && cy < well.rows && cx >= 0 && cx < well.cols) well.grid[cy][cx] = a.shade + 1;   // +1 keeps it truthy (0 = empty)
    }
    well.active = null;
    if (hitCeiling) { gameOver(well, ogx, ogy); return; }   // chain reaction from the impact cell
    const full = [];
    for (let y = 0; y < well.rows; y++) {
      let f = true;
      for (let x = 0; x < well.cols; x++) if (!well.grid[y][x]) { f = false; break; }
      if (f) full.push(y);
    }
    if (full.length) { well.clearRows = full; well.clearT = 0.28; }
    else spawn(well);
  }

  // GAME OVER — retro chain reaction: after a freeze-frame beat, a diamond
  // wavefront sweeps out from the impact point deleting the stack block by
  // block — white flash, then a pixel-stepped shrink (squares stay squares,
  // no physics). When the wave has consumed everything, the column restarts.
  const POP = 0.3, RING = 0.05;                       // per-block pop time, per-ring delay
  function gameOver(well, ogx, ogy) {
    if (ogx === undefined) { ogx = well.cols >> 1; ogy = 0; }
    const parts = [];
    let maxD = 0;
    for (let y = 0; y < well.rows; y++) for (let x = 0; x < well.cols; x++) {
      const v = well.grid[y][x];
      if (!v) continue;
      well.grid[y][x] = null;
      const d = Math.abs(x - ogx) + Math.abs(y - ogy);   // manhattan distance → diamond wave
      if (d > maxD) maxD = d;
      parts.push({ px: well.originX + x * cell, py: well.originY + y * cell, delay: d * RING, shade: v - 1 });
    }
    well.active = null; well.clearRows = []; well.clearT = 0;
    well.over = { t: -0.3, parts, total: maxD * RING + POP };   // t<0 = freeze-frame before the chain
  }

  // ── geometry ─────────────────────────────────────────────────────────────────
  let W, H, dpr, gutter, cols, rows, cell, wells = [], raf = 0, last = 0, theme = 'light';

  function readTheme() { theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

  function buildWells() {
    gutter = (W - CONTENT_W) / 2;
    wells = [];
    if (gutter < GUTTER_MIN) return;
    // Fill the ENTIRE gutter, flush to the screen edge: pick a column count that
    // keeps square cells near the target size, then size the cell so cols * cell
    // spans the full gutter exactly (no leftover gap).
    const avail = gutter;
    cols = Math.max(COLS_MIN, Math.round(avail / CELL_TARGET));
    cell = avail / cols;
    while (cell > CELL_MAX && cols < COLS_MAX) { cols++; cell = avail / cols; }
    while (cell < CELL_MIN && cols > COLS_MIN) { cols--; cell = avail / cols; }
    rows = Math.ceil(H / cell) + 1;
    const originY = H - rows * cell;
    for (const originX of [0, W - gutter]) {
      const grid = [];
      for (let y = 0; y < rows; y++) grid.push(new Array(cols).fill(null));
      const well = { originX, originY, cols, rows, grid, active: null, clearRows: [], clearT: 0, over: null };
      spawn(well);          // start fresh: empty grid, first piece falling in
      wells.push(well);
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildWells();
  }

  // ── update ───────────────────────────────────────────────────────────────────
  function updateWell(well, dt) {
    if (well.over) {                                  // game-over: chain reaction runs on its own clock
      const o = well.over;
      o.t += dt;
      if (o.t >= o.total) { well.over = null; spawn(well); }   // board consumed — fresh game
      return;
    }
    if (well.clearT > 0) {
      well.clearT -= dt;
      if (well.clearT <= 0) { clearFullRows(well); well.clearRows = []; spawn(well); }
      return;
    }
    const a = well.active;
    if (!a) { spawn(well); return; }
    const drop = a.vy * dt;
    a.fallAcc += drop;
    // Twist / shift at randomised moments across the descent — but ONLY if the new
    // orientation/column doesn't overlap the stack or walls, just like a real player.
    if (actionsLeft(a) > 0 && a.fallAcc >= a.actInterval) {
      a.fallAcc = 0;
      const oy = Math.round(a.yf);
      const needRot = a.spins > 0, needMove = a.x !== a.targetX;
      if (needRot && (!needMove || Math.random() < 0.55)) {          // try to flip it…
        const nri = (a.ri + 1) % a.rots.length;
        const nx = Math.max(0, Math.min(a.cols - widthOf(a.rots[nri]), a.x));
        if (!collide(well.grid, a.rots[nri], nx, oy, well.cols, well.rows)) { a.ri = nri; a.x = nx; a.spins--; }
      } else if (needMove) {                                         // …or slide it a column
        const nx = a.x + (a.x < a.targetX ? 1 : -1);
        if (!collide(well.grid, a.rots[a.ri], nx, oy, well.cols, well.rows)) a.x = nx;
      }
      a.actInterval = rand(0.5, 1.4);
    }
    // Fall, and lock the instant it rests on the stack/floor from where it is now —
    // no cutting through: it's placed at its current state right where it hits.
    a.yf += drop;
    const restY = dropRow(well.grid, a.rots[a.ri], a.x, well.cols, well.rows);
    if (a.yf >= restY) { a.yf = restY; lockPiece(well, restY); }
  }

  // ── render ───────────────────────────────────────────────────────────────────
  // Beveled 3D block: light top+left edges, dark bottom+right edges, glossy face.
  function drawCell(px, py, color, alpha, flash) {
    // Snap to whole pixels so neighbouring cells share edges exactly — no seams.
    const x0 = Math.round(px), y0 = Math.round(py);
    const x1 = Math.round(px + cell), y1 = Math.round(py + cell);
    const w = x1 - x0, h = y1 - y0;
    ctx.globalAlpha = alpha;
    if (flash) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(x0, y0, w, h); ctx.globalAlpha = 1; return; }
    const b = Math.max(3, Math.round(cell * 0.2));      // bevel thickness
    const top = shade(color, 0.5), left = shade(color, 0.28);
    const bottom = shade(color, -0.34), right = shade(color, -0.5);
    // outer frame = base, then four bevel facets, then the raised inner face
    ctx.fillStyle = color; ctx.fillRect(x0, y0, w, h);
    ctx.beginPath(); ctx.fillStyle = top;    ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1 - b, y0 + b); ctx.lineTo(x0 + b, y0 + b); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = left;   ctx.moveTo(x0, y0); ctx.lineTo(x0 + b, y0 + b); ctx.lineTo(x0 + b, y1 - b); ctx.lineTo(x0, y1); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = bottom; ctx.moveTo(x0, y1); ctx.lineTo(x0 + b, y1 - b); ctx.lineTo(x1 - b, y1 - b); ctx.lineTo(x1, y1); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.fillStyle = right;  ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1 - b, y1 - b); ctx.lineTo(x1 - b, y0 + b); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(color, 0.1); ctx.fillRect(x0 + b, y0 + b, w - 2 * b, h - 2 * b);   // glossy raised face
    ctx.globalAlpha = alpha * 0.5;                       // tiny corner glint, top-left
    ctx.fillStyle = shade(color, 0.6);
    ctx.fillRect(x0 + b, y0 + b, Math.max(2, Math.round(b * 0.9)), Math.max(2, Math.round(b * 0.9)));
    ctx.globalAlpha = 1;
  }
  function drawWell(well) {
    const palette = SHADES[theme] || SHADES.light;
    const base = theme === 'dark' ? 0.62 : 0.6;
    if (well.over) {                                  // game-over chain reaction, block by block
      const o = well.over;
      for (const p of o.parts) {
        const q = (o.t - p.delay) / POP;
        if (q >= 1) continue;                                                             // consumed
        if (q < 0) { drawCell(p.px, p.py, palette[p.shade], base, false); continue; }     // wave not here yet
        if (q < 0.35) { drawCell(p.px, p.py, palette[p.shade], base, true); continue; }   // white flash
        const s = Math.max(2, Math.round(cell * (1 - (Math.floor((q - 0.35) / 0.65 * 3) + 1) * 0.25)));
        const inset = Math.round((cell - s) / 2);     // pixel-stepped shrink: 75% → 50% → 25%
        ctx.globalAlpha = base;
        ctx.fillStyle = palette[p.shade];
        ctx.fillRect(Math.round(p.px) + inset, Math.round(p.py) + inset, s, s);
        ctx.globalAlpha = 1;
      }
      return;
    }
    for (let y = 0; y < well.rows; y++) for (let x = 0; x < well.cols; x++) {
      const v = well.grid[y][x];
      if (!v) continue;
      const flashing = well.clearT > 0 && well.clearRows.indexOf(y) !== -1 && (Math.floor(well.clearT * 22) & 1) === 0;
      drawCell(well.originX + x * cell, well.originY + y * cell, palette[v - 1], base, flashing);
    }
    const a = well.active;
    if (a) {
      const cells = a.rots[a.ri];
      for (const [dx, dy] of cells)
        drawCell(well.originX + (a.x + dx) * cell, well.originY + (a.yf + dy) * cell, palette[a.shade], base * 0.92, false);
    }
  }

  function frame(t) {
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 0;
    last = t;
    ctx.clearRect(0, 0, W, H);
    for (const well of wells) { updateWell(well, dt); drawWell(well); }
    raf = requestAnimationFrame(frame);
  }
  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  readTheme();
  resize();
  let rt, ready = false;   // hold the game for a moment so the page can settle in first
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { readTheme(); resize(); }, 150); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (ready) start(); });
  // Theme toggle only recolours — the same running game keeps playing.
  new MutationObserver(readTheme)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setTimeout(() => { ready = true; start(); }, 900);   // first block falls shortly after load
})();
