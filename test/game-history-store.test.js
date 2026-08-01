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
