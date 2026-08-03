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

test("за каждые пять уникальных завершённых игр начисляется кейс", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-profile-reward-test-"));
    const store = new PlayerProfileStore({ filePath: path.join(directory, "profiles.json") });
    await store.initialize();
    await store.ensure({ id: "user-3", email: "three@example.com" });
    await store.openCase("user-3", 0);
    for (let game = 1; game <= 5; game += 1) await store.recordCompletedGames(["user-3"], `game-${game}`);
    await store.recordCompletedGames(["user-3"], "game-5");
    const profile = store.get("user-3");
    assert.equal(profile.completedGames, 5);
    assert.equal(profile.caseBalance, 1);
    const opened = await store.openCase("user-3", 0.5);
    assert.equal(opened.opened, true);
    assert.equal(opened.profile.caseBalance, 0);
});

test("старый профиль без счётчика кейсов мигрирует без потери рамок", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-profile-migration-test-"));
    const filePath = path.join(directory, "profiles.json");
    fs.writeFileSync(filePath, JSON.stringify({ legacy: { userId: "legacy", ownedFrames: ["standard", "gold"], selectedFrame: "gold", freeCaseOpened: true } }));
    const store = new PlayerProfileStore({ filePath });
    await store.initialize();
    const profile = await store.ensure({ id: "legacy", email: "legacy@example.com" });
    assert.deepEqual(profile.ownedFrames, ["standard", "gold"]);
    assert.equal(profile.selectedFrame, "gold");
    assert.equal(profile.caseBalance, 0);
    assert.equal(profile.casesOpened, 1);
});

test("администратор может выдать кейс и управлять коллекцией рамок", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-profile-admin-test-"));
    const store = new PlayerProfileStore({ filePath: path.join(directory, "profiles.json") });
    await store.initialize();
    await store.ensure({ id: "admin-target", email: "target@example.com" });
    await store.adminUpdate("admin-target", { caseDelta: 2, frameId: "plasma", owned: true });
    await store.selectFrame("admin-target", "plasma");
    const updated = await store.adminUpdate("admin-target", { caseDelta: -1, frameId: "plasma", owned: false });
    assert.equal(updated.caseBalance, 2);
    assert.equal(updated.ownedFrames.includes("plasma"), false);
    assert.equal(updated.selectedFrame, "standard");
});

test("боевой сервер не принимает локальное сохранение вместо постоянной базы", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bunker-profile-required-remote-test-"));
    const store = new PlayerProfileStore({ filePath: path.join(directory, "profiles.json"), requireRemote: true });
    await store.initialize();
    await assert.rejects(
        () => store.ensure({ id: "remote-user", email: "remote@example.com" }),
        /Постоянное хранилище профилей не подключено/
    );
    assert.equal(store.status().persistent, false);
});
