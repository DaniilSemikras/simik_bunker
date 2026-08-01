"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    appendBackpackItem,
    applyHealthStageChange,
    calculateSupplyCoverage,
    findWeaponSource,
    formatHealthState,
    getEliminationsPerRound,
    hasRevealedProfession,
    parseDurationDays,
    selectRematchPlayers,
    parseHealthState
} = require("../lib/game-rules");

test("украденный предмет добавляется в багаж через запятую", () => {
    assert.equal(appendBackpackItem("Аптечка", "Оружие"), "Аптечка, Оружие");
    assert.equal(appendBackpackItem("Аптечка, Рация", "Фильтр для воды"), "Аптечка, Рация, Фильтр для воды");
    assert.equal(appendBackpackItem("Багаж пуст", "Генератор"), "Генератор");
});

test("украденное оружие сразу становится доступным действием", () => {
    assert.deepEqual(findWeaponSource({
        backpackValue: "Аптечка, Оружие",
        backpackTrait: "backpack",
        extraBaggage: ["Оружие"]
    }), { type: "extra", item: "Оружие" });
});

test("спецкарта становится доступна только после раскрытия профессии", () => {
    assert.equal(hasRevealedProfession({}, "profession"), false);
    assert.equal(hasRevealedProfession({ health: "Полностью здоров" }, "profession"), false);
    assert.equal(hasRevealedProfession({ profession: "Электрик" }, "profession"), true);
});

test("запасы оцениваются относительно срока жизни в бункере", () => {
    assert.equal(parseDurationDays("Запас питьевой воды на месяц"), 30);
    assert.equal(parseDurationDays("Изоляция: 2 недели"), 14);
    assert.equal(parseDurationDays("1 год"), 365);
    assert.equal(calculateSupplyCoverage("1 месяц", "вода на 1 месяц", 18).bonus, 18);
    assert.equal(calculateSupplyCoverage("1 месяц", "вода на 2 недели", 18).bonus, 8);
    assert.equal(calculateSupplyCoverage("1 год", "вода на 1 месяц", 18).bonus, 1);
});

test("улучшение здоровья уменьшает стадию и не уходит ниже нуля", () => {
    const initial = parseHealthState("Туберкулёз — стадия 3/5");
    assert.equal(formatHealthState(applyHealthStageChange(initial, "improve", 2).state), "Туберкулёз — стадия 1/5");
    assert.equal(formatHealthState(applyHealthStageChange(initial, "improve", 4).state), "Полностью здоров");
});

test("после полного лечения ухудшение возвращает прежний диагноз", () => {
    const initial = parseHealthState("Астма — стадия 2/5");
    const healed = applyHealthStageChange(initial, "improve", 5).state;
    assert.equal(formatHealthState(healed), "Полностью здоров");
    assert.equal(healed.diseaseName, "Астма");
    assert.equal(formatHealthState(applyHealthStageChange(healed, "worsen", 3).state), "Астма — стадия 3/5");
});

test("улучшение полностью здорового игрока не меняет состояние", () => {
    const result = applyHealthStageChange(parseHealthState("Полностью здоров"), "improve", 3);
    assert.equal(result.alreadyHealthy, true);
    assert.equal(result.changed, false);
    assert.equal(formatHealthState(result.state), "Полностью здоров");
});

test("ухудшение увеличивает стадию и превращает превышение в смертельное состояние", () => {
    const second = parseHealthState("Астма — стадия 2/5");
    assert.equal(formatHealthState(applyHealthStageChange(second, "worsen", 2).state), "Астма — стадия 4/5");
    const fourth = parseHealthState("Астма — стадия 4/5");
    assert.equal(formatHealthState(applyHealthStageChange(fourth, "worsen", 3).state), "Смертельно болен");
});

test("ухудшение здорового игрока начинается с нулевой стадии", () => {
    const result = applyHealthStageChange(parseHealthState("Полностью здоров"), "worsen", 2);
    assert.equal(formatHealthState(result.state), "Заболевание — стадия 2/5");
});

test("автоматическое исключение двух игроков включается только в большой игре", () => {
    assert.equal(getEliminationsPerRound(12, 6, "auto"), 2);
    assert.equal(getEliminationsPerRound(9, 6, "auto"), 1);
    assert.equal(getEliminationsPerRound(8, 4, "auto"), 1);
    assert.equal(getEliminationsPerRound(6, 5, "2"), 1);
    assert.equal(getEliminationsPerRound(4, 4, "auto"), 0);
});

test("ручной режим исключения не опускает число игроков ниже вместимости", () => {
    assert.equal(getEliminationsPerRound(4, 3, "2"), 1);
    assert.equal(getEliminationsPerRound(9, 4, "2"), 2);
    assert.equal(getEliminationsPerRound(4, 4, "2"), 0);
});

test("повторная игра оставляет только согласившихся людей", () => {
    const players = [
        { id: "one", isBot: false, left: false },
        { id: "two", isBot: false, left: false },
        { id: "three", isBot: false, left: false }
    ];
    const selection = selectRematchPlayers(players, ["one", "three"], false);
    assert.deepEqual(selection.kept.map((player) => player.id), ["one", "three"]);
    assert.deepEqual(selection.removed.map((player) => player.id), ["two"]);
});

test("в одиночной повторной игре боты сохраняются только при согласии человека", () => {
    const players = [
        { id: "human", isBot: false, left: false },
        { id: "bot-one", isBot: true, left: false },
        { id: "bot-two", isBot: true, left: false }
    ];
    assert.equal(selectRematchPlayers(players, ["human"], true).kept.length, 3);
    assert.equal(selectRematchPlayers(players, [], true).kept.length, 0);
});
