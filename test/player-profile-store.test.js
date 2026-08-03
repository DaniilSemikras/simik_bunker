"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PlayerProfileStore } = require("../lib/player-profile-store");

test("каждый аккаунт получает только один бесплатный кейс", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-profile-test-"));
    const store = new PlayerProfileStore({ filePath: path.join(directory, "profiles.json") });
    await store.initialize();
    await store.ensure({ id: "user-1", email: "one@example.com", user_metadata: { name: "Один" } });
    const first = await store.openFreeCase("user-1", 0);
    const second = await store.openFreeCase("user-1", 0.99);
    assert.equal(first.opened, true);
    assert.equal(second.opened, false);
    assert.equal(first.profile.ownedFrames.length, 2);
    assert.equal(second.profile.ownedFrames.length, 2);
});

test("можно выбрать только полученную рамку", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-profile-frame-test-"));
    const store = new PlayerProfileStore({ filePath: path.join(directory, "profiles.json") });
    await store.initialize();
    await store.ensure({ id: "user-2", email: "two@example.com" });
    await assert.rejects(() => store.selectFrame("user-2", "gold"), /ещё не получена/);
    const opened = await store.openFreeCase("user-2", 0.95);
    const selected = await store.selectFrame("user-2", opened.frame.id);
    assert.equal(selected.selectedFrame, opened.frame.id);
});
