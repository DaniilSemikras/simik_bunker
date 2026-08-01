"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { GameHistoryStore } = require("../lib/game-history-store");

test("история игр сохраняется на диск, ищется и удаляется", async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-history-test-"));
    const filePath = path.join(directory, "history.json");
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const store = new GameHistoryStore({ filePath, logger: { warn() {} } });
    await store.initialize();
    await store.append({
        gameId: "0000042",
        roomCode: "AB12",
        finishedAt: 42,
        participants: [{ nickname: "Мираи" }]
    });

    const restored = new GameHistoryStore({ filePath, logger: { warn() {} } });
    await restored.initialize();
    assert.equal(restored.get("0000042").roomCode, "AB12");
    assert.equal(restored.list({ roomCode: "ab" }).length, 1);
    assert.equal(restored.list({ player: "ира" }).length, 1);
    assert.equal(restored.maxNumericId(), 42);
    assert.equal(await restored.delete("0000042"), true);
    assert.equal(restored.list().length, 0);

    await restored.append({ gameId: "0000043", roomCode: "CD34", finishedAt: 43, participants: [] });
    await restored.append({ gameId: "0000044", roomCode: "EF56", finishedAt: 44, participants: [] });
    assert.equal(await restored.clear(), true);
    assert.equal(restored.list().length, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), []);
});

test("при отсутствии отдельной таблицы история сохраняется в bunker_config", async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-history-fallback-test-"));
    const filePath = path.join(directory, "history.json");
    const requests = [];
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    context.mock.method(global, "fetch", async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).includes("bunker_game_history")) {
            return { ok: false, status: 404, async json() { return {}; } };
        }
        if (!options.method || options.method === "GET") {
            return { ok: true, status: 200, async json() { return []; } };
        }
        return { ok: true, status: 201, async json() { return {}; } };
    });

    const store = new GameHistoryStore({
        filePath,
        supabaseUrl: "https://example.supabase.co",
        supabaseKey: "secret",
        logger: { warn() {} }
    });
    await store.initialize();
    await store.append({ gameId: "0000007", roomCode: "SAVE", finishedAt: 7, participants: [] });

    assert.equal(store.remoteBackend, "config-row");
    const fallbackWrite = requests.find((request) => request.options.method === "POST" && request.url.includes("bunker_config"));
    assert.ok(fallbackWrite);
    const payload = JSON.parse(fallbackWrite.options.body);
    assert.equal(payload.id, 2);
    assert.equal(payload.config.games[0].gameId, "0000007");
});

test("после появления таблицы хранилище переключается с fallback на неё", async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-history-recovery-test-"));
    const filePath = path.join(directory, "history.json");
    let historyTableAvailable = false;
    const requests = [];
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    context.mock.method(global, "fetch", async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).includes("bunker_game_history")) {
            if (!historyTableAvailable) return { ok: false, status: 404, async json() { return {}; } };
            return { ok: true, status: options.method === "POST" ? 201 : 200, async json() { return []; } };
        }
        if (!options.method || options.method === "GET") return { ok: true, status: 200, async json() { return []; } };
        return { ok: true, status: 201, async json() { return {}; } };
    });

    const store = new GameHistoryStore({
        filePath,
        supabaseUrl: "https://example.supabase.co",
        supabaseKey: "secret",
        logger: { warn() {} }
    });
    await store.initialize();
    assert.equal(store.remoteBackend, "config-row");

    historyTableAvailable = true;
    await store.append({ gameId: "0000008", roomCode: "LIVE", finishedAt: 8, participants: [] });

    assert.equal(store.remoteBackend, "history-table");
    assert.ok(requests.some((request) => request.options.method === "POST" && request.url.includes("bunker_game_history")));
});
