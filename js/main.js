import { firebaseConfig } from "./firebase-config.js";
import { createLocalBackend } from "./backend-local.js";
import { Arena } from "./arena.js";
import { Controls } from "./controls.js";
import {
  TEAMS, SPAWNS, SLOTS, SPEED, other, newGame, stepGame, scores, finalResult,
  crystalPos, clampPos, H,
} from "./rules.js";

// ---------- Game settings ----------
const COUNTDOWN_MS = 3800;      // 3, 2, 1, go
const TIME_LIMIT_MS = 30_000;   // match length
const HOST_GRACE_MS = 60_000;   // how long the host can be away before someone else takes over
const MAX_PLAYERS = 4;
const POS_SEND_MS = 66;         // send your position ~15 times a second
const INTERP_DELAY_MS = 110;    // draw other players slightly in the past, for smooth motion
const HOST_TICK_MS = 50;        // host checks pickups / steals 20 times a second

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const VIEWS = ["home", "lobby", "game", "results"];
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
const INPUT_ICON = { stick: "🕹️", keys: "⌨️" };

const randomCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join("");
const cleanCode = (s) => (s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const inviteUrl = (c) => `${location.origin}${location.pathname}?room=${c}${backend?.kind === "local" ? "&local" : ""}`;

function show(view) {
  const changed = document.body.dataset.view !== view;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.body.dataset.view = view;
  if (changed && view !== "home") window.scrollTo(0, 0);
  if (changed && view === "game") requestAnimationFrame(() => arena.resize());
}

// ---------- State ----------
let backend = null;
let code = null;            // current room code
let room = null;            // latest room snapshot
let unwatch = null;
let hostOfflineSince = 0;
let wakeLock = null;
let qrFor = null;
let celebratedRound = null;
let play = null;            // my movement this round: { round, x, y, lastSent, sentX, sentY }
let sim = null;             // host only: { round, game, touching }
let finalizing = null;      // round number the host is ending
let prevGame = null;        // last crystal state seen, to spot steals/deliveries for effects
const buffers = new Map();  // uid -> recent position samples [{ t, x, y }]

const arena = new Arena($("arena"));
const controls = new Controls($("view-game"), $("stick"), $("stick-knob"));

const looksLikeTouch = () => matchMedia("(pointer: coarse)").matches;
const me = () => room?.players?.[backend.uid];
const isHost = () => room?.hostId === backend.uid;
const isParticipant = () => !!room?.participants?.[backend.uid];
const roomPath = (p = "") => `rooms/${code}${p ? "/" + p : ""}`;
const onlinePlayers = () => Object.entries(room?.players || {})
  .filter(([, p]) => p.online)
  .sort(([ia, a], [ib, b]) => (a.joinedAt || 0) - (b.joinedAt || 0) || ia.localeCompare(ib));

// ---------- Sound + haptics ----------
let audio = null;
function unlockAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch { /* no audio */ }
}
function chime(freqs, { type = "triangle", vol = 0.09, len = 0.35, gap = 0.06 } = {}) {
  if (!audio) return;
  const t0 = audio.currentTime;
  freqs.forEach((f, i) => {
    const t = t0 + i * gap;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + len + 0.05);
  });
}
const SFX = {
  tick: () => chime([880], { len: 0.15 }),
  go: () => chime([1046.5, 1568], { len: 0.4, gap: 0.03 }),
  pickup: () => chime([1318.5, 1760], { len: 0.25 }),
  pass: () => chime([1174.7, 1568], { len: 0.2 }),
  steal: () => chime([622, 466], { type: "square", vol: 0.05, len: 0.2, gap: 0.08 }),
  deliver: () => chime([1046.5, 1318.5, 1568, 2093], { len: 0.5, gap: 0.07 }),
  end: () => chime([784, 659, 523], { type: "sine", vol: 0.12, len: 0.6, gap: 0.15 }),
};
const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* ignore */ } };

async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => { wakeLock = null; });
    }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}

// ---------- Controls choice ----------
let selectedInput = localStorage.getItem("crystal-chaos-input") || (looksLikeTouch() ? "stick" : "keys");

function selectInput(mode) {
  selectedInput = mode;
  localStorage.setItem("crystal-chaos-input", mode);
  for (const [id, m] of [["home-stick", "stick"], ["home-keys", "keys"], ["lobby-stick", "stick"], ["lobby-keys", "keys"]]) {
    $(id).classList.toggle("selected", m === mode);
    $(id).setAttribute("aria-pressed", String(m === mode));
  }
  $("move-hint").textContent = mode === "keys" ? "Move with WASD or the arrow keys" : "Drag anywhere to move";
}

async function changeInput(mode) {
  selectInput(mode);
  if (code) await backend.update(roomPath(`players/${backend.uid}`), { input: mode });
}

// ---------- Rooms ----------
function playerRecord(name, team) {
  return { name, online: true, joinedAt: backend.serverNow(), input: selectedInput, team };
}

async function createRoom() {
  const name = readName();
  if (!name) return;
  unlockAudio();
  setBusy(true);
  try {
    for (let i = 0; i < 8; i++) {
      const c = randomCode();
      const ok = await backend.createIfAbsent(`rooms/${c}`, {
        hostId: backend.uid,
        status: "lobby",
        round: 0,
        createdAt: backend.serverNow(),
        players: { [backend.uid]: playerRecord(name, "A") },
      });
      if (ok) return enterRoom(c);
    }
    homeError("Couldn't create a room. Try again.");
  } catch (err) {
    console.error(err);
    homeError("Couldn't create a room. Check your connection.");
  } finally {
    setBusy(false);
  }
}

async function joinRoom(c) {
  const name = readName();
  if (!name) return;
  unlockAudio();
  c = cleanCode(c);
  if (c.length !== 4) return homeError("Room codes are 4 letters.");
  setBusy(true);
  try {
    const r = await backend.get(`rooms/${c}`);
    if (!r?.hostId) {
      setInviteMode(null); // let them create their own room instead
      return homeError(`Room ${c} doesn't exist any more. Create a new one, or check the code.`);
    }
    const existing = r.players?.[backend.uid];
    const others = Object.entries(r.players || {}).filter(([id, p]) => id !== backend.uid && p.online);
    if (others.length >= MAX_PLAYERS) {
      return homeError(`Room ${c} is full: Crystal Chaos is for up to ${MAX_PLAYERS} players.`);
    }
    const count = (t) => others.filter(([, p]) => p.team === t).length;
    const inRound = r.status === "playing" && r.participants?.[backend.uid]?.team;
    const team = inRound
      || (existing?.team && count(existing.team) < 2 ? existing.team : (count("A") <= count("B") ? "A" : "B"));
    await backend.update(`rooms/${c}/players/${backend.uid}`, existing
      ? { name, online: true, input: selectedInput, team }
      : playerRecord(name, team));
    enterRoom(c);
  } catch (err) {
    console.error(err);
    homeError("Couldn't join that room. Check your connection.");
  } finally {
    setBusy(false);
  }
}

function enterRoom(c) {
  code = c;
  history.replaceState(null, "", `?room=${c}${backend.kind === "local" ? "&local" : ""}`);
  backend.onDisconnectSet(roomPath(`players/${backend.uid}/online`), false);
  unwatch?.();
  unwatch = backend.watch(roomPath(), onRoom);
}

async function leaveRoom() {
  if (!code) return;
  const c = code;
  unwatch?.();
  unwatch = null;
  await backend.cancelOnDisconnect(roomPath(`players/${backend.uid}/online`));
  await backend.set(`rooms/${c}/players/${backend.uid}`, null);
  code = null;
  room = null;
  play = null;
  keepAwake(false);
  history.replaceState(null, "", location.pathname + (backend.kind === "local" && params.has("local") ? "?local" : ""));
  setInviteMode(null);
  show("home");
}

function teamCounts(list = onlinePlayers()) {
  return {
    n: list.length,
    A: list.filter(([, p]) => p.team === "A").length,
    B: list.filter(([, p]) => p.team === "B").length,
  };
}
function canStart() {
  const { n, A, B } = teamCounts();
  return (n === 2 && A === 1 && B === 1) || (n === 4 && A === 2 && B === 2);
}

async function switchTeam() {
  const mine = me()?.team || "A";
  const target = other(mine);
  const others = onlinePlayers().filter(([id]) => id !== backend.uid);
  if (others.filter(([, p]) => p.team === target).length >= 2) return;
  await backend.update(roomPath(`players/${backend.uid}`), { team: target });
}

async function startGame() {
  if (!isHost() || !canStart()) return;
  const list = onlinePlayers();
  const startAt = backend.serverNow() + COUNTDOWN_MS;
  const seed = Math.floor(Math.random() * 1e9);
  const participants = Object.fromEntries(list.map(([id, p]) => [id, {
    name: p.name, team: p.team, input: p.input || "stick", joinedAt: p.joinedAt || 0,
  }]));
  await backend.update(roomPath(), {
    status: "playing",
    round: (room.round || 0) + 1,
    seed,
    startAt,
    endsAt: startAt + TIME_LIMIT_MS,
    participants,
    game: newGame(seed, participants),
    pos: null,
    result: null,
  });
}

async function playAgain() {
  if (!isHost()) return;
  await backend.update(roomPath(), {
    status: "lobby", participants: null, startAt: null, endsAt: null, game: null, pos: null, result: null,
  });
}

// ---------- Live room updates ----------
function onRoom(r) {
  const prevRound = room?.round;
  room = r;
  if (room && room.round !== prevRound) { buffers.clear(); prevGame = null; }
  if (room?.pos) ingestPositions(room.pos);
  if (room?.status === "playing" && room.game) {
    if (prevGame && prevGame.v !== room.game.v) gameEffects(prevGame, room.game);
    prevGame = room.game;
  }
  render();
}

function ingestPositions(pos) {
  for (const [id, p] of Object.entries(pos)) {
    if (id === backend.uid || typeof p?.t !== "number") continue;
    const buf = buffers.get(id) || [];
    if (!buf.length || p.t > buf[buf.length - 1].t) {
      buf.push({ t: p.t, x: p.x, y: p.y });
      if (buf.length > 20) buf.shift();
      buffers.set(id, buf);
    }
  }
}

function spawnFor(id) {
  const info = room.participants?.[id];
  const team = info?.team || "A";
  const mates = Object.entries(room.participants || {})
    .filter(([, p]) => p.team === team)
    .sort(([ia, a], [ib, b]) => (a.joinedAt || 0) - (b.joinedAt || 0) || ia.localeCompare(ib))
    .map(([pid]) => pid);
  const i = Math.max(0, mates.indexOf(id));
  // A team of one starts in the middle lane.
  if (mates.length === 1) return { x: SPAWNS[team][0].x, y: H / 2 };
  return SPAWNS[team][i % 2];
}

/** Where to draw a player now: me from local input, others smoothed from their samples. */
function positionOf(id, now) {
  if (id === backend.uid && play) return { x: play.x, y: play.y };
  const buf = buffers.get(id);
  if (!buf?.length) return spawnFor(id);
  const t = now - INTERP_DELAY_MS;
  if (t <= buf[0].t) return buf[0];
  for (let i = buf.length - 1; i > 0; i--) {
    const a = buf[i - 1], b = buf[i];
    if (t >= a.t && t <= b.t) {
      const k = (t - a.t) / Math.max(1, b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return buf[buf.length - 1];
}

function renderedPositions(now) {
  const out = {};
  for (const id of Object.keys(room.participants || {})) out[id] = positionOf(id, now);
  return out;
}

/** Spot pickups, steals, passes and deliveries for pop-ups, sounds and buzzes. */
function gameEffects(a, b) {
  const now = backend.serverNow();
  const pos = renderedPositions(now);
  const teamOf = (id) => room.participants?.[id]?.team;
  const mine = backend.uid;
  for (const [k, c] of Object.entries(b.crystals || {})) {
    const was = a.crystals?.[k];
    if (!was) continue;
    if (c.s === "held" && (was.s !== "held" || was.by !== c.by)) {
      const at = pos[c.by] || { x: c.x, y: c.y };
      const col = TEAMS[teamOf(c.by)]?.color || "#fff";
      let kind = "pickup";
      if (was.s === "stored") kind = "raid";
      else if (was.s === "held") kind = teamOf(was.by) === teamOf(c.by) ? "pass" : "steal";
      const label = { pickup: "", raid: "RAIDED!", steal: "STOLEN!", pass: "PASS!" }[kind];
      arena.pop(at.x, at.y, label, col);
      if (c.by === mine) { buzz(kind === "pickup" ? 15 : 30); SFX[kind === "raid" ? "steal" : kind](); }
      else if (was.by === mine && kind === "steal") { buzz([60, 40, 60]); SFX.steal(); }
      else if (kind === "raid" && teamOf(mine) === was.team) { buzz([60, 40, 60]); SFX.steal(); }
    }
    if (c.s === "stored" && was.s !== "stored") {
      const slot = SLOTS[c.team][c.slot] || SLOTS[c.team][0];
      arena.pop(slot.x, slot.y, "+1", TEAMS[c.team].color);
      if (teamOf(mine) === c.team) SFX.deliver();
      if (was.by === mine) buzz([20, 30, 20, 30, 60]);
    }
  }
}

// ---------- Rendering (screens) ----------
function render() {
  if (!code) return show("home");
  if (!room) {
    const c = code;
    code = null;
    unwatch?.();
    show("home");
    homeError(`Room ${c} has closed.`);
    return;
  }
  if (!me()) return; // our join write hasn't landed yet

  maybeTakeOverHost();

  if (room.status === "lobby") {
    if (play) { play = null; keepAwake(false); }
    return renderLobby();
  }
  if (room.status === "results") return renderResults();
  renderGame();
}

function renderLobby() {
  show("lobby");
  $("room-code").textContent = code;
  renderQr();
  selectInput(me()?.input || selectedInput);

  const list = onlinePlayers();
  const counts = teamCounts(list);
  $("player-count").textContent = `${list.length} of ${MAX_PLAYERS}`;
  for (const t of ["A", "B"]) {
    const ul = $(`team-${t}`);
    ul.innerHTML = "";
    const players = list.filter(([, p]) => p.team === t);
    for (const [id, p] of players) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = (id === room.hostId ? "👑 " : "") + p.name;
      if (id === backend.uid) { name.classList.add("me"); name.textContent += " (you)"; }
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = INPUT_ICON[p.input] || INPUT_ICON.stick;
      tag.title = p.input === "keys" ? "Keyboard" : "Joystick";
      li.append(name, tag);
      ul.appendChild(li);
    }
    for (let i = players.length; i < 2; i++) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Open slot";
      ul.appendChild(li);
    }
  }

  const myTeam = me()?.team || "A";
  const target = other(myTeam);
  const targetFull = list.filter(([id, p]) => id !== backend.uid && p.team === target).length >= 2;
  $("switch-team").textContent = `Switch to ${TEAMS[target].name}`;
  $("switch-team").disabled = targetFull;
  $("switch-team").dataset.team = target;

  const ok = canStart();
  $("start-btn").hidden = !isHost();
  $("start-btn").disabled = !ok;
  $("start-btn").textContent = ok
    ? `Start game · ${counts.n === 2 ? "1 v 1" : "2 v 2"}`
    : `Start game · ${counts.n} player${counts.n === 1 ? "" : "s"}`;
  let msg;
  if (ok) msg = isHost() ? "Teams are set. Tap Start when you're ready!" : "Teams are set. Waiting for the host to start…";
  else if (counts.n < 2) msg = "Waiting for more players to join…";
  else if (counts.n === 3) msg = "Crystal Chaos is 1 v 1 or 2 v 2: waiting for a 4th player (or one to leave).";
  else msg = "Balance the teams: each side needs the same number of players.";
  $("lobby-wait").textContent = msg;
}

function renderQr() {
  if (qrFor === code) return;
  const box = $("qr");
  if (!window.qrcode) {
    box.innerHTML = "";
    window.addEventListener("load", () => { qrFor = null; if (room?.status === "lobby") renderQr(); }, { once: true });
    return;
  }
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(inviteUrl(code));
    qr.make();
    box.innerHTML = qr.createImgTag(5, 0, "QR code to join");
    qrFor = code;
  } catch { box.innerHTML = ""; }
}

function ensurePlay() {
  if (!isParticipant()) { play = null; return; }
  if (play?.round === room.round) return;
  const saved = room.pos?.[backend.uid]; // resuming after a reload
  const start = saved && typeof saved.x === "number" ? saved : spawnFor(backend.uid);
  play = { round: room.round, x: start.x, y: start.y, lastSent: 0, sentX: null, sentY: null };
  controls.reset();
  controls.moved = false;
  $("move-hint").hidden = false;
  keepAwake(true);
  sendPos(true);
}

function renderGame() {
  ensurePlay();
  show("game");
  const spectator = !isParticipant();
  const team = spectator ? null : room.participants[backend.uid].team;
  $("you-chip").hidden = spectator;
  if (team) {
    $("you-chip").textContent = `You · ${TEAMS[team].name}`;
    $("you-chip").dataset.team = team;
  }
  $("spectate-msg").hidden = !spectator;
}

function renderResults() {
  if (document.body.dataset.view !== "results") {
    // Avoid accidental taps on the buttons while people are still mid-swipe.
    for (const id of ["again-btn", "leave-btn-2"]) {
      $(id).disabled = true;
      setTimeout(() => ($(id).disabled = false), 1500);
    }
  }
  show("results");
  keepAwake(false);
  const res = room.result || finalResult(room.game || {});

  const banner = $("result-banner");
  banner.dataset.team = res.winner;
  $("result-title").textContent = res.winner === "draw" ? "It's a draw!" : `${TEAMS[res.winner].name} wins!`;
  const myTeam = room.participants?.[backend.uid]?.team;
  $("result-sub").textContent = !myTeam ? "Join in next round!"
    : res.winner === "draw" ? "Dead level. Rematch?"
    : res.winner === myTeam ? "Your team takes the crystals 💎" : "So close. Get them back next round!";

  for (const t of ["A", "B"]) {
    const s = res[t] || { d: 0, held: 0, total: 0 };
    $(`final-${t}`).textContent = s.total;
    $(`break-${t}`).textContent = `${s.d} deliver${s.d === 1 ? "y" : "ies"} + ${s.held} × 5 in base`;
    $(`card-${t}`).classList.toggle("winner", res.winner === t);
  }

  const stats = room.game?.stats || {};
  const rows = Object.entries(room.participants || {}).map(([id, p]) => {
    const st = stats[id] || { d: 0, s: 0, p: 0 };
    return { id, name: room.players?.[id]?.name || p.name, team: p.team, input: p.input, ...st };
  }).sort((a, b) => (b.d - a.d) || (b.s - a.s) || (b.p - a.p));

  const ol = $("player-stats");
  ol.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    li.dataset.team = r.team;
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = medals[i] || `${i + 1}.`;
    const name = document.createElement("span");
    name.className = "pname";
    name.textContent = `${r.name}${r.id === backend.uid ? " (you)" : ""} ${INPUT_ICON[r.input] || ""}`;
    const st = document.createElement("span");
    st.className = "stats";
    st.textContent = `💎 ${r.d}  ⚡ ${r.s}  🤝 ${r.p}`;
    st.title = "Deliveries · Steals · Passes";
    li.append(rank, name, st);
    ol.appendChild(li);
  });

  $("again-btn").hidden = !isHost();
  $("again-wait").hidden = isHost();

  if (celebratedRound !== room.round) {
    celebratedRound = room.round;
    if (myTeam && res.winner === myTeam) confetti(TEAMS[myTeam].color);
  }
}

function confetti(main) {
  const layer = document.createElement("div");
  layer.className = "confetti";
  document.body.appendChild(layer);
  const colours = [main, "#ffffff", "#c9b8ff", "#9fd8ff"];
  for (let i = 0; i < 70; i++) {
    const d = document.createElement("div");
    const size = 7 + Math.random() * 9;
    Object.assign(d.style, {
      position: "absolute", left: Math.random() * 100 + "vw", top: "-20px",
      width: size + "px", height: size * 1.4 + "px",
      background: colours[i % colours.length],
      clipPath: "polygon(50% 0, 100% 45%, 50% 100%, 0 45%)", // little crystals
    });
    layer.appendChild(d);
    d.animate(
      [
        { transform: "translate(0,0) rotate(0)" },
        { transform: `translate(${(Math.random() - 0.5) * 200}px, 110vh) rotate(${Math.random() * 900}deg)` },
      ],
      { duration: 2200 + Math.random() * 1800, delay: Math.random() * 600, easing: "cubic-bezier(.3,.6,.6,1)", fill: "forwards" }
    );
  }
  setTimeout(() => layer.remove(), 5000);
}

// ---------- Movement + drawing (every frame) ----------
function sendPos(force = false) {
  if (!play || !code) return;
  const now = backend.serverNow();
  const movedSince = play.sentX !== Math.round(play.x) || play.sentY !== Math.round(play.y);
  if (!force && (now - play.lastSent < POS_SEND_MS || (!movedSince && now - play.lastSent < 1000))) return;
  play.lastSent = now;
  play.sentX = Math.round(play.x);
  play.sentY = Math.round(play.y);
  backend.set(roomPath(`pos/${backend.uid}`), { x: play.sentX, y: play.sentY, t: Math.round(now) }).catch(() => {});
}

let lastFrame = performance.now();
function frame(ts) {
  const dt = Math.min(0.05, (ts - lastFrame) / 1000);
  lastFrame = ts;
  if (room && code && room.status === "playing" && document.body.dataset.view === "game") {
    const now = backend.serverNow();
    const live = now >= room.startAt && now < room.endsAt;
    if (play && live) {
      const v = controls.vector();
      const next = clampPos(play.x + v.x * SPEED * dt, play.y + v.y * SPEED * dt);
      play.x = next.x;
      play.y = next.y;
      if (controls.moved) $("move-hint").hidden = true;
    }
    if (play && now <= room.endsAt + 200) sendPos();
    drawArena(now, !live && now >= room.endsAt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function drawArena(now, frozen) {
  const pos = renderedPositions(now);
  const players = Object.entries(room.participants || {}).map(([id, p]) => ({
    id, ...pos[id], team: p.team, name: room.players?.[id]?.name || p.name,
    me: id === backend.uid, online: room.players?.[id]?.online !== false,
  }));
  const crystals = Object.values(room.game?.crystals || {}).map((c) => ({
    ...crystalPos(c, pos), s: c.s, team: c.team, carrier: c.s === "held" ? c.by : null,
  }));
  arena.draw(players, crystals, { frozen });
}

// ---------- Host: run the rules ----------
setInterval(() => {
  if (!room || !code || !isHost() || room.status !== "playing" || !room.game) return;
  const now = backend.serverNow();
  if (!sim || sim.round !== room.round) {
    sim = { round: room.round, game: JSON.parse(JSON.stringify(room.game)), touching: new Set() };
  }
  if (now < room.startAt || now > room.endsAt + 250) return;
  const players = {};
  for (const [id, p] of Object.entries(room.participants || {})) {
    const at = id === backend.uid ? play : room.pos?.[id];
    if (!at || typeof at.x !== "number") continue;
    players[id] = { x: at.x, y: at.y, team: p.team, online: room.players?.[id]?.online !== false };
  }
  const { changed } = stepGame(sim.game, players, sim.touching, now);
  if (changed) backend.set(roomPath("game"), sim.game).catch((e) => console.warn(e));
}, HOST_TICK_MS);

// ---------- Clock tick: countdown, timer, scores, host duties ----------
let lastCount = null;
setInterval(() => {
  if (!room || !code) return;
  const now = backend.serverNow();

  if (room.status === "playing" && document.body.dataset.view === "game") {
    const cd = $("countdown");
    let label = "";
    if (now < room.startAt) {
      const n = Math.ceil((room.startAt - now) / 1000);
      label = n > 3 ? "" : String(n);
    } else if (now < room.startAt + 700) label = "GO!";
    else if (now >= room.endsAt) label = "TIME!";
    if (label !== lastCount) {
      cd.hidden = !label;
      cd.textContent = label;
      cd.classList.remove("pop"); void cd.offsetWidth; cd.classList.add("pop");
      if (label === "GO!") SFX.go();
      else if (label === "TIME!") { SFX.end(); buzz(200); }
      else if (label) SFX.tick();
      lastCount = label;
    }
    const left = Math.max(0, Math.min(TIME_LIMIT_MS, room.endsAt - Math.max(now, room.startAt)));
    $("hud-time").textContent = (left / 1000).toFixed(left < 10_000 ? 1 : 0);
    $("hud-time").classList.toggle("hurry", left > 0 && left < 5000);
    const s = scores(room.game);
    for (const t of ["A", "B"]) {
      $(`score-${t}`).textContent = s[t].total;
      $(`held-${t}`).textContent = s[t].held ? `💎×${s[t].held}` : "";
    }
  } else {
    lastCount = null;
  }

  // Host ends the round shortly after time runs out.
  if (isHost() && room.status === "playing" && now > room.endsAt + 1000 && finalizing !== room.round) {
    finalizing = room.round;
    const game = sim?.round === room.round ? sim.game : room.game;
    backend.update(roomPath(), { status: "results", result: finalResult(game || {}), game })
      .catch(() => { finalizing = null; });
  }

  maybeTakeOverHost();
}, 100);

function maybeTakeOverHost() {
  if (!room || isHost() || !me()?.online) return;
  const host = room.players?.[room.hostId];
  if (host?.online) { hostOfflineSince = 0; return; }
  if (!hostOfflineSince) hostOfflineSince = Date.now();
  if (Date.now() - hostOfflineSince < HOST_GRACE_MS) return;
  const next = onlinePlayers()[0];
  if (next?.[0] === backend.uid) {
    hostOfflineSince = 0;
    backend.set(roomPath("hostId"), backend.uid).catch(() => {});
  }
}

// ---------- Home screen ----------
function readName() {
  const name = $("name-input").value.trim().slice(0, 16);
  if (!name) {
    homeError("Enter your name first.");
    $("name-input").focus();
    return null;
  }
  localStorage.setItem("crystal-chaos-name", name);
  return name;
}
function homeError(msg) { $("home-error").textContent = msg; }

/** Opened from an invite link: only show name + join. */
function setInviteMode(c) {
  const on = !!c;
  document.body.classList.toggle("invite", on);
  $("invite-head").hidden = !on;
  $("invite-code").textContent = c || "";
  $("invite-join-btn").hidden = !on;
  $("create-btn").hidden = on;
  $("join-divider").hidden = on;
  $("join-row").hidden = on;
}
function setBusy(b) {
  for (const id of ["create-btn", "join-btn", "invite-join-btn"]) $(id).disabled = b;
}

$("create-btn").addEventListener("click", () => { homeError(""); keepAwake(true); createRoom(); });
$("join-btn").addEventListener("click", () => { homeError(""); keepAwake(true); joinRoom($("code-input").value); });
$("invite-join-btn").addEventListener("click", () => { homeError(""); keepAwake(true); joinRoom($("invite-code").textContent); });
$("name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") (!$("invite-join-btn").hidden ? $("invite-join-btn") : $("create-btn")).click();
});
$("code-input").addEventListener("input", (e) => { e.target.value = cleanCode(e.target.value); });
$("code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("join-btn").click(); });
$("home-stick").addEventListener("click", () => selectInput("stick"));
$("home-keys").addEventListener("click", () => selectInput("keys"));
$("lobby-stick").addEventListener("click", () => changeInput("stick"));
$("lobby-keys").addEventListener("click", () => changeInput("keys"));
$("switch-team").addEventListener("click", switchTeam);
$("start-btn").addEventListener("click", () => { unlockAudio(); startGame(); });
$("again-btn").addEventListener("click", playAgain);
$("leave-btn").addEventListener("click", leaveRoom);
$("leave-btn-2").addEventListener("click", leaveRoom);
$("share-btn").addEventListener("click", async () => {
  const url = inviteUrl(code);
  try {
    if (navigator.share) {
      await navigator.share({ title: "Crystal Chaos", text: `Join my Crystal Chaos room: ${code}`, url });
    } else {
      await navigator.clipboard.writeText(url);
      $("share-note").textContent = "Link copied!";
      setTimeout(() => ($("share-note").textContent = ""), 2500);
    }
  } catch { /* share cancelled */ }
});
document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && play) keepAwake(true);
});
window.addEventListener("resize", () => arena.resize());
selectInput(selectedInput);

// ---------- Boot ----------
async function boot() {
  show("home");
  $("name-input").value = localStorage.getItem("crystal-chaos-name") || "";
  const roomParam = cleanCode(params.get("room"));
  if (roomParam) { $("code-input").value = roomParam; setInviteMode(roomParam); }

  const configured = firebaseConfig?.apiKey && !firebaseConfig.apiKey.startsWith("YOUR");
  const banner = $("mode-banner");
  setBusy(true);
  try {
    if (configured && !params.has("local")) {
      const { createFirebaseBackend } = await import("./backend-firebase.js");
      backend = await createFirebaseBackend(firebaseConfig);
      backend.onReconnect(() => {
        if (!code) return;
        backend.update(roomPath(`players/${backend.uid}`), { online: true });
        backend.onDisconnectSet(roomPath(`players/${backend.uid}/online`), false);
      });
    } else {
      backend = createLocalBackend();
      banner.hidden = false;
      banner.textContent = configured
        ? "Local demo mode: open more tabs on this device to add players."
        : "Local demo mode: add your Firebase config to play across devices. Open more tabs to add players.";
    }
  } catch (err) {
    console.error(err);
    banner.hidden = false;
    banner.textContent = "Couldn't connect to the game server. Check your connection and reload.";
    return;
  }
  setBusy(false);
  window.__cc = { get backend() { return backend; }, get room() { return room; }, get play() { return play; } }; // for testing
}

boot();
