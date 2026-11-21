// Draws the Crystal Chaos arena on a <canvas>. The background is the arena
// picture (docs/arena.jpg): a glass rink seen from slightly above, with the
// Gold tray on the left and the Violet tray on the right. Game positions are
// mapped onto the picture's floor, so things further "up" the rink look a
// little smaller, like in the picture.
import { W, H, PR, CR, TEAMS, BASES, SLOTS } from "./rules.js";

const TAU = Math.PI * 2;

// The picture, and how the game floor (W × H units) sits on it.
const IMG_W = 1968, IMG_H = 1000;       // picture coordinates used below
const FLOOR = { x0: 187, y0: 196, sx: 0.99875, shear: -0.13469, sy: 0.631994, persp: -0.000137 };
const ARENA_IMG = new Image();
ARENA_IMG.src = new URL("../docs/arena.jpg", import.meta.url).href;

/** Game position → picture position, plus k = how big things look there. */
export function project(x, y) {
  const w = 1 + FLOOR.persp * y;
  return {
    x: (FLOOR.sx * x + FLOOR.shear * y + FLOOR.x0) / w,
    y: (FLOOR.sy * y + FLOOR.y0) / w,
    k: FLOOR.sx / w,
  };
}

// The crystal thief artwork: one cut-out per team, same raccoon, cap in the team colour.
// If a picture hasn't loaded (or is missing), a simple drawn raccoon is used instead.
const SPRITES = {};
for (const t of ["A", "B"]) {
  const img = new Image();
  img.src = new URL(`../docs/thief-${t}.png`, import.meta.url).href;
  SPRITES[t] = img;
}
const SPRITE_W = PR * 3.5; // drawn width in arena units (the picture faces right)

export class Arena {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.pxW = 0;
    this.cssScale = 0.3;      // CSS pixels per picture pixel (keeps labels readable on phones)
    this.popups = [];         // floating "+1", "STOLEN!" texts
    this.sparks = [];
    this.track = new Map();   // uid -> { x, y, dir, speed } for facing + run bob
    this.resize();
  }

  resize() {
    const cssW = Math.max(160, this.canvas.clientWidth); // layout width (unaffected by the sideways turn on phones)
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const px = Math.min(2400, Math.floor(cssW * dpr));
    this.cssScale = cssW / IMG_W;
    if (px === this.pxW) return;
    this.pxW = px;
    this.canvas.width = px;
    this.canvas.height = Math.round(px * IMG_H / IMG_W);
    this.scale = px / IMG_W;
  }

  pop(x, y, text, color = "#fff") {
    this.popups.push({ x, y, text, color, t0: performance.now() });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * TAU, v = 140 + Math.random() * 260;
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: performance.now(), color });
    }
  }

  /** Run fn with the canvas origin at game position (x, y), scaled for depth. */
  at(x, y, fn) {
    const g = this.ctx, p = project(x, y);
    g.save();
    g.translate(p.x, p.y);
    g.scale(p.k, p.k);
    fn(g);
    g.restore();
  }

  drawFloor(g) {
    if (ARENA_IMG.complete && ARENA_IMG.naturalWidth) {
      g.drawImage(ARENA_IMG, 0, 0, IMG_W, IMG_H);
      return;
    }
    // Picture not loaded yet: a plain rink so the game is still playable.
    g.fillStyle = "#c9c5da";
    g.fillRect(0, 0, IMG_W, IMG_H);
    const quad = (x, y, w, h) => {
      g.beginPath();
      [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].forEach(([a, b], i) => {
        const q = project(a, b);
        i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y);
      });
      g.closePath();
    };
    quad(0, 0, W, H); g.fillStyle = "#e6e2f2"; g.fill(); g.strokeStyle = "#fff"; g.lineWidth = 6; g.stroke();
    for (const t of ["A", "B"]) {
      const b = BASES[t];
      quad(b.x, b.y, b.w, b.h);
      g.fillStyle = `rgba(${TEAMS[t].soft},0.6)`; g.fill();
      g.strokeStyle = TEAMS[t].color; g.stroke();
    }
  }

  /**
   * players:  [{ id, x, y, team, name, me, online }]
   * crystals: [{ x, y, team, s, carrier }]
   */
  draw(players, crystals, opts = {}) {
    this.resize();
    const g = this.ctx;
    const t = performance.now() / 1000;
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    g.clearRect(0, 0, IMG_W, IMG_H);
    this.drawFloor(g);

    // Trays glow while they hold crystals.
    for (const tm of ["A", "B"]) {
      const n = crystals.filter((c) => c.s === "stored" && c.team === tm).length;
      if (!n) continue;
      const b = BASES[tm];
      this.at(b.x + b.w / 2, b.y + b.h / 2, () => {
        g.scale(1, 0.62);
        const rg = g.createRadialGradient(0, 0, 20, 0, 0, 300);
        rg.addColorStop(0, `rgba(${TEAMS[tm].soft},${0.4 + 0.15 * Math.sin(t * 4)})`);
        rg.addColorStop(1, `rgba(${TEAMS[tm].soft},0)`);
        g.fillStyle = rg;
        g.beginPath(); g.arc(0, 0, 300, 0, TAU); g.fill();
      });
    }

    // Track which way each raccoon faces and whether it's running.
    const tnow = performance.now();
    for (const p of players) {
      const tr = this.track.get(p.id) || { x: p.x, y: p.y, dir: p.team === "B" ? -1 : 1, speed: 0, at: tnow };
      const dt = Math.max(1, tnow - tr.at);
      const dx = p.x - tr.x, dy = p.y - tr.y;
      if (Math.abs(dx) > 0.4) tr.dir = dx > 0 ? 1 : -1;
      tr.speed = tr.speed * 0.8 + (Math.hypot(dx, dy) / dt) * 0.2 * 1000;
      Object.assign(tr, { x: p.x, y: p.y, at: tnow });
      this.track.set(p.id, tr);
      p.dir = tr.dir;
      p.running = tr.speed > 40;
    }

    // Everything standing on the floor, back to front.
    const things = [
      ...players.map((p) => ({ y: p.y, player: p })),
      ...crystals.filter((c) => c.s !== "held").map((c) => ({ y: c.y - 1, crystal: c })),
    ].sort((a, b) => a.y - b.y);
    for (const th of things) {
      if (th.crystal) {
        const c = th.crystal;
        const bob = c.s === "free" ? Math.sin(t * 2.4 + c.x) * 6 : 0;
        this.at(c.x, c.y, () => {
          g.fillStyle = "rgba(60,40,140,0.22)";
          g.beginPath(); g.ellipse(0, CR * 1.5, CR * 1.1, CR * 0.36, 0, 0, TAU); g.fill();
          drawCrystal(g, 0, -CR * 0.9 + bob, 1, c.team, t + c.x);
        });
      } else {
        const p = th.player, k = project(p.x, p.y).k * this.cssScale;
        this.at(p.x, p.y, () => drawRaccoon(g, { ...p, x: 0, y: 0, labelSize: Math.max(30, 11.5 / k) }, t));
      }
    }

    // Carried crystals float just above the raccoon's outstretched paw.
    for (const c of crystals) {
      if (c.s !== "held") continue;
      const dir = this.track.get(c.carrier)?.dir || 1;
      this.at(c.x, c.y, () => drawCrystal(g, dir * PR * 1.7, -PR * 0.85 + Math.sin(t * 6) * 3, 0.62, c.team, t));
    }

    // Sparks and pop-up texts.
    const now = performance.now();
    this.sparks = this.sparks.filter((s) => now - s.t0 < 600);
    for (const s of this.sparks) {
      const k = (now - s.t0) / 1000;
      this.at(s.x, s.y, () => {
        g.fillStyle = s.color;
        g.strokeStyle = "rgba(60,40,140,0.5)"; g.lineWidth = 1.5;
        g.globalAlpha = 1 - k / 0.6;
        g.beginPath(); g.arc(s.vx * k, s.vy * k - PR, 6, 0, TAU); g.fill(); g.stroke();
      });
    }
    this.popups = this.popups.filter((p) => now - p.t0 < 1100);
    for (const p of this.popups) {
      if (!p.text) continue;
      const k = (now - p.t0) / 1100;
      const size = Math.max(48, 17 / (project(p.x, p.y).k * this.cssScale));
      this.at(p.x, p.y, () => {
        g.globalAlpha = 1 - k * k;
        g.textAlign = "center";
        g.font = `800 ${size}px 'Bricolage Grotesque', Figtree, system-ui, sans-serif`;
        g.lineWidth = size * 0.2; g.lineJoin = "round"; g.strokeStyle = "rgba(40,25,110,0.85)";
        g.strokeText(p.text, 0, -PR * 2.4 - k * 70);
        g.fillStyle = p.color;
        g.fillText(p.text, 0, -PR * 2.4 - k * 70);
      });
    }

    if (opts.frozen) {
      g.fillStyle = "rgba(60,45,140,0.22)";
      g.fillRect(0, 0, IMG_W, IMG_H);
    }
  }
}

/** A faceted, glowing diamond like the one on the cover. team=null → clear/iridescent. */
export function drawCrystal(g, x, y, s, team, t) {
  s *= 1.3;
  const hw = CR * 0.95 * s, top = CR * 1.75 * s, bot = CR * 1.55 * s, mid = -CR * 0.15 * s;
  const tint = team ? TEAMS[team].soft : "200,190,255";
  g.save();
  g.translate(x, y);

  // Glow.
  g.globalCompositeOperation = "lighter";
  const glow = g.createRadialGradient(0, 0, 4, 0, 0, CR * 2.6 * s);
  glow.addColorStop(0, `rgba(${tint},${0.45 + 0.12 * Math.sin(t * 3)})`);
  glow.addColorStop(1, `rgba(${tint},0)`);
  g.fillStyle = glow;
  g.beginPath(); g.arc(0, 0, CR * 2.6 * s, 0, TAU); g.fill();
  g.globalCompositeOperation = "source-over";

  const T = [0, -top], B = [0, bot], L = [-hw, mid], R = [hw, mid];
  const C = [hw * 0.12, mid - top * 0.08];
  const UL = [-hw * 0.45, -top * 0.45], UR = [hw * 0.5, -top * 0.35];
  const DL = [-hw * 0.4, bot * 0.45], DR = [hw * 0.45, bot * 0.4];
  const pal = team
    ? [TEAMS[team].color, TEAMS[team].deep, "#ffffff", TEAMS[team].color, TEAMS[team].deep, "#fff4dc"]
    : ["#dcecff", "#8f7bff", "#ffffff", "#7cc8ff", "#d59cff", "#b9e6ff"];
  const faces = [
    [T, UL, C, 2], [T, C, UR, 0], [UL, L, C, 4], [UR, C, R, 3],
    [L, DL, C, 1], [C, DL, B, 5], [C, B, DR, 3], [C, DR, R, 0],
  ];
  for (const [a, b, c, ci] of faces) {
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineTo(...c); g.closePath();
    g.fillStyle = pal[ci];
    g.globalAlpha = team ? 0.92 : 0.78;
    g.fill();
  }
  g.globalAlpha = 1;
  g.lineJoin = "round";
  g.strokeStyle = team ? TEAMS[team].deep : "#6f5be6";
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(...T); g.lineTo(...R); g.lineTo(...B); g.lineTo(...L); g.closePath(); g.stroke();
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 2;
  g.stroke();
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255,255,255,0.6)";
  for (const [a, b] of [[T, C], [L, C], [R, C], [B, C], [UL, C], [DR, C]]) {
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
  }
  // Sparkle.
  const sp = 0.5 + 0.5 * Math.sin(t * 5);
  g.fillStyle = `rgba(255,255,255,${sp})`;
  g.beginPath(); g.arc(-hw * 0.3, -top * 0.55, 3 * s, 0, TAU); g.fill();
  g.restore();
}

/**
 * The crystal thief: a chibi raccoon in a dark jacket with a backwards
 * snapback cap in the team colour. Drawn facing right, mirrored when p.dir < 0.
 */
const ART_SCALE = 1.25; // raccoons are drawn a bit bigger than their touch radius

function drawRaccoon(g, p, t) {
  const team = TEAMS[p.team] || TEAMS.A;
  const R = PR * 0.92;                       // head radius
  const run = p.running ? 1 : 0;
  const bob = run ? Math.abs(Math.sin(t * 16)) * -5 : Math.sin(t * 2.5) * 1.2;
  const step = run ? Math.sin(t * 16) : 0;

  g.save();
  g.translate(p.x, p.y);
  g.globalAlpha = p.online === false ? 0.35 : 1;

  // Floor shadow + soft team glow.
  g.fillStyle = `rgba(${team.soft},0.55)`;
  g.beginPath(); g.ellipse(0, PR * 1.1, PR * 1.45, PR * 0.5, 0, 0, TAU); g.fill();
  g.fillStyle = "rgba(40,25,110,0.35)";
  g.beginPath(); g.ellipse(0, PR * 1.1, PR * 1.0, PR * 0.3, 0, 0, TAU); g.fill();

  // "You" ring on the floor.
  if (p.me) {
    g.strokeStyle = `rgba(60,40,150,${0.7 + 0.3 * Math.sin(t * 6)})`;
    g.lineWidth = 5;
    g.setLineDash([10, 8]);
    g.lineDashOffset = -t * 30;
    g.beginPath(); g.ellipse(0, PR * 1.1, PR * 1.65, PR * 0.6, 0, 0, TAU); g.stroke();
    g.setLineDash([]);
  }

  const sprite = SPRITES[p.team];
  if (sprite?.complete && sprite.naturalWidth) {
    const w = SPRITE_W, h = w * sprite.naturalHeight / sprite.naturalWidth;
    g.save();
    g.translate(0, bob);
    g.scale(p.dir < 0 ? -1 : 1, 1);
    g.rotate(run ? step * 0.07 : 0);
    g.drawImage(sprite, -w * 0.5, -h * 0.6, w, h);
    g.restore();
    drawLabel(g, p);
    g.restore();
    return;
  }

  g.save();
  g.translate(0, bob);
  g.scale((p.dir < 0 ? -1 : 1) * ART_SCALE, ART_SCALE);

  // Striped tail, wagging behind.
  const wag = Math.sin(t * (run ? 14 : 3)) * (run ? 0.35 : 0.15);
  const tail = [];
  for (let i = 0; i <= 10; i++) {
    const k = i / 10;
    const a = Math.PI * 0.95 + wag * k - k * 0.5;
    tail.push({ x: -PR * 0.35 + Math.cos(a) * PR * 1.2 * k, y: PR * 0.55 + Math.sin(a) * PR * 0.9 * k - k * k * PR * 0.6, r: PR * (0.3 - 0.1 * k) });
  }
  tail.forEach((s, i) => {
    g.fillStyle = Math.floor(i / 2) % 2 ? "#2a2533" : "#9a96a8";
    g.beginPath(); g.arc(s.x, s.y, s.r, 0, TAU); g.fill();
  });

  // Body: dark jacket, little legs and paws.
  g.fillStyle = "#1f1b3a";
  g.beginPath(); g.ellipse(-PR * 0.2 + step * 4, PR * 0.85, PR * 0.18, PR * 0.14, 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(PR * 0.25 - step * 4, PR * 0.85, PR * 0.18, PR * 0.14, 0, 0, TAU); g.fill();
  const jacket = g.createLinearGradient(0, PR * 0.2, 0, PR * 0.9);
  jacket.addColorStop(0, "#4a4380");
  jacket.addColorStop(1, "#272250");
  g.fillStyle = jacket;
  g.beginPath(); g.ellipse(0, PR * 0.55, PR * 0.55, PR * 0.4, 0, 0, TAU); g.fill();
  // Back arm + front arm reaching forward.
  g.strokeStyle = "#2f2a5c"; g.lineCap = "round"; g.lineWidth = PR * 0.24;
  g.beginPath(); g.moveTo(-PR * 0.3, PR * 0.5); g.lineTo(-PR * 0.55, PR * 0.7 - step * 5); g.stroke();
  g.beginPath(); g.moveTo(PR * 0.3, PR * 0.45); g.lineTo(PR * 0.85, PR * 0.15 + step * 3); g.stroke();
  g.fillStyle = "#26223f";
  g.beginPath(); g.arc(PR * 0.9, PR * 0.12 + step * 3, PR * 0.15, 0, TAU); g.fill();
  g.fillStyle = "#f1c6d8";
  for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(PR * 1.0 + i * 2, PR * 0.02 + step * 3 + i * 5, 2.6, 0, TAU); g.fill(); }

  g.translate(0, -PR * 0.12);

  // Ears poking out from under the cap.
  for (const s of [-1, 1]) {
    g.fillStyle = "#8a869a";
    g.beginPath();
    g.moveTo(s * R * 0.35, -R * 0.75);
    g.quadraticCurveTo(s * R * 0.95, -R * 1.55, s * R * 0.98, -R * 0.45);
    g.closePath(); g.fill();
    g.fillStyle = "#e9c9da";
    g.beginPath();
    g.moveTo(s * R * 0.5, -R * 0.72);
    g.quadraticCurveTo(s * R * 0.88, -R * 1.3, s * R * 0.88, -R * 0.55);
    g.closePath(); g.fill();
  }

  // Head.
  const fur = g.createRadialGradient(-R * 0.2, -R * 0.3, R * 0.1, 0, 0, R * 1.1);
  fur.addColorStop(0, "#cdc9d9");
  fur.addColorStop(1, "#8a869a");
  g.fillStyle = fur;
  g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
  // White cheeks / lower face.
  g.fillStyle = "#f6f3fb";
  g.beginPath(); g.ellipse(R * 0.08, R * 0.38, R * 0.82, R * 0.52, 0, 0, TAU); g.fill();
  g.beginPath(); g.ellipse(R * 0.12, -R * 0.32, R * 0.6, R * 0.2, 0, 0, TAU); g.fill();

  // Bandit mask.
  g.fillStyle = "#2a2533";
  for (const [ex, rot] of [[-R * 0.26, 0.35], [R * 0.5, -0.35]]) {
    g.beginPath(); g.ellipse(ex, R * 0.02, R * 0.34, R * 0.27, rot, 0, TAU); g.fill();
  }
  g.beginPath(); g.ellipse(R * 0.12, R * 0.0, R * 0.3, R * 0.13, 0, 0, TAU); g.fill();

  // Big sparkly purple eyes, looking where he runs.
  for (const ex of [-R * 0.24, R * 0.48]) {
    g.fillStyle = "#ffffff";
    g.beginPath(); g.arc(ex, R * 0.0, R * 0.22, 0, TAU); g.fill();
    const iris = g.createRadialGradient(ex + R * 0.04, R * 0.02, 1, ex + R * 0.04, R * 0.02, R * 0.17);
    iris.addColorStop(0, "#8f7bff");
    iris.addColorStop(1, "#3b1f9e");
    g.fillStyle = iris;
    g.beginPath(); g.arc(ex + R * 0.05, R * 0.02, R * 0.17, 0, TAU); g.fill();
    g.fillStyle = "#120c2e";
    g.beginPath(); g.arc(ex + R * 0.06, R * 0.03, R * 0.08, 0, TAU); g.fill();
    g.fillStyle = "#ffffff";
    g.beginPath(); g.arc(ex + R * 0.0, -R * 0.05, R * 0.055, 0, TAU); g.fill();
    g.beginPath(); g.arc(ex + R * 0.11, R * 0.09, R * 0.025, 0, TAU); g.fill();
  }

  // Snout, nose and a cheeky open grin.
  g.fillStyle = "#ffffff";
  g.beginPath(); g.ellipse(R * 0.2, R * 0.42, R * 0.3, R * 0.2, 0, 0, TAU); g.fill();
  g.fillStyle = "#141018";
  g.beginPath(); g.ellipse(R * 0.26, R * 0.3, R * 0.11, R * 0.075, 0, 0, TAU); g.fill();
  g.fillStyle = "#7a2f4f";
  g.beginPath(); g.moveTo(R * 0.06, R * 0.47); g.quadraticCurveTo(R * 0.22, R * 0.72, R * 0.4, R * 0.47); g.closePath(); g.fill();
  g.fillStyle = "#e46a92";
  g.beginPath(); g.ellipse(R * 0.23, R * 0.58, R * 0.08, R * 0.05, 0, 0, TAU); g.fill();

  // Backwards snapback cap in the team colour.
  const cap = g.createLinearGradient(0, -R * 1.05, 0, -R * 0.3);
  cap.addColorStop(0, team.color);
  cap.addColorStop(1, team.deep);
  // Brim sticking out the back.
  g.fillStyle = team.deep;
  g.beginPath(); g.ellipse(-R * 0.98, -R * 0.42, R * 0.48, R * 0.15, 0.28, 0, TAU); g.fill();
  g.fillStyle = "rgba(0,0,0,0.18)";
  g.beginPath(); g.ellipse(-R * 0.98, -R * 0.38, R * 0.44, R * 0.08, 0.28, 0, TAU); g.fill();
  // Crown.
  g.fillStyle = cap;
  g.beginPath();
  g.moveTo(-R * 0.98, -R * 0.3);
  g.bezierCurveTo(-R * 1.0, -R * 1.25, R * 0.95, -R * 1.3, R * 0.93, -R * 0.42);
  g.quadraticCurveTo(R * 0.0, -R * 0.62, -R * 0.98, -R * 0.3);
  g.closePath(); g.fill();
  // Panel seams + shine.
  g.strokeStyle = "rgba(0,0,0,0.18)"; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(-R * 0.05, -R * 1.02); g.quadraticCurveTo(-R * 0.2, -R * 0.75, -R * 0.15, -R * 0.52); g.stroke();
  g.beginPath(); g.moveTo(-R * 0.05, -R * 1.02); g.quadraticCurveTo(R * 0.35, -R * 0.75, R * 0.45, -R * 0.5); g.stroke();
  g.fillStyle = "rgba(255,255,255,0.35)";
  g.beginPath(); g.ellipse(-R * 0.35, -R * 0.85, R * 0.3, R * 0.09, -0.4, 0, TAU); g.fill();
  g.fillStyle = team.deep;
  g.beginPath(); g.arc(-R * 0.05, -R * 1.03, R * 0.07, 0, TAU); g.fill();
  // Snapback strap with a silver buckle over the forehead.
  g.fillStyle = "#1f1b3a";
  g.beginPath(); g.ellipse(R * 0.42, -R * 0.52, R * 0.3, R * 0.1, -0.12, 0, TAU); g.fill();
  g.strokeStyle = "#e6e6f0"; g.lineWidth = 2.5;
  g.strokeRect(R * 0.34, -R * 0.62, R * 0.17, R * 0.16);

  g.restore();

  drawLabel(g, p);
  g.restore();
}

/** Name under the player (never mirrored). Sized so it stays readable on small screens. */
function drawLabel(g, p) {
  const size = p.labelSize || 30;
  g.font = `800 ${size}px Figtree, system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "top";
  g.lineJoin = "round";
  const label = p.me ? "You" : (p.name || "").slice(0, 12);
  g.lineWidth = size * 0.24; g.strokeStyle = "rgba(40,25,110,0.9)";
  g.strokeText(label, 0, PR * 1.75);
  g.fillStyle = p.me ? "#fff" : TEAMS[p.team]?.color || "#fff";
  g.fillText(label, 0, PR * 1.75);
}
