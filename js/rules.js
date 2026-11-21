// Crystal Chaos: arena layout and game rules.
// The host's device runs stepGame() about 20 times a second using everyone's
// latest positions, and shares the resulting crystal state with the room.

export const W = 1600;            // arena size in game units (landscape rink)
export const H = 900;
export const PR = 46;             // player radius
export const CR = 30;             // crystal radius
export const SPEED = 560;         // units per second at full stick
export const HANDOFF_LOCK_MS = 600; // a crystal can't change hands again this soon
export const BONUS_PER_HELD = 5;

export const TEAMS = {
  A: { name: "Gold", color: "#ffcc33", deep: "#e89b00", soft: "255,204,51" },
  B: { name: "Violet", color: "#9b7cff", deep: "#6a4be0", soft: "155,124,255" },
};
export const other = (t) => (t === "A" ? "B" : "A");

// Each team's glass tray (where crystals are delivered). These line up with
// the trays in the arena picture (docs/arena.jpg).
export const BASES = {
  A: { x: 25, y: 265, w: 300, h: 355 },
  B: { x: W - 25 - 300, y: 265, w: 300, h: 355 },
};
export const SLOTS = {
  A: [{ x: 175, y: 385 }, { x: 175, y: 520 }],
  B: [{ x: W - 175, y: 385 }, { x: W - 175, y: 520 }],
};
export const SPAWNS = {
  A: [{ x: 450, y: 230 }, { x: 450, y: 670 }],
  B: [{ x: W - 450, y: 230 }, { x: W - 450, y: 670 }],
};

/** Small seeded random generator so everyone gets the same layout. */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function newGame(seed, participants) {
  const r = rng(seed);
  const jy = (r() - 0.5) * 120; // same layout for everyone, fair to both teams
  const stats = {};
  for (const id of Object.keys(participants || {})) stats[id] = { d: 0, s: 0, p: 0 };
  return {
    v: 0,
    crystals: {
      c0: { s: "free", x: W / 2 - 58, y: Math.round(H / 2 + jy), team: null, by: null, slot: null, lock: 0 },
      c1: { s: "free", x: W / 2 + 58, y: Math.round(H / 2 - jy), team: null, by: null, slot: null, lock: 0 },
    },
    deliveries: { A: 0, B: 0 },
    stats,
  };
}

// The rink has rounded corners: keep a player inside the walls.
const WALL = { l: PR * 0.9, r: PR * 0.9, t: PR * 0.5, b: PR * 1.1, corner: 215 };
export function clampPos(x, y) {
  const x0 = WALL.l, x1 = W - WALL.r, y0 = WALL.t, y1 = H - WALL.b, r = WALL.corner;
  x = Math.max(x0, Math.min(x1, x));
  y = Math.max(y0, Math.min(y1, y));
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : null;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : null;
  if (cx !== null && cy !== null) {
    const d = Math.hypot(x - cx, y - cy);
    if (d > r) { x = cx + ((x - cx) / d) * r; y = cy + ((y - cy) / d) * r; }
  }
  return { x, y };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function touchesRect(p, r, pad = 0) {
  const cx = Math.max(r.x, Math.min(p.x, r.x + r.w));
  const cy = Math.max(r.y, Math.min(p.y, r.y + r.h));
  return Math.hypot(p.x - cx, p.y - cy) < PR * 0.6 + pad;
}

/** Where a crystal is right now (held crystals follow their carrier). */
export function crystalPos(c, positions) {
  if (c.s === "stored") return SLOTS[c.team][c.slot] || SLOTS[c.team][0];
  if (c.s === "held" && positions[c.by]) return positions[c.by];
  return { x: c.x, y: c.y };
}

/** Live score: deliveries + bonus for crystals sitting in the container. */
export function scores(game) {
  const out = {};
  for (const t of ["A", "B"]) {
    const held = Object.values(game?.crystals || {}).filter((c) => c.s === "stored" && c.team === t).length;
    const d = game?.deliveries?.[t] || 0;
    out[t] = { d, held, total: d + held * BONUS_PER_HELD };
  }
  return out;
}

/**
 * Advance the game by one host tick.
 * players: { uid: { x, y, team, online } } using everyone's latest positions.
 * touching: Set of "uidA|uidB" pairs that were already in contact last tick
 *           (passes and steals happen when contact *starts*).
 * Returns { changed, events }.
 */
export function stepGame(game, players, touching, now) {
  const events = [];
  let changed = false;
  const crystals = game.crystals;
  const ids = Object.keys(players).sort();
  const carrying = {}; // uid -> crystal key
  for (const [k, c] of Object.entries(crystals)) if (c.s === "held") carrying[c.by] = k;
  const stat = (id, f) => {
    game.stats[id] = game.stats[id] || { d: 0, s: 0, p: 0 };
    game.stats[id][f]++;
  };
  const give = (k, id, kind) => {
    const c = crystals[k];
    if (c.s === "held") delete carrying[c.by];
    c.s = "held"; c.by = id; c.slot = null; c.lock = now + HANDOFF_LOCK_MS;
    carrying[id] = k;
    changed = true;
    events.push({ kind, k, by: id });
  };

  // 1. Carriers whose player left drop their crystal where they were.
  for (const [k, c] of Object.entries(crystals)) {
    if (c.s !== "held") continue;
    const p = players[c.by];
    if (!p || !p.online) {
      const last = p || { x: c.x, y: c.y };
      Object.assign(c, { s: "free", by: null, x: Math.round(last.x), y: Math.round(last.y), lock: now + 300 });
      delete carrying[c.by];
      changed = true;
    }
  }

  const active = ids.filter((id) => players[id].online);

  for (const id of active) {
    const p = players[id];

    // 2. Deliver: carry a crystal into your own container.
    const ck = carrying[id];
    if (ck && touchesRect(p, BASES[p.team])) {
      const used = new Set(Object.values(crystals).filter((c) => c.s === "stored" && c.team === p.team).map((c) => c.slot));
      const slot = [0, 1].find((i) => !used.has(i)) ?? 0;
      Object.assign(crystals[ck], { s: "stored", team: p.team, by: null, slot, lock: now + 300 });
      delete carrying[id];
      game.deliveries[p.team] = (game.deliveries[p.team] || 0) + 1;
      stat(id, "d");
      changed = true;
      events.push({ kind: "deliver", k: ck, by: id });
      continue;
    }
    if (carrying[id]) continue;

    // 3. Collect a loose crystal, or raid one from the other team's container.
    for (const [k, c] of Object.entries(crystals)) {
      if (c.lock > now) continue;
      if (c.s === "free" && dist(p, c) < PR + CR) { give(k, id, "pickup"); break; }
      if (c.s === "stored" && c.team !== p.team && dist(p, crystalPos(c, {})) < PR + CR + 8) {
        give(k, id, "raid"); stat(id, "s"); break;
      }
    }
  }

  // 4. Steal / pass: when two players start touching and one is empty-handed.
  const nowTouching = new Set();
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (dist(players[a], players[b]) >= PR * 2) continue;
      const key = a + "|" + b;
      nowTouching.add(key);
      if (touching.has(key)) continue;
      for (const [from, to] of [[a, b], [b, a]]) {
        const k = carrying[from];
        if (!k || carrying[to] || crystals[k].lock > now) continue;
        const sameTeam = players[from].team === players[to].team;
        give(k, to, sameTeam ? "pass" : "steal");
        if (sameTeam) stat(from, "p"); // the passer gets the credit
        else stat(to, "s");
        break;
      }
    }
  }
  touching.clear();
  nowTouching.forEach((k) => touching.add(k));

  if (changed) game.v = (game.v || 0) + 1;
  return { changed, events };
}

export function finalResult(game) {
  const s = scores(game);
  const winner = s.A.total > s.B.total ? "A" : s.B.total > s.A.total ? "B" : "draw";
  return { A: s.A, B: s.B, winner };
}
