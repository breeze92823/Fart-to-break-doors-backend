import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    x: t.number().default(0),
    y: t.number().default(0),
    z: t.number().default(0),
    yaw: t.number().default(0),
    // 0..1 eased gait factor (client systems/avatarAnim.js) -- purely cosmetic,
    // drives the remote walk-cycle blend.
    moveBlend: t.number().default(0),
    // The player's Bloxity avatar as an opaque JSON string, stored and relayed
    // as-is (length-capped, never parsed here). See LobbyRoom.ts AVATAR_MAX_LEN.
    avatar: t.string().default(""),
    // Live client-reported stats so the in-world leaderboards can rank
    // currently connected players. Only finite/non-negative checked, same trust
    // model as `username`/`avatar`. Durable state lives in Mongo (src/db.ts).
    // Cash and Training Foods are private to the player and are not synced.
    fartPower: t.number().default(1),
    rebirths: t.number().default(0),
    farts: t.number().default(0),
    wins: t.number().default(0),
    // Total seconds connected (saved total for a signed-in player + this
    // session), server-measured -- see LobbyRoom.ts flushPlaytime().
    playTime: t.number().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const LobbyState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "LobbyState",
);
export type LobbyState = SchemaType<typeof LobbyState>;
