// All mascot styles, injected into the closed shadow root so the page's CSS cannot reach in and ours cannot leak out.

export const STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

.root {
  --accent: #1f7a60;
  --accent-fg: #ffffff;
  --bg: #ffffff;
  --fg: #1d2127;
  --muted: #5f6672;
  --border: rgba(15, 23, 42, 0.12);
  --surface: #f3f5f7;
  --user-bg: #1f7a60;
  --user-fg: #ffffff;
  --danger: #c43333;
  --danger-fg: #ffffff;
  --focus: #2563eb;
  --link: #0b63c5;
  --hl: #ef9f27;
  --shadow: 0 12px 32px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.08);
  pointer-events: none;
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  text-align: left;
  letter-spacing: normal;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .root {
    --accent: #5dcaa5;
    --accent-fg: #0b1f18;
    --bg: #1c1f25;
    --fg: #e8eaee;
    --muted: #9aa1ad;
    --border: rgba(255, 255, 255, 0.12);
    --surface: #282c34;
    --user-bg: #2f6f5c;
    --user-fg: #f2fbf8;
    --danger: #f06565;
    --danger-fg: #1c0a0a;
    --focus: #7aa7ff;
    --link: #7cc7ff;
    --shadow: 0 12px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  }
}
.root.hidden { display: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ---------- orb ---------- */
.mover {
  --size: 44px; --orb: #5dcaa5; --lvl: 0; --lx: 0; --ly: 0;
  position: fixed; left: 0; top: 0;
  width: var(--size); height: var(--size);
  pointer-events: none;
  will-change: transform;
  opacity: 0;
  z-index: 100;
  transition: opacity 0.3s ease;
}
.mover.placed { opacity: 1; }
.orb-btn {
  all: unset;
  box-sizing: border-box;
  position: absolute; inset: 0;
  border-radius: 50%;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
.orb-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 5px; }
.dragging .orb-btn { cursor: grabbing; }
.parked .orb-btn::after {
  content: ""; position: absolute; left: 50%; bottom: -7px;
  width: 4px; height: 4px; margin-left: -2px; border-radius: 50%;
  background: var(--muted); opacity: 0.7;
}
.anim { position: absolute; inset: 0; transform-origin: 50% 75%; }
.orb {
  position: absolute; inset: 0;
  border-radius: 50%;
  background-color: var(--orb);
  box-shadow:
    0 6px 14px -4px color-mix(in srgb, var(--orb) 75%, transparent),
    0 1px 3px rgba(0, 0, 0, 0.18),
    inset 0 -5px 10px rgba(0, 0, 0, 0.1),
    inset 0 4px 8px rgba(255, 255, 255, 0.35);
  transition: background-color 0.45s ease, box-shadow 0.45s ease, filter 0.2s ease;
}
.orb-btn:hover .orb { filter: brightness(1.05) saturate(1.05); }
.shine {
  position: absolute; left: 18%; top: 11%; width: 36%; height: 24%;
  border-radius: 50%;
  background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0) 70%);
  transform: rotate(-22deg);
}
.eyes {
  position: absolute; inset: 0;
  transform: translate(calc(var(--lx) * var(--size) * 0.07), calc(var(--ly) * var(--size) * 0.07));
  transition: transform 0.25s ease;
}
.eye {
  position: absolute; top: 36%;
  width: 13%; height: 24%;
  background: #1f2430;
  border-radius: 999px;
  transform-origin: 50% 60%;
  transition: transform 0.09s ease, height 0.2s ease, top 0.2s ease;
}
.eye:first-child { left: 29%; }
.eye:last-child { right: 29%; }
.eyes.blink .eye { transform: scaleY(0.1); }
.m-sleeping .eye { transform: scaleY(0.12); top: 46%; }
.m-happy .eye, .m-celebrate .eye {
  top: 38%; width: 16%; height: 13%;
  background: transparent;
  border: calc(var(--size) * 0.055) solid #1f2430;
  border-bottom: 0;
  border-radius: 999px 999px 0 0;
}
.m-curious .eye:first-child { height: 28%; top: 32%; }
.m-confused .eye:first-child { height: 14%; top: 42%; }
.m-searching .eyes { animation: vsa-look 1.6s ease-in-out infinite; }

.ring {
  position: absolute; inset: -5px;
  border-radius: 50%;
  border: 2px solid var(--orb);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.m-listening .ring {
  opacity: calc(0.35 + var(--lvl) * 0.65);
  transform: scale(calc(1 + var(--lvl) * 0.5));
  transition: transform 0.08s linear, opacity 0.08s linear;
}
.m-listening .orb {
  box-shadow:
    0 0 0 calc(var(--lvl) * 10px) color-mix(in srgb, var(--orb) 30%, transparent),
    0 6px 14px -4px color-mix(in srgb, var(--orb) 75%, transparent),
    inset 0 -5px 10px rgba(0, 0, 0, 0.1),
    inset 0 4px 8px rgba(255, 255, 255, 0.35);
}

.zzz {
  position: absolute; left: 72%; top: -28%;
  display: none;
  color: var(--muted);
  font: 700 11px/1 ui-sans-serif, system-ui, sans-serif;
}
.m-sleeping .zzz { display: block; }
.zzz span { position: absolute; left: 0; top: 0; opacity: 0; animation: vsa-zzz 2.4s ease-in infinite; }
.zzz span:nth-child(2) { animation-delay: 0.8s; font-size: 13px; }
.zzz span:nth-child(3) { animation-delay: 1.6s; font-size: 15px; }

.badge {
  position: absolute; right: -1px; top: -1px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: #e5484d;
  border: 2px solid var(--bg);
  transform: scale(0);
  transition: transform 0.2s ease;
}
.has-badge .badge { transform: scale(1); }

.m-idle .orb, .m-happy .orb { animation: vsa-breathe 3.2s ease-in-out infinite; }
.m-thinking .anim, .m-searching .anim { animation: vsa-bob 1.4s ease-in-out infinite; }
.m-working .anim { animation: vsa-travel 0.55s ease-in-out infinite alternate; }
.m-celebrate .anim { animation: vsa-bounce 0.8s cubic-bezier(0.3, 0.7, 0.4, 1) infinite; }
.m-confused .anim { animation: vsa-shake 1.8s ease-in-out infinite; }
.m-curious .anim { animation: vsa-tilt 2.6s ease-in-out infinite; }
.m-sleeping .anim { animation: vsa-drift 4s ease-in-out infinite; }
.m-waking .orb { animation: vsa-wake 0.8s ease-out; }
.m-suggest .anim { animation: vsa-nudge 1.6s ease-in-out infinite; }
.m-listening .anim { animation: vsa-listen 1.4s ease-in-out infinite; }
.m-happy .anim { animation: vsa-hop 1.4s ease-in-out 2; }
.orb.stretch { animation: vsa-wake 0.7s ease-out; }

@keyframes vsa-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.035); } }
@keyframes vsa-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
@keyframes vsa-travel { from { transform: translateX(-2px) rotate(-5deg); } to { transform: translateX(2px) rotate(5deg); } }
@keyframes vsa-bounce {
  0%, 100% { transform: translateY(0) scale(1.06, 0.94); }
  40% { transform: translateY(-16px) scale(0.96, 1.05); }
  70% { transform: translateY(0) scale(1.08, 0.92); }
  85% { transform: translateY(-3px) scale(1); }
}
@keyframes vsa-shake {
  0%, 60%, 100% { transform: translateX(0); }
  10%, 30%, 50% { transform: translateX(-4px) rotate(-3deg); }
  20%, 40% { transform: translateX(4px) rotate(3deg); }
}
@keyframes vsa-tilt { 0%, 100% { transform: rotate(-12deg); } 50% { transform: rotate(-6deg) translateY(-2px); } }
@keyframes vsa-drift { 0%, 100% { transform: translateY(0) rotate(-4deg); } 50% { transform: translateY(4px) rotate(2deg); } }
@keyframes vsa-wake { 0% { transform: scale(0.88, 1.08); } 45% { transform: scale(1.12, 0.92); } 100% { transform: scale(1); } }
@keyframes vsa-nudge { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(3px) rotate(4deg); } }
@keyframes vsa-listen { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }
@keyframes vsa-hop { 0%, 100% { transform: translateY(0); } 30% { transform: translateY(-7px); } 55% { transform: translateY(0); } }
@keyframes vsa-look {
  0%, 100% { transform: translateX(calc(var(--size) * -0.07)); }
  50% { transform: translateX(calc(var(--size) * 0.07)); }
}
@keyframes vsa-zzz {
  0% { transform: translate(0, 0); opacity: 0; }
  20% { opacity: 0.9; }
  100% { transform: translate(14px, -22px); opacity: 0; }
}
@keyframes vsa-blink-dot { 50% { opacity: 0.25; } }

/* ---------- thinking line ---------- */
.think {
  position: absolute; top: 50%; left: calc(100% + 10px);
  transform: translateY(-50%);
  max-width: min(320px, 60vw);
  padding: 5px 11px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.14);
  font-size: 12.5px; line-height: 1.3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0; visibility: hidden;
  transition: opacity 0.35s ease, visibility 0s linear 0.35s;
}
.think.left { left: auto; right: calc(100% + 10px); }
.panel-open .think { display: none; }
.think.show { opacity: 1; visibility: visible; transition: opacity 0.2s ease; }

/* ---------- spotlight ---------- */
.spot {
  position: fixed; left: 0; top: 0;
  border-radius: 10px;
  pointer-events: none;
  opacity: 0;
  z-index: 40;
  transition: opacity 0.2s ease;
  box-shadow: 0 0 0 2px var(--hl), 0 0 0 6px color-mix(in srgb, var(--hl) 28%, transparent);
}
.spot.on { opacity: 1; }
.spot.intro { animation: vsa-spot 2.4s ease-out forwards; }
@keyframes vsa-spot {
  0% { box-shadow: 0 0 0 2px var(--hl), 0 0 0 16px color-mix(in srgb, var(--hl) 0%, transparent), 0 0 0 100vmax rgba(10, 14, 22, 0.14); }
  20% { box-shadow: 0 0 0 2px var(--hl), 0 0 0 6px color-mix(in srgb, var(--hl) 38%, transparent), 0 0 0 100vmax rgba(10, 14, 22, 0.12); }
  100% { box-shadow: 0 0 0 2px var(--hl), 0 0 0 6px color-mix(in srgb, var(--hl) 28%, transparent), 0 0 0 100vmax rgba(10, 14, 22, 0); }
}
.note {
  position: fixed; left: 0; top: 0;
  max-width: min(300px, calc(100vw - 16px));
  display: flex; align-items: flex-start; gap: 4px;
  padding: 7px 5px 7px 12px;
  background: var(--bg); color: var(--fg);
  border: 1px solid color-mix(in srgb, var(--hl) 60%, var(--border));
  border-radius: 12px;
  box-shadow: var(--shadow);
  font-size: 12.5px;
  pointer-events: auto;
  opacity: 0; visibility: hidden;
  z-index: 80;
  transition: opacity 0.2s ease, visibility 0s linear 0.2s;
}
.note.on { opacity: 1; visibility: visible; transition: opacity 0.2s ease; }
.note:not(.has-text) { display: none; }
.note.measuring { visibility: hidden; }
.note-text { flex: 1; min-width: 0; padding-top: 3px; overflow-wrap: anywhere; }
.icon-btn.note-close { width: 24px; height: 24px; }
.icon-btn.note-close svg { width: 15px; height: 15px; }

/* ---------- panel ---------- */
.panel {
  position: fixed; left: 0; top: 0;
  width: min(360px, calc(100vw - 24px));
  max-height: 70vh;
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow);
  pointer-events: auto;
  overflow: hidden;
  opacity: 0;
  z-index: 50;
  transform: translateY(6px) scale(0.98);
  transition: opacity 0.16s ease, transform 0.16s ease, left 0.22s ease, top 0.22s ease;
}
.panel.dragging {
  transition: none !important;
  user-select: none;
  -webkit-user-select: none;
}
.panel.from-left { transform-origin: 100% 50%; }
.panel:not(.from-left) { transform-origin: 0 50%; }
.panel.open { opacity: 1; transform: none; }

.icon-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-grid; place-items: center;
  flex: none;
  width: 30px; height: 30px;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
}
.icon-btn:hover { background: var(--surface); color: var(--fg); }
.icon-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.icon-btn svg { width: 18px; height: 18px; display: block; }

.hdr {
  display: flex; align-items: center; gap: 6px; padding: 9px 8px 9px 14px;
  border-bottom: 1px solid var(--border); flex: none;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}
.panel.dragging .hdr { cursor: grabbing; }
.hdr .icon-btn, .hdr button { cursor: pointer; }
.dot {
  width: 10px; height: 10px; flex: none;
  border-radius: 50%;
  background: var(--mode-color, var(--accent));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--mode-color, var(--accent)) 25%, transparent);
  transition: background-color 0.3s ease;
  margin-right: 4px;
}
.hdr-text { flex: 1; min-width: 0; }
.title { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.hdr-audio-btn { transition: color 0.15s ease; }
.hdr-audio-btn svg { width: 17px; height: 17px; }
.hdr-proactivity-btn { transition: color 0.15s ease, opacity 0.15s ease; }
.hdr-proactivity-btn svg { width: 17px; height: 17px; }
.hdr-proactivity-btn.proactive-mode { color: var(--accent); }
.hdr-proactivity-btn.quiet-mode { opacity: 0.55; }
.hdr .icon-btn.active, .hdr .icon-btn[aria-expanded="true"] { background: var(--surface); color: var(--fg); }

.menu {
  position: absolute; right: 10px; top: 46px; z-index: 2;
  min-width: 220px; max-height: calc(100% - 60px);
  padding: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex; flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
}
.menu-label {
  padding: 6px 10px 2px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  user-select: none;
}
.menu-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
  flex: none;
}
.menu-item {
  all: unset;
  box-sizing: border-box;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--fg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.menu-item:hover, .menu-item:focus-visible { background: var(--surface); outline: none; }
.menu-item:focus-visible { box-shadow: inset 0 0 0 2px var(--focus); }
.menu-item.active {
  color: var(--accent);
  font-weight: 500;
}
.menu-item-content {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.menu-item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.menu-item-sub {
  font-size: 10.5px;
  color: var(--muted);
  font-weight: 400;
}
.menu-item-icon {
  width: 16px;
  height: 16px;
  flex: none;
  display: inline-grid;
  place-items: center;
  color: var(--muted);
}
.menu-item.active .menu-item-icon {
  color: var(--accent);
}
.menu-item-icon svg {
  width: 15px;
  height: 15px;
  display: block;
}
.menu-item-check {
  width: 14px;
  height: 14px;
  flex: none;
  display: inline-grid;
  place-items: center;
  opacity: 0;
  color: var(--accent);
}
.menu-item-check svg {
  width: 14px;
  height: 14px;
  display: block;
}
.menu-item.active .menu-item-check {
  opacity: 1;
}

.banner {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 8px 12px;
  background: color-mix(in srgb, #f5a524 16%, var(--bg));
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }

/* ---------- plan checklist ---------- */
.plan {
  flex: none;
  padding: 8px 10px 8px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent) 4%, var(--bg));
}
.plan-hdr { display: flex; align-items: center; gap: 8px; }
.plan-toggle {
  all: unset;
  box-sizing: border-box;
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 6px;
  padding: 2px 4px 2px 0;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px; line-height: 1.3;
  color: var(--fg);
}
.plan-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.plan-chev { flex: none; display: inline-grid; place-items: center; width: 16px; height: 16px; color: var(--muted); transition: transform 0.15s ease; }
.plan-chev svg { width: 16px; height: 16px; display: block; }
.plan.collapsed .plan-chev { transform: rotate(-90deg); }
.plan-label { flex: none; font-weight: 650; }
.plan-title { flex: 1; min-width: 0; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plan-count { flex: none; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.plan.complete .plan-count { color: var(--accent); font-weight: 600; }
.plan-now { margin: 2px 0 0 22px; font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.plan-bar { height: 3px; margin: 6px 0 4px; border-radius: 2px; background: color-mix(in srgb, var(--fg) 10%, transparent); overflow: hidden; }
.plan-bar-fill { height: 100%; width: 0; background: var(--accent); border-radius: 2px; transition: width 0.3s ease; }
.plan-list {
  position: relative;
  list-style: none; margin: 0; padding: 0;
  max-height: min(240px, 28vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 1px;
}
.plan-item {
  flex: none;
  display: flex; align-items: flex-start; gap: 7px;
  padding: 3px 6px 3px calc(4px + var(--depth, 0) * 16px);
  border-radius: 7px;
  font-size: 12.5px; line-height: 1.35;
}
.plan-ico { flex: none; width: 16px; height: 16px; margin-top: 1px; color: var(--muted); }
.plan-ico svg { width: 16px; height: 16px; display: block; }
.plan-body { flex: 1; min-width: 0; }
.plan-line { overflow-wrap: anywhere; }
.plan-kind {
  display: inline-block;
  margin-left: 6px; padding: 0 6px;
  border: 1px solid var(--border); border-radius: 999px;
  font-size: 10.5px; line-height: 15px; color: var(--muted);
  vertical-align: 1px; white-space: nowrap;
}
.plan-item-detail { margin-top: 1px; font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
.plan-item-note { margin-top: 1px; font-size: 11.5px; color: var(--muted); font-style: italic; overflow-wrap: anywhere; }
.plan-item.s-done .plan-ico { color: var(--accent); }
.plan-item.s-done .plan-item-title { color: var(--muted); }
.plan-item.s-doing { background: color-mix(in srgb, var(--hl) 15%, transparent); box-shadow: inset 2px 0 0 var(--hl); }
/* Mixed toward the text colour so the icon keeps its contrast on the tinted row in light and dark themes. */
.plan-item.s-doing .plan-ico { color: color-mix(in srgb, var(--hl) 72%, var(--fg)); animation: vsa-plan-pulse 1.6s ease-in-out infinite; }
.plan-item.s-doing .plan-item-title { font-weight: 600; }
.plan-item.s-blocked { background: color-mix(in srgb, var(--danger) 9%, transparent); box-shadow: inset 2px 0 0 var(--danger); }
.plan-item.s-blocked .plan-ico, .plan-item.s-blocked .plan-item-note { color: var(--danger); }
.plan-item.s-blocked .plan-item-note { font-style: normal; }
.plan-item.s-skipped .plan-item-title { color: var(--muted); text-decoration: line-through; }
.plan-item.s-skipped .plan-kind { opacity: 0.6; }
.plan-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
@keyframes vsa-plan-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }

.chat {
  flex: 1 1 auto;
  min-height: 110px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 12px 6px;
  display: flex; flex-direction: column; gap: 8px;
}
.chat:focus-visible { outline-offset: -2px; }
.chat-empty { flex: none; color: var(--muted); text-align: center; padding: 18px 8px; font-size: 12.5px; }
.msg { flex: none; max-width: 88%; }
.msg.user { align-self: flex-end; }
.msg.assistant { align-self: flex-start; }
.msg-body { padding: 7px 11px; overflow-wrap: anywhere; }
.msg.user .msg-body { background: var(--user-bg); color: var(--user-fg); border-radius: 14px 14px 4px 14px; white-space: pre-wrap; }
.msg.assistant .msg-body { background: var(--surface); border-radius: 14px 14px 14px 4px; }
.msg.sys { align-self: center; max-width: 95%; color: var(--muted); font-size: 11.5px; text-align: center; white-space: pre-wrap; }
.md p { margin: 0 0 6px; }
.md p:last-child { margin-bottom: 0; }
.md ul, .md ol { margin: 4px 0 6px; padding-left: 18px; }
.md li { margin: 2px 0; }
.md code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: color-mix(in srgb, var(--fg) 9%, transparent); padding: 1px 4px; border-radius: 4px; }
.md pre { margin: 6px 0; padding: 8px 10px; background: color-mix(in srgb, var(--fg) 7%, transparent); border-radius: 8px; overflow-x: auto; }
.md pre code { background: none; padding: 0; white-space: pre; }
.md a { color: var(--link); text-decoration: underline; }
.md strong { font-weight: 650; }
.chat-chip {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 5px 6px 3px 0;
  padding: 5px 12px;
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: 999px;
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  user-select: none;
}
.chat-chip:hover {
  background: color-mix(in srgb, var(--accent) 24%, var(--surface));
  border-color: var(--accent);
  color: var(--accent);
  transform: translateY(-1px);
}
.chat-chip:active {
  transform: translateY(0);
}
.chat-chip:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}


.cards { display: flex; flex-direction: column; gap: 8px; flex: none; max-height: 34vh; overflow-y: auto; }
.cards:not(:empty) { padding: 8px 12px; border-top: 1px solid var(--border); }
.card { flex: none; border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px; background: var(--bg); }
.card.confirm { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: color-mix(in srgb, var(--accent) 5%, var(--bg)); }
.card.confirm.danger { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); background: color-mix(in srgb, var(--danger) 6%, var(--bg)); }
.card.suggestion { border-color: color-mix(in srgb, var(--hl) 50%, var(--border)); }
.card-title { font-weight: 600; margin-bottom: 4px; overflow-wrap: anywhere; }
.card-detail { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; max-height: 140px; overflow-y: auto; }
.card-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.btn {
  all: unset;
  box-sizing: border-box;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg); color: var(--fg);
  font-weight: 600; font-size: 12.5px; line-height: 1.3;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: var(--surface); }
.btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
.btn.danger { background: var(--danger); color: var(--danger-fg); border-color: transparent; }
.btn.primary:hover, .btn.danger:hover { filter: brightness(1.08); }
.btn.ghost { background: transparent; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: default; pointer-events: none; }

.transcript {
  flex: none;
  padding: 6px 14px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-style: italic; font-size: 12.5px;
  overflow-wrap: anywhere;
}
.voice {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; flex: none;
  padding: 7px 14px;
  border-top: 1px solid var(--border);
  font-size: 12px; color: var(--muted);
}
.voice-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--muted); }
.voice[data-state="listening"] .voice-dot { background: #e5484d; animation: vsa-blink-dot 1s steps(2) infinite; }
.voice[data-state="loading-model"] .voice-dot, .voice[data-state="transcribing"] .voice-dot { background: var(--accent); }
.voice[data-state="error"] { color: var(--danger); }
.voice[data-state="error"] .voice-dot { background: var(--danger); }
.voice-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.bar { flex-basis: 100%; height: 4px; border-radius: 2px; background: var(--surface); overflow: hidden; }
.bar-fill { height: 100%; width: 0; background: var(--accent); transition: width 0.3s ease; }
.meter { display: flex; align-items: center; gap: 2px; height: 14px; }
.meter span { width: 3px; border-radius: 2px; background: #e5484d; height: calc(3px + var(--lvl, 0) * 11px); transition: height 0.08s linear; }
.meter span:nth-child(1), .meter span:nth-child(5) { height: calc(3px + var(--lvl, 0) * 5px); }
.meter span:nth-child(2), .meter span:nth-child(4) { height: calc(3px + var(--lvl, 0) * 8px); }

.composer { display: flex; align-items: flex-end; gap: 6px; flex: none; padding: 8px 8px 8px 12px; border-top: 1px solid var(--border); }
.input {
  all: unset;
  box-sizing: border-box;
  flex: 1; min-width: 0;
  min-height: 34px; max-height: 132px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface); color: var(--fg);
  font: inherit; line-height: 1.4;
  white-space: pre-wrap; overflow-wrap: anywhere;
  overflow-y: auto;
  resize: none;
  cursor: text;
}
.input::placeholder { color: var(--muted); opacity: 1; }
.input:focus-visible { outline: 2px solid var(--focus); outline-offset: 0; }
.icon-btn.mic, .icon-btn.send { width: 34px; height: 34px; border-radius: 10px; }
.icon-btn.mic { border: 1px solid var(--border); transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, color 0.15s ease; }
.icon-btn.mic.held {
  background: #e5484d !important;
  color: #ffffff !important;
  border-color: transparent !important;
  box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.25);
  animation: vsa-mic-pulse 1.8s infinite;
}
@keyframes vsa-mic-pulse {
  0% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0.45); }
  70% { box-shadow: 0 0 0 7px rgba(229, 72, 77, 0); }
  100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, 0); }
}
.icon-btn.send { background: var(--accent); color: var(--accent-fg); }
.busy .icon-btn.send { background: var(--danger); color: var(--danger-fg); }
.icon-btn.send:hover { filter: brightness(1.08); }

@media (prefers-reduced-motion: reduce) {
  .anim, .orb, .eyes, .zzz span, .spot, .voice-dot, .orb.stretch, .plan-ico { animation: none !important; }
  .m-listening .ring { transform: none; }
  .panel { transform: none; transition: opacity 0.12s linear; }
  .eyes, .eye, .think, .note, .badge, .bar-fill, .meter span, .plan-chev, .plan-bar-fill { transition-duration: 0.01s !important; }
}
`
