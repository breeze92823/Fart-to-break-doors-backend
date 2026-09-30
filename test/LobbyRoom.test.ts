import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { LobbyState } from "../src/rooms/schema/LobbyState.js";
import { sanitizeProgress, sanitizeFoods, type LobbyRoom } from "../src/rooms/LobbyRoom.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// Hand-rolled fake `players` collection implementing only the subset
// LobbyRoom.ts calls: find().sort().limit().toArray(), updateOne() (upsert),
// findOne(). No MongoDB runs in the test process.
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      docs.set(filter._id, { ...base, ...(update.$set ?? {}) } as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

function baseDoc(overrides: Partial<PlayerDoc> = {}): PlayerDoc {
  return {
    _id: "test",
    cash: 0,
    fartPower: 1,
    rebirths: 0,
    trainingFoods: {},
    farts: 0,
    wins: 0,
    version: 1,
    updatedAt: new Date(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LobbyRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  // Tests that swap in a fake collection reset it so the others keep
  // exercising the real "no MONGODB_URI" no-op path.
  afterEach(() => __setPlayersForTest(null));

  it("relays move, avatar and stats between two clients", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    client1.send("move", { x: 1, y: 2, z: 3, yaw: 0.5, moveBlend: 0.75 });
    await room.waitForNextPatch();
    const p1 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p1.x, 1);
    assert.strictEqual(p1.moveBlend, 0.75);

    const avatar = JSON.stringify({ e: { headId: "42" }, p: { height: 1.2 } });
    client1.send("setAvatar", { avatar });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.players.get(client1.sessionId).avatar, avatar);

    client1.send("stats", { fartPower: 250, rebirths: 3, farts: 900, wins: 30 });
    await room.waitForNextPatch();
    const s = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s.fartPower, 250);
    assert.strictEqual(s.rebirths, 3);
    assert.strictEqual(s.farts, 900);
    assert.strictEqual(s.wins, 30);

    // Negatives clamp to 0.
    client1.send("stats", { fartPower: -5, wins: -1 });
    await room.waitForNextPatch();
    const s2 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s2.fartPower, 0);
    assert.strictEqual(s2.wins, 0);
  });

  it("relays pose flags and fart events, rate-limited", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    client1.send("move", { x: 0, y: 0, z: 0, yaw: 0, moveBlend: 0, grounded: false, seated: true });
    await room.waitForNextPatch();
    await sleep(100);
    const p = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p.grounded, false);
    assert.strictEqual(p.seated, true);

    assert.strictEqual(p.fartSeq, 0);
    client1.send("stats", { bellySize: 9 });
    client1.send("fart", {});
    client1.send("fart", {}); // inside FART_MIN_INTERVAL_MS: dropped
    await room.waitForNextPatch();
    await sleep(100);
    assert.strictEqual(client2.state.players.get(client1.sessionId).fartSeq, 1);
    assert.strictEqual(client2.state.players.get(client1.sessionId).bellySize, 3); // clamped

    await sleep(350);
    client1.send("fart", {});
    await room.waitForNextPatch();
    await sleep(100);
    assert.strictEqual(client2.state.players.get(client1.sessionId).fartSeq, 2);
  });

  it("degrades to no-op persistence when Mongo is unreachable", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "bloxity-user-1" });
    client1.send("saveProgress", { cash: 42, fartPower: 5, rebirths: 1, wins: 7 });
    await room.waitForNextPatch();
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "");
  });

  it("registers/clears the userId mapping via identify, independent of join", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { username: "Guest" });
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);

    client1.send("identify", { username: "RealName", userId: "u1" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(client1.sessionId), "u1");
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "RealName");

    client1.send("identify", { username: "Guest", userId: "" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);
  });

  it("evicts a stale session that already claims the same userId", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const first = await colyseus.connectTo(room, { userId: "dup" });
    const second = await colyseus.connectTo(room, { userId: "dup" });
    await sleep(50);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(first.sessionId), false);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(second.sessionId), "dup");
    assert.strictEqual(room.state.players.has(first.sessionId), false);
  });

  it("saves progress, then sends it back as `progress` on the next sign-in", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Farter" });

    client1.send("saveProgress", {
      cash: 1234,
      fartPower: 42,
      rebirths: 2,
      farts: 500,
      wins: 12,
      trainingFoods: { beans: 3, "bad id!": 9, chili: 0 },
    });
    await sleep(100);

    const saved = fake.docs.get("u1")!;
    assert.strictEqual(saved.cash, 1234);
    assert.strictEqual(saved.fartPower, 42);
    assert.strictEqual(saved.username, "Farter");
    // Malformed ids and zero counts are dropped.
    assert.deepStrictEqual(saved.trainingFoods, { beans: 3 });

    // A fresh session for the same account is handed the saved doc. The
    // `progress` reply can land before a client-side handler is registered, so
    // capture it on the server side.
    let progress: any = null;
    const r = room as any;
    const origLoad = r.loadProgress.bind(r);
    r.loadProgress = (c: any, ...rest: any[]) => {
      const origSend = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        if (type === "progress") progress = msg;
        origSend(type, msg);
      };
      return origLoad(c, ...rest);
    };
    const client2 = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    assert.ok(progress, "progress message was sent");
    assert.strictEqual(progress.cash, 1234);
    assert.strictEqual(progress.wins, 12);
    assert.deepStrictEqual(progress.trainingFoods, { beans: 3 });
    assert.strictEqual(client2.state.players.get(client2.sessionId).fartPower, 42);
  });

  it("sends `noProgress` for a brand-new account", async () => {
    __setPlayersForTest(fakePlayersCollection());
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const r = room as any;
    const sent: string[] = [];
    const origLoad = r.loadProgress.bind(r);
    r.loadProgress = (c: any, ...rest: any[]) => {
      const origSend = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        sent.push(type);
        origSend(type, msg);
      };
      return origLoad(c, ...rest);
    };
    await colyseus.connectTo(room, { userId: "fresh" });
    await sleep(100);
    assert.ok(sent.includes("noProgress"));
    assert.ok(!sent.includes("progress"));
  });

  it("ignores saves from guests", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const guest = await colyseus.connectTo(room);
    guest.send("saveProgress", { cash: 999 });
    await sleep(50);
    assert.strictEqual(fake.docs.size, 0);
  });

  it("broadcasts a leaderboard merging online players with saved offline ones", async () => {
    const fake = fakePlayersCollection([
      baseDoc({ _id: "off1", username: "OfflineAce", fartPower: 9000, rebirths: 40, playTime: 7200, wins: 100 }),
      baseDoc({ _id: "u1", username: "Me", fartPower: 1 }), // online below -- must not duplicate
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Me" });
    client1.send("stats", { fartPower: 500, wins: 3 });
    await room.waitForNextPatch();

    const board: any = await new Promise((resolve) => {
      client1.onMessage("leaderboard", resolve);
      void (room as any).refreshLeaderboard();
    });
    assert.deepStrictEqual(
      board.fartPower.map((r: any) => [r.name, r.value]),
      [["OfflineAce", 9000], ["Me", 500]],
    );
    assert.strictEqual(board.fartPower.filter((r: any) => r.name === "Me").length, 1);
    assert.strictEqual(board.wins[0].name, "OfflineAce");
    assert.strictEqual(board.rebirths[0].name, "OfflineAce");
    assert.strictEqual(board.playTime[0].value, 7200);
    assert.ok(board.fartPower[1].id === client1.sessionId, "own row keeps the session id");
    assert.ok(board.fartPower[0].id.startsWith("offline:"), "offline rows never expose the real id");
    assert.deepStrictEqual(Object.keys(board).sort(), ["farts", "fartPower", "playTime", "rebirths", "wins"].sort());
  });

  it("counts server-measured playtime for signed-in players and persists it with $inc", async () => {
    const fake = fakePlayersCollection([baseDoc({ _id: "u1", playTime: 100 })]);
    // The fake has no $inc; emulate it so the flush is observable.
    const origUpdate = fake.updateOne.bind(fake);
    (fake as any).updateOne = async (f: any, u: any, o: any) => {
      if (u.$inc) {
        const d = fake.docs.get(f._id)!;
        d.playTime = (d.playTime ?? 0) + u.$inc.playTime;
        return;
      }
      return origUpdate(f, u, o);
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const c = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    const r = room as any;
    assert.strictEqual(c.state.players.get(c.sessionId).playTime, 100);
    // Pretend 90s have passed, then flush.
    r.playTimeMark.set(c.sessionId, Date.now() - 90_000);
    r.flushAllPlaytime();
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(room.state.players.get(c.sessionId).playTime, 190);
    // A client cannot forge it through saveProgress.
    c.send("saveProgress", { fartPower: 10, playTime: 999999 });
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(fake.docs.get("u1")!.fartPower, 10);
  });

  describe("sanitizeProgress", () => {
    it("rejects non-objects and clamps values", () => {
      assert.strictEqual(sanitizeProgress(null), null);
      assert.strictEqual(sanitizeProgress("x"), null);
      const out = sanitizeProgress({ cash: -3, fartPower: 1e30, rebirths: 99999.7, farts: 12.9, wins: NaN })!;
      assert.strictEqual(out.cash, 0);
      assert.strictEqual(out.fartPower, 1_000_000_000_000);
      assert.strictEqual(out.rebirths, 5000);
      assert.strictEqual(out.farts, 12);
      assert.strictEqual(out.wins, undefined);
      assert.strictEqual(out.trainingFoods, undefined);
    });
  });

  describe("sanitizeFoods", () => {
    it("keeps valid ids with positive integer counts and drops the rest", () => {
      assert.deepStrictEqual(sanitizeFoods({ beans: 2.9, chili: -1, "Bad Id": 4, tacos: "5", ok_1: 1 }), { beans: 2, ok_1: 1 });
      assert.deepStrictEqual(sanitizeFoods(null), {});
      assert.deepStrictEqual(sanitizeFoods([1, 2]), {});
    });

    it("caps the number of distinct foods and each count", () => {
      const many: Record<string, number> = {};
      for (let i = 0; i < 200; i++) many[`food${i}`] = 1;
      assert.strictEqual(Object.keys(sanitizeFoods(many)).length, 64);
      assert.strictEqual(sanitizeFoods({ beans: 1e15 }).beans, 1_000_000_000);
    });
  });
});
