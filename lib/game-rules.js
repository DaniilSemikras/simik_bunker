"use strict";

const DEFAULT_MAX_HEALTH_STAGE = 5;
const PROFESSION_RANK_IMPACTS = {
    "вафля": -8,
    "новичок": -4,
    "нормис": 0,
    "продвинутый": 4,
    "силач": 7,
    "прайм": 10
};

function clampInteger(value, minimum, maximum) {
    const numeric = Math.trunc(Number(value));
    if (!Number.isFinite(numeric)) return minimum;
    return Math.min(maximum, Math.max(minimum, numeric));
}

function professionRank(value) {
    const text = String(value || "").toLocaleLowerCase("ru");
    return Object.keys(PROFESSION_RANK_IMPACTS).find((rank) => new RegExp(`(?:^|—|\\s)${rank}(?:$|\\s)`, "i").test(text)) || "нормис";
}

function professionRankImpact(value) {
    return PROFESSION_RANK_IMPACTS[professionRank(value)] || 0;
}

function isFullyHealthyText(value) {
    return /(полностью здоров|сильн(?:ый|ая) иммунитет|идеальн(?:ое|ый) зрение|здоров без ограничений)/i.test(String(value || ""));
}

function deteriorationNameForHealthyValue(value) {
    const text = String(value || "").toLocaleLowerCase("ru");
    if (/сильн(?:ый|ая) иммунитет/.test(text)) return "Ослабленный иммунитет";
    if (/идеальн(?:ое|ый) зрение/.test(text)) return "Ухудшение зрения";
    return "Заболевание";
}

function parseHealthState(value, configuredMaxStage = DEFAULT_MAX_HEALTH_STAGE) {
    const text = String(value || "").trim();
    const maxStage = clampInteger(configuredMaxStage, 1, 20) || DEFAULT_MAX_HEALTH_STAGE;
    const terminal = /смертельно болен/i.test(text);
    const stageMatch = text.match(/стади[яи]\s*(\d+)\s*(?:\/\s*(\d+))?/i);
    const parsedMaximum = stageMatch?.[2] ? clampInteger(stageMatch[2], 1, 20) : maxStage;
    const effectiveMaxStage = parsedMaximum || maxStage;
    const diseaseName = text
        .replace(/\s*[—-]\s*стади[яи]\s*\d+\s*(?:\/\s*\d+)?\s*$/i, "")
        .replace(/^смертельно болен\s*[:—-]?\s*/i, "")
        .trim();
    const healthy = isFullyHealthyText(text);
    const stage = terminal
        ? effectiveMaxStage
        : healthy
            ? 0
            : stageMatch
                ? clampInteger(stageMatch[1], 0, effectiveMaxStage)
                : text
                    ? 1
                    : 0;
    return {
        diseaseName: healthy ? deteriorationNameForHealthyValue(text) : diseaseName || "Заболевание",
        healthyLabel: healthy ? text : "",
        stage,
        maxStage: effectiveMaxStage,
        status: terminal ? "Смертельно болен" : stage === 0 ? "Полностью здоров" : "Болен",
        terminal
    };
}

function normalizeHealthState(rawState, fallbackValue = "") {
    if (!rawState || typeof rawState !== "object") return parseHealthState(fallbackValue);
    const maxStage = clampInteger(rawState.maxStage, 1, 20) || DEFAULT_MAX_HEALTH_STAGE;
    const fallbackState = parseHealthState(fallbackValue, maxStage);
    const terminal = Boolean(rawState.terminal) || rawState.status === "Смертельно болен";
    const stage = terminal
        ? maxStage
        : clampInteger(rawState.stage, 0, maxStage);
    return {
        diseaseName: String(rawState.diseaseName || fallbackState.diseaseName || "Заболевание").trim(),
        healthyLabel: String(rawState.healthyLabel || fallbackState.healthyLabel || "").trim(),
        stage,
        maxStage,
        status: terminal ? "Смертельно болен" : stage === 0 ? "Полностью здоров" : "Болен",
        terminal
    };
}

function formatHealthState(rawState) {
    const state = normalizeHealthState(rawState);
    if (state.terminal) return "Смертельно болен";
    if (state.stage <= 0) return state.healthyLabel || "Полностью здоров";
    return `${state.diseaseName || "Заболевание"} — стадия ${state.stage}/${state.maxStage}`;
}

function applyHealthStageChange(rawState, direction, amount) {
    const state = normalizeHealthState(rawState);
    const stages = clampInteger(amount, 1, 20);
    if (!stages || !["improve", "worsen"].includes(direction)) {
        throw new Error("Некорректное изменение здоровья.");
    }

    if (direction === "improve") {
        if (state.stage === 0 && !state.terminal) {
            return { state, changed: false, alreadyHealthy: true, amount: stages };
        }
        const nextStage = Math.max(0, state.stage - stages);
        const nextState = {
            ...state,
            stage: nextStage,
            terminal: false,
            status: nextStage === 0 ? "Полностью здоров" : "Болен",
            diseaseName: state.diseaseName || "Заболевание"
        };
        return { state: nextState, changed: true, alreadyHealthy: false, amount: stages };
    }

    const nextStage = state.terminal ? state.maxStage + stages : state.stage + stages;
    if (nextStage > state.maxStage) {
        return {
            state: { ...state, stage: state.maxStage, terminal: true, status: "Смертельно болен" },
            changed: !state.terminal,
            alreadyHealthy: false,
            amount: stages
        };
    }
    return {
        state: {
            ...state,
            stage: nextStage,
            terminal: false,
            status: nextStage === 0 ? "Полностью здоров" : "Болен",
            diseaseName: state.diseaseName || "Заболевание"
        },
        changed: true,
        alreadyHealthy: false,
        amount: stages
    };
}

function getEliminationsPerRound(activePlayerCount, bunkerCapacity, mode = "auto") {
    const active = Math.max(0, Math.trunc(Number(activePlayerCount) || 0));
    const capacity = Math.max(0, Math.trunc(Number(bunkerCapacity) || 0));
    const remaining = Math.max(0, active - capacity);
    if (!remaining) return 0;
    if (mode === "1") return 1;
    if (mode === "2") return Math.min(2, remaining);
    return active >= 9 && remaining >= 4 ? 2 : 1;
}

function selectRematchPlayers(players, readyPlayerIds, preserveBots = false) {
    const readyIds = new Set((readyPlayerIds || []).map(String));
    const available = Array.isArray(players) ? players.filter((player) => player && !player.left) : [];
    const readyHumans = available.filter((player) => !player.isBot && readyIds.has(String(player.id)));
    const kept = available.filter((player) => readyIds.has(String(player.id)) || preserveBots && player.isBot && readyHumans.length > 0);
    const keptIds = new Set(kept.map((player) => player.id));
    return {
        readyHumans,
        kept,
        removed: (Array.isArray(players) ? players : []).filter((player) => player && !keptIds.has(player.id))
    };
}

function appendBackpackItem(currentValue, stolenValue) {
    const current = String(currentValue || "").trim();
    const stolen = String(stolenValue || "").trim();
    if (!stolen) return current;
    if (!current || /^(?:рюкзак забран|багаж пуст)$/i.test(current)) return stolen;
    return `${current}, ${stolen}`;
}

function isWeaponItem(value) {
    return /оруж|пистолет|автомат|винтовк|ружь|дробовик/.test(String(value || "").toLocaleLowerCase("ru"));
}

function findWeaponSource({ backpackValue = "", backpackTrait = null, professionItem = "", extraBaggage = [] } = {}) {
    const stolenWeapon = (Array.isArray(extraBaggage) ? extraBaggage : []).find(isWeaponItem);
    if (stolenWeapon) return { type: "extra", item: stolenWeapon };
    if (isWeaponItem(backpackValue)) return { type: "backpack", trait: backpackTrait, item: backpackValue };
    if (isWeaponItem(professionItem)) return { type: "profession", item: professionItem };
    return null;
}

function hasRevealedProfession(revealed, professionTrait = "profession") {
    return Boolean(revealed && Object.prototype.hasOwnProperty.call(revealed, professionTrait));
}

function parseDurationDays(value) {
    const text = String(value || "").trim().toLocaleLowerCase("ru");
    if (!text) return null;
    if (/бессроч|неогранич|навсегда/.test(text)) return Infinity;
    const match = text.match(/(?:^|\s|на\s+)(\d+)?\s*(д(?:ень|ня|ней)|сут(?:ки|ок)?|недел(?:я|и|ь)?|месяц(?:а|ев)?|год(?:а|ов)?|лет)(?:\s|$|[.,)])/i);
    if (!match) return null;
    const amount = Math.max(1, Number(match[1]) || 1);
    const unit = match[2];
    if (/недел/.test(unit)) return amount * 7;
    if (/месяц/.test(unit)) return amount * 30;
    if (/год|лет/.test(unit)) return amount * 365;
    return amount;
}

function calculateSupplyCoverage(requiredDuration, supplyDuration, maximumBonus) {
    const required = parseDurationDays(requiredDuration);
    const supply = parseDurationDays(supplyDuration);
    const maxBonus = Math.max(0, Math.round(Number(maximumBonus) || 0));
    if (!required || !supply || !maxBonus) return { bonus: 0, ratio: 0, requiredDays: required, supplyDays: supply };
    const comparisonDays = required === Infinity ? 5 * 365 : required;
    const ratio = Math.max(0, Math.min(1, supply / comparisonDays));
    return { bonus: Math.round(maxBonus * ratio), ratio, requiredDays: required, supplyDays: supply };
}

function ageLabel(age) {
    const value = clampInteger(age, 18, 120);
    const lastTwo = value % 100;
    const last = value % 10;
    const suffix = lastTwo >= 11 && lastTwo <= 14 ? "лет" : last === 1 ? "год" : last >= 2 && last <= 4 ? "года" : "лет";
    return `${value} ${suffix}`;
}

function randomizeGenderAge(value, random = Math.random) {
    const gender = String(value || "")
        .replace(/\d{1,3}\s*(?:лет|год(?:а)?)/gi, "")
        .replace(/[\s,;—-]+$/g, "")
        .trim() || "Не указан";
    const roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
    const bands = [
        { start: 0, end: 0.25, minimum: 18, maximum: 34 },
        { start: 0.25, end: 0.60, minimum: 35, maximum: 54 },
        { start: 0.60, end: 0.85, minimum: 55, maximum: 74 },
        { start: 0.85, end: 0.98, minimum: 75, maximum: 89 },
        { start: 0.98, end: 1, minimum: 90, maximum: 120 }
    ];
    const band = bands.find((candidate) => roll < candidate.end) || bands[bands.length - 1];
    const position = (roll - band.start) / (band.end - band.start);
    const age = band.minimum + Math.floor(position * (band.maximum - band.minimum + 1));
    return `${gender}, ${ageLabel(age)}`;
}

module.exports = {
    DEFAULT_MAX_HEALTH_STAGE,
    appendBackpackItem,
    applyHealthStageChange,
    calculateSupplyCoverage,
    findWeaponSource,
    formatHealthState,
    getEliminationsPerRound,
    hasRevealedProfession,
    isFullyHealthyText,
    isWeaponItem,
    selectRematchPlayers,
    normalizeHealthState,
    parseDurationDays,
    parseHealthState,
    professionRank,
    professionRankImpact,
    randomizeGenderAge
};
