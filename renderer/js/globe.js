/* ══════════════════════════════════════════════════════════════════
   JARVIS OS — Neural Harmonic Core v2 (particle sphere globe)
   • Shape is CONSTANT in every mode — only animation changes
   • Premium slow motion per state: idle / listening / thinking / speaking
   • Inner dots tint white (like reference), outer stay green
   ══════════════════════════════════════════════════════════════════ */

(function () {
  const N_POINTS = 1600;
  const PALETTE = [
    { c: [46, 214, 160], w: 0.55 },   // mint green (softened)
    { c: [52, 150, 120], w: 0.20 },   // deeper teal
    { c: [118, 240, 196], w: 0.15 },  // bright mint
    { c: [225, 245, 238], w: 0.10 }   // near-white spark
  ];
  const WHITE = [235, 245, 240];

  let canvas = null, ctx = null, raf = null;
  let W = 0, H = 0, dpr = 1;
  let points = [];
  let rotY = 0;
  const TILT = -0.30;                 // fixed tilt — shape never changes
  let state = 'idle';
  let running = false;
  let t = 0, lastTs = 0;

  function pickColor() {
    let r = Math.random(), acc = 0;
    for (const p of PALETTE) { acc += p.w; if (r <= acc) return p.c; }
    return PALETTE[0].c;
  }

  function buildPoints() {
    points = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N_POINTS; i++) {
      const y = 1 - (i / (N_POINTS - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      points.push({
        x: Math.cos(theta) * rad,
        y,
        z: Math.sin(theta) * rad,
        col: pickColor(),
        sz: 0.9 + Math.random() * 1.5,
        rnd: Math.random(),
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  function resize() {
    if (!canvas || !canvas.parentElement) return;
    dpr = window.devicePixelRatio || 1;
    W = canvas.parentElement.clientWidth;
    H = canvas.parentElement.clientHeight;
    canvas.width = Math.max(10, W * dpr);
    canvas.height = Math.max(10, H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }

  function draw(ts) {
    if (!running || !ctx) return;
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;
    t += dt;

    // ── per-state motion profile (slow & premium) ──
    let speed = 0.10;                                   // idle: calm drift
    if (state === 'listening') speed = 0.16;            // gentle quicken
    if (state === 'thinking')  speed = 0.34;            // measured spin
    if (state === 'speaking')  speed = 0.22;            // soft pulse-rotate
    rotY += speed * dt;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.42;                    // bigger globe
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosX = Math.cos(TILT), sinX = Math.sin(TILT);

    // very subtle center halo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.12);
    halo.addColorStop(0, 'rgba(46,214,160,0.05)');
    halo.addColorStop(0.7, 'rgba(46,214,160,0.015)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

    for (const p of points) {
      // rotate Y, then fixed tilt X
      const x = p.x * cosY + p.z * sinY;
      const z1 = -p.x * sinY + p.z * cosY;
      const y2 = p.y * cosX - z1 * sinX;
      const z = p.y * sinX + z1 * cosX;

      const depth = (z + 1) / 2;                        // 0 back → 1 front
      const proj = Math.sqrt(x * x + y2 * y2);          // projected dist from center
      let b = 0.20 + 0.80 * depth;
      let sz = p.sz * (0.7 + 0.55 * depth);

      // ── state overlays (same shape, only light/motion differ) ──
      if (state === 'listening') {
        const wave = Math.sin(p.y * 5.0 - t * 2.6 + p.phase * 0.25);
        if (wave > 0.6) b += (wave - 0.6) * 0.9;
      } else if (state === 'thinking') {
        const f = Math.sin(t * 1.6 + p.phase * 3.0);
        if (p.rnd < 0.10 && f > 0.4) b += (f - 0.4) * 0.5;
      } else if (state === 'speaking') {
        const band = Math.sin(p.y * 7.0 + t * 3.2);
        b += Math.max(0, band) * 0.45 * depth;
        sz += Math.max(0, band) * 0.4 * depth;
      } else {
        b += Math.sin(t * 0.7 + p.phase) * 0.05;        // idle shimmer
      }

      b = Math.max(0.08, Math.min(1.05, b));

      // ── inner-white blending (projected center → white) ──
      let cr, cg, cb;
      const whiteMix = Math.max(0, 1 - proj / 0.48) * 0.8;
      if (whiteMix > 0.01) {
        cr = p.col[0] + (WHITE[0] - p.col[0]) * whiteMix;
        cg = p.col[1] + (WHITE[1] - p.col[1]) * whiteMix;
        cb = p.col[2] + (WHITE[2] - p.col[2]) * whiteMix;
      } else { cr = p.col[0]; cg = p.col[1]; cb = p.col[2]; }

      ctx.fillStyle = 'rgba(' + (cr | 0) + ',' + (cg | 0) + ',' + (cb | 0) + ',' + b.toFixed(3) + ')';
      const sx = cx + x * R;
      const sy = cy + y2 * R;
      ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
    }

    // bright core dot
    const coreR = state === 'speaking' ? 4.2 + Math.sin(t * 4.5) * 1.1
      : state === 'thinking' ? 3.8 + Math.sin(t * 3.0) * 0.6 : 3.4;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 5);
    core.addColorStop(0, 'rgba(210,255,235,0.95)');
    core.addColorStop(0.25, 'rgba(46,214,160,0.5)');
    core.addColorStop(1, 'rgba(46,214,160,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(235,255,248,0.95)';
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 0.55, 0, Math.PI * 2);
    ctx.fill();

    raf = requestAnimationFrame(draw);
  }

  window.NeuralGlobe = {
    mount(container) {
      if (canvas && canvas.parentElement === container) { this.start(); return; }
      container.innerHTML = '';
      canvas = document.createElement('canvas');
      canvas.className = 'globe-canvas';
      container.appendChild(canvas);
      ctx = canvas.getContext('2d');
      if (!points.length) buildPoints();
      resize();
      if (window.ResizeObserver) new ResizeObserver(resize).observe(container);
      else window.addEventListener('resize', resize);
      this.start();
    },
    setState(s) { if (['idle', 'listening', 'thinking', 'speaking'].includes(s)) state = s; },
    getState() { return state; },
    start() { if (!running) { running = true; lastTs = 0; raf = requestAnimationFrame(draw); } },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; }
  };
})();
