// LobbyRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;

// Playtime: how often each connected player's elapsed time is added to their
// total (in memory for everyone, $inc'd to Mongo for signed-in players).
export const PLAYTIME_FLUSH_MS = 30_000;

// Upper bounds for saved values, so a forged payload can't push a bogus number
// onto the leaderboards. The client has no progression tables yet (see the
// client's PROGRESSION.md), so these are generous ceilings, not game rules.
export const CASH_MAX = 1_000_000_000_000_000;
export const FART_POWER_MAX = 1_000_000_000_000;
export const REBIRTH_MAX = 5000;
export const COUNTER_MAX = 1_000_000_000_000; // farts, wins

// Training Foods are saved as { foodId: count }. The food list is still TBD on
// the client, so ids are shape-checked rather than matched against a fixed
// list; add an allow-list here once the foods exist.
export const FOOD_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const FOOD_MAX_KINDS = 64;
export const FOOD_MAX_COUNT = 1_000_000_000;

// Client onboarding progress: the client's data/tutorial.js TUTORIAL_DONE_STEP
// (steps 0..8, 9 = finished). Keep in step by comment.
export const TUTORIAL_DONE_STEP = 9;

// Starting value for Fart Power (client PROGRESSION.md: fartPower starts at 1).
export const FART_POWER_START = 1;

// Belly/waist size multiplier bounds; keep in step with the client's
// BELLY_SIZE in systems/belly.js.
export const BELLY_SIZE_MIN = 0.5;
export const BELLY_SIZE_MAX = 3;

// Minimum gap between two accepted `fart` messages from one connection. The
// client's own retrigger is 0.4 s (systems/fart.js), so this only stops a
// modified client from flooding every other client with gas clouds.
export const FART_MIN_INTERVAL_MS = 300;
