# Fart to Break Doors Server

Colyseus multiplayer server for [Fart-to-break-doors](../Fart-to-break-doors) —
same stack as the Stone Skipping backend (`colyseus` + `@colyseus/schema` +
Mongo persistence + Bloxity Legion deploy), adapted to this game's progress:
Cash, Fart Power, Rebirth, Training Foods, Farts and Wins (see the client's
`PROGRESSION.md`).

## Usage

```
npm install
npm start
```

Then open http://localhost:2567 for the playground, or /monitor for the monitor.

## Structure

- `src/index.ts`: entry point (connects Mongo, then listens)
- `src/app.config.ts`: rooms, `/health`, CORS, dev-only monitor/playground
- `src/rooms/LobbyRoom.ts`: the single global room every client joins (`client.joinOrCreate("lobby")`)
- `src/rooms/schema/LobbyState.ts`: state synchronized to every client
- `src/db.ts`: Mongo-backed progress persistence (no-op if `MONGODB_URI` is unset/unreachable)
- `src/constants.ts`: leaderboard timing, value caps, training-food id rules
- `test/LobbyRoom.test.ts`: boots the real server against a fake Mongo collection

## Scripts

- `npm start`: watch mode (`tsx watch src/index.ts`)
- `npm test`: mocha suite
- `npm run build`: compile to `build/`
- `npm run loadtest`: N simulated clients

## Wire protocol

Join with `client.joinOrCreate("lobby", { username, avatar, userId })`.
`userId` is the stable Bloxity user id — omit it for a guest, whose progress
isn't persisted.

### Client → server

| Message | Payload | Cadence |
|---|---|---|
| `move` | `{ x, y, z, yaw, moveBlend }` | throttled |
| `setAvatar` | `{ avatar }` (opaque JSON string, ≤4 KB) | on connect + on change |
| `stats` | `{ fartPower, rebirths, farts, wins }` (all optional) | debounced on change |
| `saveProgress` | `{ cash, fartPower, rebirths, trainingFoods, farts, wins }` (all optional) | debounced; no-op for a guest |
| `identify` | `{ username, userId }` | when sign-in state changes after join |

`trainingFoods` is `{ [foodId]: count }`. The food list is still TBD on the
client, so the server accepts any id matching `^[a-z0-9_-]{1,32}$` (max 64
kinds, count ≤ 1e9) and drops zero counts. Tighten this in `src/constants.ts`
once the foods exist.

### Server → client

| Message | Payload | When |
|---|---|---|
| `progress` | saved doc: `{ cash, fartPower, rebirths, trainingFoods, farts, wins, playTime }` | after a signed-in join/identify, if a saved doc exists |
| `noProgress` | `{}` | after a signed-in join/identify with no saved doc (new account) |
| `leaderboard` | `{ rebirths, fartPower, farts, wins, playTime }`, each `Row[]` with `Row = { id, name, value }` | every 15s and on roster changes; live roster merged with all-time Mongo top scorers |

The world has two leaderboard stands, **REBIRTHS** and **FART POWER**; the
other boards are broadcast too so more stands need no server change.
`playTime` (total seconds connected) is **measured by the server clock** and
`$inc`'d to Mongo every 30s and on leave — never client-reported, so
`saveProgress` can't forge it. Time spent while disconnected/reconnecting isn't
counted, and guest time before signing in isn't either.

`LobbyState.players` (keyed by `sessionId`) carries `username`, `x/y/z/yaw`,
`moveBlend`, `avatar`, `fartPower`, `rebirths`, `farts`, `wins`, `playTime` for
every connected player. Cash and Training Foods are private and never synced.

The server trusts the client for gameplay values (the client is authoritative
locally); it only enforces shape and bounds so a bad payload can't corrupt the
sender's own save.

## Environment (runtime)

- `MONGODB_URI` — injected by Bloxity Legion; unset locally (persistence off).
- `CLIENT_ORIGIN` — injected when deployed; CORS falls back to `*` locally.
- `PORT` — injected by Legion; falls back to 2567.

## Deploy

`.github/workflows/deploy.yml` runs build + tests on every push and pull
request to `dev`/`main`. On a push (or manual run) it then builds a Docker
image, pushes it to GHCR and calls the Bloxity Legion deploy API: `dev` →
`dev` channel, `main` → `prod` channel.

GitHub settings (Settings → Secrets and variables → Actions):

| Name | Type | Value |
|---|---|---|
| `BLOXITY_GAME_ID` | **Variable** | Lowercase game ID from the Bloxity "My Games" dashboard (should be `fart-to-break-doors`, the client's `GAME_SLUG`) |
| `LEGION_DEPLOY_TOKEN` | **Secret** | Deploy token from the Bloxity dashboard |
| `GITHUB_TOKEN` | Automatic | Provided by GitHub; used to push to GHCR. Nothing to configure |

Also make sure Actions has write access to packages (Settings → Actions →
General → Workflow permissions), and that the GHCR package is readable by
Legion (public, or per Bloxity's instructions).
