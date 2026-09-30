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
    // Pose flags the remote walk-cycle needs (client systems/avatarAnim.js):
    // airborne tucks the limbs, seated sits on the bench (the model also sinks).
    grounded: t.boolean().default(true),
    seated: t.boolean().default(false),
    // Bumped once per fart (see LobbyRoom.ts `fart`). Every client plays the
    // hunch pose + gas cloud locally when this changes, so only a counter is
    // synced, not per-frame pose or particles. The 180 turn rides on `yaw`.
    // Belly/waist size multiplier (client systems/belly.js), cosmetic; every
    // client scales that player's belly to it. Clamped to BELLY_SIZE_MIN..MAX.
    bellySize: t.number().default(1),
    fartSeq: t.number().default(0),
    // Id of the player's equipped Training Food (client data/foods.js), shown
    // on the table in front of them while `seated`. Shape-checked against
    // FOOD_ID_PATTERN, "" until the first `stats`.
    equippedFood: t.string().default(""),
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
