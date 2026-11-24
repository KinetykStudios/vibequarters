// The voice mode's wave (assistant.js draws it at the top of the Dashboard's Assistant module while the open mic is
// on): two thin lines across the stage, the owner's in the accent swelling in from the right, where their words sit,
// and the assistant's in the muted ink from the left, where its words sit, each as loud as voice.js levels() reads it;
// at rest they barely breathe. The module's glow follows the same two levels (--you-l, --ai-l). Reduced motion keeps
// the swell, not the drift.
export function waveY(u, amp, phase, side) {
  const reach = side === "you" ? u ** 3 : (1 - u) ** 3;
  return Math.sin(u * 18 + (side === "you" ? -phase : phase)) * (2 + amp * 70 * reach) * Math.sin(u * Math.PI);
}

// Draws every frame until the returned stop() is called; read() gives { you, ai }, each 0 to 1
export function mountWave(canvas, read, glow) {
  const ctx = canvas.getContext("2d"), still = matchMedia("(prefers-reduced-motion: reduce)");
  let you = 0, ai = 0, phase = 0, raf = 0;
  const line = (w, h, amp, side, color) => {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const y = h / 2 + waveY(x / w, amp, phase, side);
      if (x) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35 + amp * 0.65;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  };
  const frame = () => {
    if (!canvas.isConnected) return; // its panel was drawn again or taken off the page
    raf = requestAnimationFrame(frame);
    const r = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * r) || canvas.height !== Math.round(h * r)) [canvas.width, canvas.height] = [Math.round(w * r), Math.round(h * r)];
    const lv = read();
    you += (lv.you - you) * 0.25;
    ai += (lv.ai - ai) * 0.25;
    if (!still.matches) phase += 0.14;
    const css = getComputedStyle(canvas);
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, w, h);
    line(w, h, ai, "ai", css.getPropertyValue("--muted").trim());
    line(w, h, you, "you", css.getPropertyValue("--accent-ink").trim());
    ctx.globalAlpha = 1;
    if (glow) {
      glow.style.setProperty("--you-l", you.toFixed(3));
      glow.style.setProperty("--ai-l", ai.toFixed(3));
    }
  };
  frame();
  return () => cancelAnimationFrame(raf);
}
