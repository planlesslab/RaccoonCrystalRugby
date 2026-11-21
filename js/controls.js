// Movement input: a floating virtual joystick (touch or mouse drag anywhere
// on the game screen) plus WASD / arrow keys. Both always work; the player's
// choice only changes the hints and the icon shown to others.

const RADIUS = 56; // px the thumb can travel from where it first touched

// On an upright phone the game screen is shown turned sideways (see "Sideways
// on upright phones" in css/style.css), so touches are turned the same way.
const sideways = matchMedia("(orientation: portrait) and (pointer: coarse)");
const local = (e) => (sideways.matches
  ? { x: e.clientY, y: window.innerWidth - e.clientX }
  : { x: e.clientX, y: e.clientY });

export class Controls {
  constructor(surface, base, knob) {
    this.surface = surface;
    this.base = base;
    this.knob = knob;
    this.pointer = null; // { id, ox, oy, dx, dy }
    this.keys = new Set();
    this.moved = false;

    surface.addEventListener("pointerdown", (e) => {
      if (this.pointer || e.target.closest("button")) return;
      e.preventDefault();
      surface.setPointerCapture?.(e.pointerId);
      const at = local(e);
      this.pointer = { id: e.pointerId, ox: at.x, oy: at.y, dx: 0, dy: 0 };
      this.showStick(true);
    });
    surface.addEventListener("pointermove", (e) => {
      if (!this.pointer || e.pointerId !== this.pointer.id) return;
      const at = local(e);
      let dx = at.x - this.pointer.ox, dy = at.y - this.pointer.oy;
      const d = Math.hypot(dx, dy);
      if (d > RADIUS) {
        // Let the stick's centre follow the thumb, so you never "run out" of stick.
        const over = d - RADIUS;
        this.pointer.ox += (dx / d) * over;
        this.pointer.oy += (dy / d) * over;
        dx = at.x - this.pointer.ox; dy = at.y - this.pointer.oy;
      }
      this.pointer.dx = dx; this.pointer.dy = dy;
      if (d > 8) this.moved = true;
      this.showStick(true);
    });
    const end = (e) => {
      if (!this.pointer || e.pointerId !== this.pointer.id) return;
      this.pointer = null;
      this.showStick(false);
    };
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);

    const map = { ArrowUp: "u", KeyW: "u", ArrowDown: "d", KeyS: "d", ArrowLeft: "l", KeyA: "l", ArrowRight: "r", KeyD: "r" };
    window.addEventListener("keydown", (e) => {
      if (e.target.closest?.("input, textarea")) return;
      const k = map[e.code];
      if (!k || document.body.dataset.view !== "game") return;
      e.preventDefault();
      this.keys.add(k);
      this.moved = true;
    });
    window.addEventListener("keyup", (e) => { const k = map[e.code]; if (k) this.keys.delete(k); });
    window.addEventListener("blur", () => { this.keys.clear(); this.pointer = null; this.showStick(false); });
  }

  showStick(on) {
    this.base.hidden = !on;
    if (!on || !this.pointer) return;
    const { ox, oy, dx, dy } = this.pointer;
    this.base.style.transform = `translate(${ox}px, ${oy}px)`;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** Current direction, length 0..1. */
  vector() {
    let x = 0, y = 0;
    if (this.keys.size) {
      x = (this.keys.has("r") ? 1 : 0) - (this.keys.has("l") ? 1 : 0);
      y = (this.keys.has("d") ? 1 : 0) - (this.keys.has("u") ? 1 : 0);
      const d = Math.hypot(x, y);
      return d ? { x: x / d, y: y / d } : { x: 0, y: 0 };
    }
    if (this.pointer) {
      const d = Math.hypot(this.pointer.dx, this.pointer.dy);
      if (d < 6) return { x: 0, y: 0 };
      const m = Math.min(1, d / (RADIUS * 0.8)); // reach full speed a little before the edge
      return { x: (this.pointer.dx / d) * m, y: (this.pointer.dy / d) * m };
    }
    return { x: 0, y: 0 };
  }

  reset() { this.keys.clear(); this.pointer = null; this.showStick(false); }
}
