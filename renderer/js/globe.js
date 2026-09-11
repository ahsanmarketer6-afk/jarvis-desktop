/* ══════════════════════════════════════════════════════════════════
   JARVIS OS — Neural Harmonic Core (particle sphere globe)
   Fibonacci-sphere dot cloud, 4 states: idle/listening/thinking/speaking
   Colors match reference: mint/teal dots + white sparks + green core
   ══════════════════════════════════════════════════════════════════ */

(function () {
  const N_POINTS = 1500;
  const PALETTE = [
    { c: [46, 230, 168], w: 0.55 },   // mint green
    { c: [58, 160, 128], w: 0.20 },   // deeper teal
    { c: [125, 255, 210], w: 0.15 },  // bright mint
    { c: [230, 255, 245], w: 0.10 }   // white spark
  ];

  let canvas = null, ctx = null, raf = null;
  let W = 0, H = 0, dpr = 1;
  let points = [];
  let rotY = 0, rotX = -0.28;
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
        sz: 0.9 + Math.random() * 1.6,
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

    // rotation speed per state
    let speed = 0.14;
    if (state === 'listening') speed = 0.22;
    if (state === 'thinking') speed = 1.15;
    if (state === 'speaking') speed = 0.32;
    rotY += speed * dt;
    if (state === 'thinking') rotX = -0.28 + Math.sin(t * 0.8) * 0.22;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.36;
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);

    // faint depth halo behind sphere (very subtle, keeps bg dark)
    const halo = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.15);
    halo.addColorStop(0, 'rgba(46,230,168,0.045)');
    halo.addColorStop(0.7, 'rgba(46,230,168,0.015)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

    const breath = 1 + Math.sin(t * 1.1) * 0.008;

    for (const p of points) {
      // rotate Y
      let x = p.x * cosY + p.z * sinY;
      let z = -p.x * sinY + p.z * cosY;
      const y = p.y;
      // tilt X
      const y2 = y * cosX - z * sinX;
      z = y * sinX + z * cosX;

      const depth = (z + 1) / 2;             // 0 back → 1 front
      let b = 0.22 + 0.78 * depth;           // base brightness
      let sz = p.sz * (0.7 + 0.6 * depth);

      // state effects
      if (state === 'listening') {
        const wave = Math.sin(y * 6.5 - t * 5.2 + p.phase * 0.3);
        if (wave > 0.55) { b += 0.55 * (wave - 0.55) * 2.2; sz += 0.8; }
      } else if (state === 'thinking') {
        if (p.rnd < 0.03) { const f = Math.abs(Math.sin(t * 6 + p.phase * 9)); b += f * 0.7; sz += f; }
      } else if (state === 'speaking') {
        const band = Math.abs(Math.sin(y * 9 + t * 8.5));
        b += band * 0.65 * depth;
        sz += band * 0.7 * depth;
      } else {
        // idle: slow gentle shimmer
        b += Math.sin(t * 0.9 + p.phase) * 0.06;
      }

      b = Math.max(0.08, Math.min(1.15, b));
      const [cr, cg, cb] = p.col;
      ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + b.toFixed(3) + ')';
      const sx = cx + x * R * breath;
      const sy = cy + y2 * R * breath;
      ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
    }

    // bright core dot at center (like reference)
    const coreR = state === 'speaking' ? 5 + Math.sin(t * 10) * 2.2
      : state === 'thinking' ? 4 + Math.sin(t * 7) * 1.2 : 3.4;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 5);
    core.addColorStop(0, 'rgba(120,255,200,0.95)');
    core.addColorStop(0.25, 'rgba(46,230,168,0.55)');
    core.addColorStop(1, 'rgba(46,230,168,0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(220,255,240,0.95)';
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
      if (window.ResizeObserver) {
        new ResizeObserver(resize).observe(container);
      } else {
        window.addEventListener('resize', resize);
      }
      this.start();
    },
    setState(s) { if (['idle', 'listening', 'thinking', 'speaking'].includes(s)) state = s; },
    getState() { return state; },
    start() { if (!running) { running = true; lastTs = 0; raf = requestAnimationFrame(draw); } },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; }
  };
})();
