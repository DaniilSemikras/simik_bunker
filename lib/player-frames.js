"use strict";

const DEFAULT_FRAME_ID = "standard";

const PLAYER_FRAMES = [
    { id: DEFAULT_FRAME_ID, name: "Стандартная", rarity: "base", weight: 0 },
    { id: "copper", name: "Медный контур", rarity: "common", weight: 14 },
    { id: "emerald", name: "Изумруд", rarity: "common", weight: 12 },
    { id: "cobalt", name: "Кобальт", rarity: "common", weight: 12 },
    { id: "crimson", name: "Багровая", rarity: "common", weight: 10 },
    { id: "violet", name: "Фиолетовая", rarity: "common", weight: 10 },
    { id: "aqua", name: "Аква", rarity: "uncommon", weight: 9 },
    { id: "lime", name: "Кислотная", rarity: "uncommon", weight: 8 },
    { id: "sunset", name: "Закат", rarity: "uncommon", weight: 7 },
    { id: "ice", name: "Ледяная", rarity: "uncommon", weight: 6 },
    { id: "rose", name: "Розовый неон", rarity: "rare", weight: 4 },
    { id: "gold", name: "Золотая", rarity: "rare", weight: 3 },
    { id: "plasma", name: "Плазма", rarity: "epic", weight: 2 },
    { id: "aurora", name: "Северное сияние", rarity: "epic", weight: 1.5 },
    { id: "obsidian", name: "Обсидиан", rarity: "legendary", weight: 0.8 },
    { id: "nuclear", name: "Ядерная", rarity: "legendary", weight: 0.7 }
];

const CASE_FRAMES = PLAYER_FRAMES.filter((frame) => frame.weight > 0);

function isPlayerFrame(frameId) {
    return PLAYER_FRAMES.some((frame) => frame.id === frameId);
}

function pickCaseFrame(randomValue = Math.random()) {
    const totalWeight = CASE_FRAMES.reduce((sum, frame) => sum + frame.weight, 0);
    let cursor = Math.max(0, Math.min(0.999999999, Number(randomValue) || 0)) * totalWeight;
    for (const frame of CASE_FRAMES) {
        cursor -= frame.weight;
        if (cursor < 0) return frame;
    }
    return CASE_FRAMES[CASE_FRAMES.length - 1];
}

module.exports = { DEFAULT_FRAME_ID, PLAYER_FRAMES, CASE_FRAMES, isPlayerFrame, pickCaseFrame };
