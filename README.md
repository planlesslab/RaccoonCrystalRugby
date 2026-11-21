# 💎 Crystal Chaos

A 30-second team party game for phones and computers. Two teams race for two glowing crystals, carry them home to their glass base, and raid the other team's base to steal them back.

- **1 v 1 or 2 v 2**: up to 4 players. Players pick a team in the lobby, and the host can start once the teams are even.
- **Join by room code, invite link or QR code**
- **Everyone sees the whole arena** on their own phone or computer, with the score along the top. The arena is wide, so on an upright phone the game screen turns itself sideways: just hold the phone sideways to play.
- **Controls**: drag anywhere for a floating 🕹️ joystick, or use ⌨️ WASD / arrow keys. Both always work, and both move at the same top speed.
- **Live score, synced countdown and timer** based on the server clock
- **Results**: winning team, score breakdown, and each player's deliveries, steals and passes
- **Host handover**: if the host drops out for a minute, the next player takes over
- **No build step**: plain HTML, CSS and JavaScript, hosted free on GitHub Pages, with Firebase for live sync

![Cover](docs/cover.jpg)

## Rules

1. **Collect**: run into a crystal to pick it up. You can carry one at a time.
2. **Steal**: touch an opponent who's carrying a crystal to take it instantly.
3. **Deliver**: carry it into your team's glass base. It turns your colour and your team scores **+1**.
4. **Raid**: crystals in a base aren't safe. Touch one in the other team's base to grab it.
5. **Pass**: bump into your teammate to hand them your crystal.

When the timer hits zero, everything stops. Each crystal sitting in your base is worth **+5**. Delivery points are never lost, even if that crystal is stolen later. Highest total wins.

## Try it right now (no setup)

Until you add a Firebase config, the game runs in **local demo mode**: it syncs between tabs in one browser on one computer.

```bash
cd crystal-chaos
python3 -m http.server 8000
# open http://localhost:8000 in 2 or 4 tabs
```

## Set up Firebase (about 5 minutes, free)

1. Go to <https://console.firebase.google.com> → **Add project**. You don't need Analytics.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
3. **Build → Realtime Database → Create database**. Pick a region, then start in **locked mode**.
4. Open the database's **Rules** tab, delete what's there, paste in everything from [`database.rules.json`](database.rules.json), and click **Publish**.
5. **Project settings (⚙) → Your apps → Web (`</>`)**. Register an app (you don't need Firebase Hosting). When it shows the code, choose **"Use a `<script>` tag"**. Copy only the values inside `firebaseConfig = { … }` into [`js/firebase-config.js`](js/firebase-config.js), replacing the `YOUR_…` placeholders. Keep the word `export` at the start. Make sure `databaseURL` is there; if it's missing, copy the address shown at the top of the Realtime Database page.
6. **Authentication → Settings → Authorized domains → Add domain**: add `YOUR-USERNAME.github.io`.

The web config is meant to be public, so committing it is fine. Access is controlled by the database rules.

## Put it online with GitHub Pages

1. Create a new repository on GitHub, e.g. `Crystal-Chaos`.
2. Upload all the files in this folder (keep the folders `css`, `js` and `docs`, and the empty `.nojekyll` file).
3. On GitHub, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After a minute the game is live at `https://YOUR-USERNAME.github.io/Crystal-Chaos/`.

If your repository has a different name, update the `planlesslab.github.io/Crystal-Chaos` links at the top of `index.html` (nav link, preview image and description).

## How to play together

1. The host taps **Create a room** and shares the code, link or QR code.
2. Everyone enters a name and picks **🕹️ Joystick** (pre-selected on phones) or **⌨️ Keyboard** (pre-selected on computers). It can be changed in the lobby.
3. In the lobby, tap **Switch team** to change sides. Teams are filled automatically to stay even.
4. The host taps **Start game** (enabled at 1 v 1 or 2 v 2). After 3‑2‑1, go!
5. After 30 seconds the results appear. The host taps **Play again** to go back to the lobby with everyone still in.

## Troubleshooting

- **A yellow "Local demo mode" bar at the top** means the Firebase config isn't being used yet. Check `js/firebase-config.js` is filled in and pushed to GitHub.
- **Invite links ending in `&local`** were made while the site was still in demo mode. Share a fresh link from the lobby.
- **"Room is full"**: a room holds 4 players. A 5th person can join once someone leaves.
- **Testing on one computer with Firebase**: tabs in the same browser share one sign-in, so they count as the same player. Use different devices, or a normal window plus a private window.

## Tuning

| What | Where |
|---|---|
| Match length, countdown, how often positions are sent | top of `js/main.js` (`TIME_LIMIT_MS`, `COUNTDOWN_MS`, `POS_SEND_MS`) |
| Player speed, sizes, base positions, +5 bonus, hand-off cooldown | top of `js/rules.js` |
| Arena picture | `docs/arena.jpg` (how the game floor sits on it: `FLOOR` in `js/arena.js`; tray positions: `BASES` in `js/rules.js`) |
| Crystals and effects | `js/arena.js` |
| The raccoon characters | `docs/thief-A.png` and `docs/thief-B.png` (size in the arena: `SPRITE_W` in `js/arena.js`) |
| Page colours and scenery | `css/style.css` |

## How it works

Each device moves its own player and sends its position about 15 times a second. Other players are drawn slightly in the past so their movement looks smooth. The host's device runs the rules (pickups, steals, passes, deliveries) 20 times a second and shares the crystal state with everyone. On a normal connection a steal lands within about a tenth of a second.

## Project layout

```
index.html               screens (home, lobby, game, results)
css/style.css            lavender glass styling and scenery
css/planless.css         Planless Lab header and footer
js/main.js               game flow, rooms, teams, syncing, results
js/rules.js              arena layout and game rules (run by the host)
js/arena.js              canvas drawing: arena, crystals, players, effects
js/controls.js           floating joystick + keyboard
js/backend-firebase.js   Firebase Realtime Database adapter
js/backend-local.js      same API over localStorage for local demo mode
js/firebase-config.js    your Firebase web config
database.rules.json      security rules to paste into Firebase
docs/                    cover image, icon and the raccoon thief pictures (thief-A.png gold cap, thief-B.png violet cap), and the arena picture (arena.jpg)
```

## Known limitations

- Each device reports its own position, and the host decides the rules. It's built for friendly games, not tournaments.
- On a slow connection, players far from the host may see a steal land a moment late.
- Old rooms are never deleted. Each one is tiny, but you can clear `rooms` in the Firebase console whenever you like.
