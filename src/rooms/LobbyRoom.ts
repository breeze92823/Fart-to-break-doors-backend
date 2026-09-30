import { Room, Client, CloseCode } from "colyseus";
import { LobbyState, PlayerState } from "./schema/LobbyState.js";
import {
  LEADERBOARD_REFRESH_MS,
  LEADERBOARD_QUERY_LIMIT,
  PLAYTIME_FLUSH_MS,
  CASH_MAX,
  FART_POWER_MAX,
  REBIRTH_MAX,
  COUNTER_MAX,
  FOOD_ID_PATTERN,
  FOOD_MAX_KINDS,
  FOOD_MAX_COUNT,
  FART_MIN_INTERVAL_MS,
  BELLY_SIZE_MIN,
  BELLY_SIZE_MAX,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";

// One separate board per stat. The world has Rebirth and Fart Power stands;
// farts, wins and time played are served too so more stands can be added
// without a server change.
const LEADERBOARD_STATS = ["rebirths", "fartPower", "farts", "wins", "playTime"] as const;
type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
type LeaderboardRow = { id: string; name: string; value: number };
type LeaderboardPayload = Record<LeaderboardStat, LeaderboardRow[]>;
type OnlineRow = { sessionId: string; userId: string | null; username: string } & Record<LeaderboardStat, number>;

// Collapse online rows that still share a userId (e.g. a leave/join racing the
// same tick) down to one, keeping the higher value for the ranked stat.
// Guests have no id to key on and are never collapsed against each other.
function dedupeOnline(rows: OnlineRow[], stat: LeaderboardStat): OnlineRow[] {
  const byUserId = new Map<string, OnlineRow>();
  const anonymous: OnlineRow[] = [];
  for (const row of rows) {
    if (!row.userId) {
      anonymous.push(row);
      continue;
    }
    const existing = byUserId.get(row.userId);
    if (!existing || row[stat] > existing[stat]) byUserId.set(row.userId, row);
  }
  return [...byUserId.values(), ...anonymous];
}

// Cap on the JSON avatar blob (see LobbyState.ts PlayerState.avatar).
const AVATAR_MAX_LEN = 4096;

function sanitizeAvatar(raw: unknown): string {
  return typeof raw === "string" && raw.length <= AVATAR_MAX_LEN ? raw : "";
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}

function clampInt(v: number, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(v)));
}

// { foodId: count } -> only well-formed ids with positive integer counts,
// capped in both kinds and count. Zero counts are dropped.
export function sanitizeFoods(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let kinds = 0;
  for (const [id, count] of Object.entries(raw as Record<string, unknown>)) {
    if (kinds >= FOOD_MAX_KINDS) break;
    if (!FOOD_ID_PATTERN.test(id) || !finite(count)) continue;
    const n = clampInt(count, FOOD_MAX_COUNT);
    if (n <= 0) continue;
    out[id] = n;
    kinds++;
  }
  return out;
}

// Same client-trusted model as every other message here -- no server-side
// game-logic validation. What IS enforced: shape and bounds, so a malformed
// payload can never corrupt this player's own Mongo document. A forged number
// can only ever affect the sender's own save.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Partial<PlayerDoc> = {};

  if (finite(src.cash)) out.cash = clampNum(src.cash, CASH_MAX);
  if (finite(src.fartPower)) out.fartPower = clampNum(src.fartPower, FART_POWER_MAX);
  if (finite(src.rebirths)) out.rebirths = clampInt(src.rebirths, REBIRTH_MAX);
  if (finite(src.farts)) out.farts = clampInt(src.farts, COUNTER_MAX);
  if (finite(src.wins)) out.wins = clampInt(src.wins, COUNTER_MAX);
  if (src.trainingFoods !== undefined) out.trainingFoods = sanitizeFoods(src.trainingFoods);
  return out;
}

/**
 * Single global room every client joins via `client.joinOrCreate("lobby")`.
 * Clients report events (as they already do locally against
 * store/useGameStore.js); this room relays/stores them so other clients see
 * them too. No server-side gameplay validation.
 */
export class LobbyRoom extends Room<{ state: LobbyState }> {
  state = new LobbyState();

  // sessionId -> Bloxity user id, for whichever connected clients are signed
  // in. Deliberately NOT part of LobbyState: it has no reason to be broadcast,
  // it only gates this room's own Mongo reads/writes for that connection.
  userIds = new Map<string, string>();

  // sessionId -> epoch ms up to which that connection's playtime has already
  // been counted. Also not synced.
  private playTimeMark = new Map<string, number>();

  // sessionId -> epoch ms of the last accepted `fart`, for the rate limit.
  private lastFartAt = new Map<string, number>();

  messages = {
    // Throttled client-side -- not sent every physics frame.
    move: (client: Client, msg: any) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.x)) p.x = msg.x;
      if (finite(msg?.y)) p.y = msg.y;
      if (finite(msg?.z)) p.z = msg.z;
      if (finite(msg?.yaw)) p.yaw = msg.yaw;
      if (finite(msg?.moveBlend)) p.moveBlend = msg.moveBlend;
      if (typeof msg?.grounded === "boolean") p.grounded = msg.grounded;
      if (typeof msg?.seated === "boolean") p.seated = msg.seated;
    },
    // The player just farted. Only a counter is stored; every client (the
    // sender included, ignoring its own row) replays the pose and gas from the
    // bump. Rate-limited so a forged client can't spam clouds.
    fart: (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const now = Date.now();
      if (now - (this.lastFartAt.get(client.sessionId) ?? 0) < FART_MIN_INTERVAL_MS) return;
      this.lastFartAt.set(client.sessionId, now);
      p.fartSeq += 1;
    },
    // Bloxity avatar JSON; sent on connect and whenever the portal reports a change.
    setAvatar: (client: Client, msg: { avatar?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const avatar = sanitizeAvatar(msg?.avatar);
      if (avatar) p.avatar = avatar;
    },
    // Live stats for the in-world leaderboards, sent debounced on change.
    stats: (client: Client, msg: { fartPower?: number; rebirths?: number; farts?: number; wins?: number; bellySize?: number }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (finite(msg?.fartPower)) p.fartPower = clampNum(msg.fartPower, FART_POWER_MAX);
      if (finite(msg?.rebirths)) p.rebirths = clampInt(msg.rebirths, REBIRTH_MAX);
      if (finite(msg?.farts)) p.farts = clampInt(msg.farts, COUNTER_MAX);
      if (finite(msg?.wins)) p.wins = clampInt(msg.wins, COUNTER_MAX);
      if (finite(msg?.bellySize)) p.bellySize = Math.min(BELLY_SIZE_MAX, Math.max(BELLY_SIZE_MIN, msg.bellySize));
    },
    // Debounced push of the durable half of the client store. A guest has no
    // userId and this no-ops. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      const patch = sanitizeProgress(msg);
      if (!patch) return;
      // Display name comes from this connection's own PlayerState, not `msg`.
      const p = this.state.players.get(client.sessionId);
      try {
        await players.updateOne(
          { _id: userId },
          {
            $set: { ...patch, username: p?.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[LobbyRoom] saveProgress failed", err);
      }
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest
    // who signs in mid-session). Without this a late sign-in would never get
    // a userId and saveProgress would no-op for the whole session.
    identify: (client: Client, msg: { username?: string; userId?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = msg.username.slice(0, 64);
      this.setUserId(client, p, typeof msg?.userId === "string" ? msg.userId : "");
    },
  };

  // Runs once immediately -- a fresh room shouldn't sit on an empty board for
  // a full LEADERBOARD_REFRESH_MS -- then on a timer.
  onCreate() {
    void this.refreshLeaderboard();
    this.clock.setInterval(() => {
      void this.refreshLeaderboard();
    }, LEADERBOARD_REFRESH_MS);
    this.clock.setInterval(() => this.flushAllPlaytime(), PLAYTIME_FLUSH_MS);
  }

  // Adds the seconds elapsed since this session's last mark to its live
  // playTime and, for a signed-in player, $inc's the same amount into Mongo.
  // $inc (not $set) so it can't race saveProgress and a client can never
  // forge or reset its own time. Called by the interval, and right before a
  // session is dropped so the tail end of a visit isn't lost.
  private flushPlaytime(sessionId: string) {
    const mark = this.playTimeMark.get(sessionId);
    if (mark === undefined) return;
    const seconds = Math.floor((Date.now() - mark) / 1000);
    if (seconds <= 0) return;
    // Advance by whole seconds only, so sub-second remainders aren't dropped.
    this.playTimeMark.set(sessionId, mark + seconds * 1000);
    const p = this.state.players.get(sessionId);
    if (p) p.playTime += seconds;
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    players
      .updateOne(
        { _id: userId },
        { $inc: { playTime: seconds }, $set: { username: p?.username || "Player", updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      )
      .catch((err) => console.warn("[LobbyRoom] playtime flush failed", err));
  }

  private flushAllPlaytime() {
    for (const sessionId of [...this.playTimeMark.keys()]) this.flushPlaytime(sessionId);
  }

  // Drops a session's per-connection bookkeeping after a final playtime flush.
  private forgetSession(sessionId: string) {
    this.flushPlaytime(sessionId);
    this.playTimeMark.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.lastFartAt.delete(sessionId);
  }

  onJoin(client: Client, options?: { username?: string; avatar?: string; userId?: string }) {
    // No spawn assignment -- the client reports its real position in its
    // first "move" message.
    const p = new PlayerState();
    p.username = typeof options?.username === "string" ? options.username.slice(0, 64) : "";
    p.avatar = sanitizeAvatar(options?.avatar);
    this.state.players.set(client.sessionId, p);
    this.playTimeMark.set(client.sessionId, Date.now());

    this.setUserId(client, p, options?.userId ?? "");
    void this.refreshLeaderboard();
  }

  // Client-trusted Bloxity user id. A forged id can only read/overwrite the
  // SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin and `identify`.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    const userId = typeof raw === "string" ? raw.slice(0, 128) : "";
    const prev = this.userIds.get(client.sessionId) || "";
    if (userId === prev) return; // no change -- e.g. a username-only identify

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one
      // account never shows as two leaderboard rows / two racing Mongo writers
      // (a crashed tab lingers up to 20s via allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
      void this.loadProgress(client, userId, p);
    } else {
      // Logged out: stop persisting for this connection. The client flushes a
      // final saveProgress under the OLD id before sending this.
      this.userIds.delete(client.sessionId);
    }

    void this.refreshLeaderboard();
  }

  // Seeds this player's own leaderboard row immediately and sends the saved
  // doc to just this client so it can hydrate what LobbyState doesn't carry
  // (cash, training foods). A missing doc or unreachable Mongo leaves the
  // client on its own defaults.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    if (!players) return;
    try {
      const doc = await players.findOne({ _id: userId });
      if (!doc) {
        // A brand-new account: tell the client there's nothing to load so it
        // can start from its defaults right away instead of waiting on a timeout.
        client.send("noProgress", {});
        return;
      }
      p.fartPower = doc.fartPower ?? 1;
      p.rebirths = doc.rebirths ?? 0;
      p.farts = doc.farts ?? 0;
      p.wins = doc.wins ?? 0;
      // Saved total (already includes anything flushed while signed in this
      // session) -- guest time before signing in isn't counted.
      p.playTime = doc.playTime ?? 0;
      client.send("progress", {
        cash: doc.cash ?? 0,
        fartPower: p.fartPower,
        rebirths: p.rebirths,
        trainingFoods: sanitizeFoods(doc.trainingFoods),
        farts: p.farts,
        wins: p.wins,
        playTime: p.playTime,
      });
    } catch (err) {
      console.warn("[LobbyRoom] loadProgress failed", err);
    }
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at
  // once. Anything else (WiFi blip, backgrounded tab) gets 20s to reconnect
  // with the same session, instead of re-joining as a brand new player.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    // Count time up to the drop, then pause the clock for the reconnect window.
    this.flushPlaytime(client.sessionId);
    this.playTimeMark.delete(client.sessionId);
    try {
      await this.allowReconnection(client, 20);
      this.playTimeMark.set(client.sessionId, Date.now());
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // Builds and broadcasts the merged "all-time saved + currently online"
  // leaderboard. Only the server has both the live roster and the
  // sessionId->userId map needed to tell "this online player already IS a
  // saved account" apart from "this saved account is offline". A private
  // method so tests can call and await it directly.
  private async refreshLeaderboard() {
    const onlineRows: OnlineRow[] = [];
    const onlineUserIds = new Set<string>();
    this.state.players.forEach((p, sessionId) => {
      const userId = this.userIds.get(sessionId) ?? null;
      if (userId) onlineUserIds.add(userId);
      onlineRows.push({
        sessionId,
        userId,
        username: p.username || "Player",
        rebirths: p.rebirths,
        fartPower: p.fartPower,
        farts: p.farts,
        wins: p.wins,
        playTime: p.playTime,
      });
    });

    const players = getPlayers();
    const payload = { rebirths: [], fartPower: [], farts: [], wins: [], playTime: [] } as LeaderboardPayload;

    for (const stat of LEADERBOARD_STATS) {
      // Online rows first: a connected player's live value is more current
      // than their last debounced save.
      const merged: LeaderboardRow[] = dedupeOnline(onlineRows, stat).map((row) => ({
        id: row.sessionId,
        name: row.username,
        value: row[stat],
      }));

      // Then everyone who has EVER saved, minus accounts already shown live.
      if (players) {
        try {
          const docs = await players
            .find({}, { projection: { _id: 1, username: 1, [stat]: 1 } })
            .sort({ [stat]: -1 })
            .limit(LEADERBOARD_QUERY_LIMIT)
            .toArray();

          let offlineIndex = 0;
          for (const doc of docs) {
            if (onlineUserIds.has(doc._id)) continue;
            // Synthetic id -- never broadcast another account's raw Bloxity id.
            merged.push({
              id: `offline:${stat}:${offlineIndex++}`,
              name: doc.username || "Player",
              value: (doc[stat] as number | undefined) ?? 0,
            });
          }
        } catch (err) {
          console.warn(`[LobbyRoom] leaderboard query failed for stat=${stat}`, err);
        }
      }

      // Collapse rows sharing a display name (the same account under a
      // different id would otherwise appear twice). Keep the higher value but
      // prefer an online row's id so the client can recognise its own row.
      const byName = new Map<string, LeaderboardRow>();
      for (const row of merged) {
        const key = row.name || "Player";
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, row);
          continue;
        }
        const preferId = existing.id.startsWith("offline:") && !row.id.startsWith("offline:") ? row.id : existing.id;
        byName.set(key, { id: preferId, name: key, value: Math.max(existing.value, row.value) });
      }
      const deduped = [...byName.values()];

      deduped.sort((a, b) => b.value - a.value);
      payload[stat] = deduped.slice(0, LEADERBOARD_QUERY_LIMIT);
    }

    this.broadcast("leaderboard", payload);
  }
}
