"use strict";

const DEFAULT_MAX_HEALTH_STAGE = 5;

function clampInteger(value, minimum, maximum) {
    const numeric = Math.trunc(Number(value));
    if (!Number.isFinite(numeric)) return minimum;
    return Math.min(maximum, Math.max(minimum, numeric));
}

function isFullyHealthyText(value) {
    return /(полностью здоров|сильн(?:ый|ая) иммунитет|идеальн(?:ое|ый) зрение|здоров без ограничений)/i.test(String(value || ""));
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
    const stage = terminal
        ? effectiveMaxStage
        : isFullyHealthyText(text)
            ? 0
            : stageMatch
                ? clampInteger(stageMatch[1], 0, effectiveMaxStage)
                : text
                    ? 1
                    : 0;
    return {
        diseaseName: stage === 0 ? "" : diseaseName || "Заболевание",
        stage,
        maxStage: effectiveMaxStage,
        status: terminal ? "Смертельно болен" : stage === 0 ? "Полностью здоров" : "Болен",
        terminal
    };
}

function normalizeHealthState(rawState, fallbackValue = "") {
    if (!rawState || typeof rawState !== "object") return parseHealthState(fallbackValue);
    const maxStage = clampInteger(rawState.maxStage, 1, 20) || DEFAULT_MAX_HEALTH_STAGE;
    const terminal = Boolean(rawState.terminal) || rawState.status === "Смертельно болен";
    const stage = terminal
        ? maxStage
        : clampInteger(rawState.stage, 0, maxStage);
    return {
        diseaseName: stage === 0 ? "" : String(rawState.diseaseName || parseHealthState(fallbackValue, maxStage).diseaseName || "Заболевание").trim(),
        stage,
        maxStage,
        status: terminal ? "Смертельно болен" : stage === 0 ? "Полностью здоров" : "Болен",
        terminal
    };
}

function formatHealthState(rawState) {
    const state = normalizeHealthState(rawState);
    if (state.terminal) return "Смертельно болен";
    if (state.stage <= 0) return "Полностью здоров";
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
            diseaseName: nextStage === 0 ? "" : state.diseaseName || "Заболевание"
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
            diseaseName: nextStage === 0 ? "" : state.diseaseName || "Заболевание"
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

function hasRevealedProfession(revealed, professionTrait = "profession") {
    return Boolean(revealed && Object.prototype.hasOwnProperty.call(revealed, professionTrait));
}

module.exports = {
    DEFAULT_MAX_HEALTH_STAGE,
    appendBackpackItem,
    applyHealthStageChange,
    formatHealthState,
    getEliminationsPerRound,
    hasRevealedProfession,
    selectRematchPlayers,
    normalizeHealthState,
    parseHealthState
};
