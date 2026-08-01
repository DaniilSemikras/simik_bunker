"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    applyHealthStageChange,
    formatHealthState,
    getEliminationsPerRound,
    parseHealthState
} = require("../lib/game-rules");

test("улучшение здоровья уменьшает стадию и не уходит ниже нуля", () => {
    const initial = parseHealthState("Туберкулёз — стадия 3/5");
    assert.equal(formatHealthState(applyHealthStageChange(initial, "improve", 2).state), "Туберкулёз — стадия 1/5");
    assert.equal(formatHealthState(applyHealthStageChange(initial, "improve", 4).state), "Полностью здоров");
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
