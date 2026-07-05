/* Звуковой движок на Web Audio API — все звуки синтезируются в браузере,
   без файлов. Экспортируется как window.SFX. */
(function () {
  let ctx = null;
  let master = null;
  let muted = localStorage.getItem('pokerMuted') === '1';
  let noiseBuf = null;

  function ensure() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    // Буфер белого шума для перкуссии/шорохов.
    const len = ctx.sampleRate * 1;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  // Разблокировка звука по первому жесту пользователя (политика автоплея).
  function unlock() {
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  const now = () => ctx.currentTime;

  function tone(freq, opts = {}) {
    if (!ctx || muted) return;
    const { type = 'sine', dur = 0.15, attack = 0.005, gain = 0.2, slideTo = null, delay = 0 } = opts;
    const t0 = now() + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  function noise(opts = {}) {
    if (!ctx || muted) return;
    const { dur = 0.12, gain = 0.2, type = 'bandpass', freq = 1200, q = 1, sweepTo = null, delay = 0 } = opts;
    const t0 = now() + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t0);
    if (sweepTo) filt.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt); filt.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  function vibrate(pattern) {
    if (!muted && navigator.vibrate) navigator.vibrate(pattern);
  }

  // ---- Конкретные звуки ----
  const SFX = {
    chip(count = 2) {
      ensure();
      for (let i = 0; i < count; i++) {
        const d = i * 0.045;
        noise({ dur: 0.05, gain: 0.18, type: 'highpass', freq: 4000, delay: d });
        tone(2200 + Math.random() * 600, { type: 'triangle', dur: 0.05, gain: 0.09, delay: d });
      }
      vibrate(12);
    },
    deal(n = 1) {
      ensure();
      for (let i = 0; i < n; i++) {
        noise({ dur: 0.11, gain: 0.16, type: 'bandpass', freq: 1800, q: 0.7, sweepTo: 600, delay: i * 0.09 });
      }
    },
    check() {
      ensure();
      tone(160, { type: 'triangle', dur: 0.07, gain: 0.28 });
      tone(150, { type: 'triangle', dur: 0.07, gain: 0.22, delay: 0.1 });
      vibrate(18);
    },
    call() { this.chip(2); },
    raise() {
      this.chip(3);
      tone(400, { type: 'sine', dur: 0.18, gain: 0.14, slideTo: 720 });
      vibrate([15, 20, 25]);
    },
    fold() {
      ensure();
      noise({ dur: 0.22, gain: 0.14, type: 'lowpass', freq: 1200, sweepTo: 300 });
      tone(220, { type: 'sine', dur: 0.18, gain: 0.08, slideTo: 120 });
    },
    allin() {
      ensure();
      // Драматичный райзер + колокол.
      tone(180, { type: 'sawtooth', dur: 0.55, gain: 0.16, slideTo: 900 });
      noise({ dur: 0.55, gain: 0.12, type: 'bandpass', freq: 400, q: 2, sweepTo: 3000 });
      tone(880, { type: 'sine', dur: 0.5, gain: 0.16, delay: 0.5 });
      tone(1320, { type: 'sine', dur: 0.5, gain: 0.1, delay: 0.5 });
      vibrate([80, 40, 80, 40, 200]);
    },
    win() {
      ensure();
      // Фанфара: восходящее мажорное арпеджио + блеск.
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        tone(f, { type: 'triangle', dur: 0.35, gain: 0.22, delay: i * 0.1 });
        tone(f * 2, { type: 'sine', dur: 0.25, gain: 0.06, delay: i * 0.1 });
      });
      noise({ dur: 0.5, gain: 0.06, type: 'highpass', freq: 6000, delay: 0.4 });
      vibrate([60, 30, 60, 30, 140]);
    },
    lose() {
      ensure();
      tone(300, { type: 'sine', dur: 0.4, gain: 0.14, slideTo: 140 });
    },
    turn() {
      ensure();
      // Мягкий двойной колокольчик — «твой ход».
      tone(880, { type: 'sine', dur: 0.22, gain: 0.16 });
      tone(1174, { type: 'sine', dur: 0.28, gain: 0.14, delay: 0.13 });
      vibrate(30);
    },
    ui() {
      ensure();
      tone(600, { type: 'triangle', dur: 0.04, gain: 0.06 });
    },
    pop() {
      ensure();
      tone(500, { type: 'sine', dur: 0.14, gain: 0.16, slideTo: 1000 });
      noise({ dur: 0.06, gain: 0.05, type: 'highpass', freq: 3000 });
    },

    // ---- Управление ----
    isMuted() { return muted; },
    setMuted(v) {
      muted = !!v;
      localStorage.setItem('pokerMuted', muted ? '1' : '0');
      if (!muted) unlock();
    },
    toggle() { this.setMuted(!muted); return muted; },
  };

  window.SFX = SFX;
})();
