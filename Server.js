const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 600_000 });

app.use(express.json({ limit: "600kb" }));
app.use(express.static("public"));

const rooms = Object.create(null);
const TRAITS = {
    profession: ["врач скорой помощи", "инженер-энергетик", "фермер", "повар", "психолог", "строитель", "программист", "военный", "биолог", "механик", "учитель", "ветеринар"],
    health: ["полностью здоров", "аллергия на пыль", "астма", "бессонница", "диабет под контролем", "идеальное зрение", "хроническая мигрень", "перелом руки срастается", "сильный иммунитет", "панические атаки", "донор крови", "близорукость"],
    gender: ["мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина"],
    age: ["18 лет", "21 год", "24 года", "29 лет", "34 года", "37 лет", "41 год", "45 лет", "47 лет", "52 года", "58 лет", "63 года"],
    body: ["атлетическое телосложение", "худощавое телосложение", "крепкое телосложение", "среднее телосложение", "рост 195 см", "рост 158 см", "быстро устаю", "выносливый", "после травмы колена", "гибкий", "сильные руки", "плохая координация"],
    parents: ["есть маленький ребёнок", "двое взрослых детей", "родители — фермеры", "родители живут за границей", "сирота", "ухаживаю за пожилой мамой", "есть младшая сестра", "воспитываю племянника", "родители — врачи", "единственный ребёнок в семье", "есть новорождённый сын", "семья в другом городе"],
    backpack: ["аптечка и набор лекарств", "набор инструментов", "семена овощей", "солнечная батарея", "палатка и спальник", "рация", "фильтр для воды", "запас кофе", "генератор на педалях", "дрон", "ящик консервов", "тёплая одежда"],
    specialAbility: ["умею оказывать первую помощь", "починю почти любую технику", "умею вскрывать замки", "владею жестовым языком", "нахожу воду по местности", "знаю основы химии", "умею выращивать грибы", "помню карты наизусть", "говорю на пяти языках", "вижу в темноте лучше большинства", "умею успокаивать людей", "разбираюсь в радиосвязи"]
};
const TRAIT_ORDER = Object.keys(TRAITS);
const CATEGORY_NAMES = {
    profession: "Профессия",
    health: "Здоровье",
    gender: "Пол",
    age: "Возраст",
    body: "Телосложение",
    parents: "Родители",
    backpack: "Рюкзак",
    specialAbility: "Спецвозможность"
};
const PROFESSION_RATINGS = [
    { terms: ["врач", "фельдшер", "хирург", "медик"], score: 1, role: "медик" },
    { terms: ["инженер", "механик", "электрик", "строител"], score: 0.9, role: "техник" },
    { terms: ["фермер", "агроном", "садовод"], score: 0.9, role: "продовольствие" },
    { terms: ["повар", "кулинар"], score: 0.78, role: "питание" },
    { terms: ["биолог", "химик", "учен"], score: 0.82, role: "наука" },
    { terms: ["военн", "спасател", "пожарн"], score: 0.75, role: "защита" },
    { terms: ["ветеринар"], score: 0.68, role: "медик" },
    { terms: ["психолог"], score: 0.58, role: "команда" },
    { terms: ["программист", "разработчик"], score: 0.5, role: "техник" },
    { terms: ["учител"], score: 0.42, role: "команда" }
];
const POSITIVE_SCORE_TERMS = ["здоров", "иммунитет", "идеальн", "атлет", "крепк", "вынослив", "аптечк", "инструмент", "семен", "батаре", "рация", "фильтр", "генератор", "консерв", "первая помощь", "почин", "замки", "химии", "грибы", "радиосвяз"];
const NEGATIVE_SCORE_TERMS = ["астма", "бессон", "диабет", "мигрень", "перелом", "паничес", "близорук", "быстро устаю", "травм", "плохая координац"];

function professionRating(value) {
    const text = String(value || "").toLocaleLowerCase("ru");
    return PROFESSION_RATINGS.find((rating) => rating.terms.some((term) => text.includes(term))) || { score: 0, role: null };
}

function defaultOptionScore(trait, value) {
    const text = String(value || "").toLocaleLowerCase("ru");
    if (trait === "profession") return Math.round(50 + professionRating(value).score * 45);
    if (trait === "gender" || trait === "parents") return 50;
    if (trait === "age") {
        const age = Number.parseInt(text, 10);
        if (age < 20) return 40;
        if (age > 60) return 10;
        return 75;
    }
    if (NEGATIVE_SCORE_TERMS.some((term) => text.includes(term))) return 15;
    if (POSITIVE_SCORE_TERMS.some((term) => text.includes(term))) return 85;
    return 50;
}
const DISASTERS = [
    "После серии солнечных вспышек поверхность непригодна для жизни ещё 12 месяцев.",
    "Неизвестный вирус охватил планету. В бункере есть запас воздуха на год.",
    "Ядерная зима продлится 18 месяцев, а связи снаружи нет.",
    "Метеорит разрушил города. Выходить на поверхность безопасно только через год.",
    "Токсичный туман накрыл континент, а еды в бункере хватит на 14 месяцев."
];
const CONFIG_PATH = path.join(__dirname, "data", "game-config.json");
const BUILT_IN_AVATAR_DIRECTORY = path.join(__dirname, "public", "assets", "avatars");
const AVATAR_DIRECTORY = path.join(__dirname, "public", "uploads", "avatars");
const MAX_AVATAR_BYTES = 350 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "simik";
const adminSessions = new Map();
const DEFAULT_GAME_CONFIG = {
    categories: [{
        id: "profession",
        name: CATEGORY_NAMES.profession,
        options: [
            { value: "врач скорой помощи", score: 95, chance: 20 },
            { value: "инженер-энергетик", score: 91, chance: 20 },
            { value: "фермер", score: 91, chance: 20 },
            { value: "строитель", score: 90, chance: 20 },
            { value: "механик", score: 88, chance: 20 }
        ]
    }],
    disasters: DISASTERS
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function cleanText(value, maxLength) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanCategoryId(value) {
    return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
}

function cleanScore(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.round(Math.min(100, Math.max(0, parsed)) * 10) / 10;
}

function cleanChance(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.round(Math.min(100, Math.max(0, parsed)) * 100) / 100;
}

function defaultChance(index, count) {
    if (!count) return 0;
    const base = Math.floor((100 / count) * 100) / 100;
    return index === count - 1 ? Math.round((100 - base * (count - 1)) * 100) / 100 : base;
}

function normalizeGameConfig(rawConfig) {
    const rawCategories = Array.isArray(rawConfig?.categories) ? rawConfig.categories : DEFAULT_GAME_CONFIG.categories;
    const usedIds = new Set();
    const categories = rawCategories.map((category) => {
        const id = cleanCategoryId(category?.id);
        const name = cleanText(category?.name, 40);
        const hasConfiguredOptions = Array.isArray(category?.options);
        const rawOptions = hasConfiguredOptions ? category.options : category?.values;
        const sourceOptions = hasConfiguredOptions
            ? rawOptions
            : [...new Map((Array.isArray(rawOptions) ? rawOptions : []).map((value) => [cleanText(value, 120).toLocaleLowerCase("ru"), value])).values()];
        const options = sourceOptions.map((option, index) => {
            const value = cleanText(typeof option === "string" ? option : option?.value, 120);
            if (!value) return null;
            const rawScore = typeof option === "string" ? undefined : option?.score;
            const rawChance = typeof option === "string" ? undefined : option?.chance;
            return {
                value,
                score: cleanScore(rawScore, defaultOptionScore(id, value)),
                chance: cleanChance(rawChance, defaultChance(index, sourceOptions.length))
            };
        }).filter(Boolean).slice(0, 40);
        if (!id || !name || !options.length || usedIds.has(id)) return null;
        const chanceTotal = options.reduce((sum, option) => sum + option.chance, 0);
        if (Math.abs(chanceTotal - 100) > 0.01) {
            throw new Error(`Сумма вероятностей в категории «${name}» должна быть 100%. Сейчас: ${chanceTotal}%.`);
        }
        usedIds.add(id);
        return { id, name, options };
    }).filter(Boolean).slice(0, 12);

    const profession = categories.find((category) => category.id === "profession");
    const otherCategories = categories.filter((category) => category.id !== "profession");
    if (!profession) {
        otherCategories.unshift(clone(DEFAULT_GAME_CONFIG.categories.find((category) => category.id === "profession")));
    } else {
        otherCategories.unshift(profession);
    }
    const disasters = Array.isArray(rawConfig?.disasters)
        ? rawConfig.disasters.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 30)
        : [];
    if (!disasters.length) throw new Error("Добавьте хотя бы один сценарий катастрофы.");

    return { categories: otherCategories, disasters };
}

function loadGameConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return normalizeGameConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
        }
    } catch (error) {
        console.warn("Не удалось загрузить настройки игры, используются стандартные.", error.message);
    }
    return clone(DEFAULT_GAME_CONFIG);
}

function saveGameConfig(config) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function saveAvatarToPool(dataUrl) {
    if (!dataUrl) return null;
    const match = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) throw new Error("Аватар должен быть изображением PNG, JPG или WebP.");
    const image = Buffer.from(match[2], "base64");
    if (!image.length || image.length > MAX_AVATAR_BYTES) {
        throw new Error("Аватар должен быть не больше 350 КБ.");
    }
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const filename = `${crypto.randomBytes(16).toString("hex")}.${extension}`;
    fs.mkdirSync(AVATAR_DIRECTORY, { recursive: true });
    fs.writeFileSync(path.join(AVATAR_DIRECTORY, filename), image);
    return `/uploads/avatars/${filename}`;
}

function isAvatarFilename(filename) {
    return /^[a-f0-9]{32}\.(png|jpg|webp)$/i.test(filename);
}

function isImageFilename(filename) {
    return /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(filename);
}

function listAvatarDirectory(directory, publicPath, validator) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter(validator)
        .sort()
        .map((filename) => `${publicPath}/${filename}`);
}

function listAvatarUrls() {
    return [
        ...listAvatarDirectory(BUILT_IN_AVATAR_DIRECTORY, "/assets/avatars", isImageFilename),
        ...listAvatarDirectory(AVATAR_DIRECTORY, "/uploads/avatars", isAvatarFilename)
    ];
}

function chooseAvatar(room) {
    const avatars = listAvatarUrls();
    if (!avatars.length) return null;
    const used = new Set(room?.players.map((player) => player.avatarUrl).filter(Boolean) || []);
    const available = avatars.filter((avatar) => !used.has(avatar));
    return randomItem(available.length ? available : avatars);
}

let gameConfig = loadGameConfig();

function getAdminToken(request) {
    const authorization = request.get("authorization") || "";
    return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function requireAdmin(request, response, next) {
    const expiry = adminSessions.get(getAdminToken(request));
    if (!expiry || expiry < Date.now()) {
        adminSessions.delete(getAdminToken(request));
        return response.status(401).json({ message: "Нужна авторизация администратора." });
    }
    next();
}

app.get("/admin", (_request, response) => response.sendFile(path.join(__dirname, "public", "admin.html")));

app.post("/api/admin/login", (request, response) => {
    if (String(request.body?.password || "") !== ADMIN_PASSWORD) {
        return response.status(401).json({ message: "Неверный пароль." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    response.json({ token, expiresInHours: 12, usesDefaultPassword: !process.env.ADMIN_PASSWORD });
});

app.get("/api/admin/config", requireAdmin, (_request, response) => response.json(gameConfig));

app.put("/api/admin/config", requireAdmin, (request, response) => {
    try {
        const nextConfig = normalizeGameConfig(request.body);
        saveGameConfig(nextConfig);
        gameConfig = nextConfig;
        response.json(gameConfig);
    } catch (error) {
        response.status(400).json({ message: error.message || "Не удалось сохранить настройки." });
    }
});

app.get("/api/admin/avatars", requireAdmin, (_request, response) => {
    response.json({ avatars: listAvatarUrls() });
});

app.post("/api/admin/avatars", requireAdmin, (request, response) => {
    try {
        const url = saveAvatarToPool(request.body?.imageData);
        if (!url) throw new Error("Выберите изображение для аватара.");
        response.status(201).json({ url, avatars: listAvatarUrls() });
    } catch (error) {
        response.status(400).json({ message: error.message || "Не удалось загрузить аватар." });
    }
});

app.delete("/api/admin/avatars/:filename", requireAdmin, (request, response) => {
    const filename = String(request.params.filename || "");
    if (!isAvatarFilename(filename)) return response.status(404).json({ message: "Аватар не найден." });
    const target = path.join(AVATAR_DIRECTORY, filename);
    if (!fs.existsSync(target)) return response.status(404).json({ message: "Аватар не найден." });
    fs.unlinkSync(target);
    response.json({ avatars: listAvatarUrls() });
});

function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
        code = Array.from({ length: 4 }, () => randomItem(chars)).join("");
    } while (rooms[code]);
    return code;
}

function cleanNickname(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
}

const PROFESSION_RANKS = ["новичок", "вафля", "продвинутый", "нормис", "силач", "прайм"];

function professionBase(value) {
    return String(value || "").split(" — ")[0];
}

function assignCards(players, categories) {
    const pickOption = (options) => {
        let roll = Math.random() * 100;
        for (const option of options) {
            roll -= option.chance;
            if (roll <= 0) return option.value;
        }
        return options[options.length - 1].value;
    };
    return Object.fromEntries(players.map((player) => [
        player.id,
        Object.fromEntries(categories.map((category) => {
            const option = pickOption(category.options);
            return [category.id, category.id === "profession" ? `${option} — ${randomItem(PROFESSION_RANKS)}` : option];
        }))
    ]));
}

function roomFor(socket) {
    return Object.values(rooms).find((room) => room.players.some((player) => player.id === socket.id && !player.left));
}

function activePlayers(room) {
    return room.players.filter((player) => !player.left && !room.eliminated.includes(player.id));
}

function revealRoundsFor(playerCount, categoryCount) {
    const hiddenCards = Math.min(3, Math.max(1, categoryCount - 1));
    const maximumRounds = Math.max(1, categoryCount - hiddenCards);
    return Math.min(maximumRounds, Math.max(1, 1 + Math.ceil(playerCount / 3)));
}

const ACTION_DURATION_MS = 60_000;
const RECONNECT_GRACE_MS = 60_000;
const MIN_PLAYERS_TO_START = 3;

function newPlayerToken() {
    return crypto.randomBytes(24).toString("hex");
}

function cancelPendingLeave(player) {
    if (!player?.disconnectTimer) return;
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
}

function schedulePendingLeave(room, playerId) {
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || player.left || player.disconnectTimer) return;
    player.disconnectTimer = setTimeout(() => {
        player.disconnectTimer = null;
        if (player.left || player.id !== playerId || rooms[room.code] !== room) return;
        markPlayerLeft(room, playerId);
        continueAfterLeave(room, playerId);
    }, RECONNECT_GRACE_MS);
}

function movePlayerToSocket(room, player, socketId) {
    const previousId = player.id;
    cancelPendingLeave(player);
    if (previousId === socketId) return;

    player.id = socketId;
    if (room.host === previousId) room.host = socketId;
    room.turnOrder = (room.turnOrder || []).map((id) => id === previousId ? socketId : id);
    room.eliminated = (room.eliminated || []).map((id) => id === previousId ? socketId : id);

    for (const record of [room.cards, room.revealed, room.revealedThisRound]) {
        if (!record || !Object.prototype.hasOwnProperty.call(record, previousId)) continue;
        record[socketId] = record[previousId];
        delete record[previousId];
    }

    room.votes = Object.fromEntries(Object.entries(room.votes || {}).map(([voterId, targetId]) => [
        voterId === previousId ? socketId : voterId,
        targetId === previousId ? socketId : targetId
    ]));
}

function currentTurnPlayerId(room) {
    return room.turnOrder?.[room.turnIndex] || null;
}

function scoreRevealedCard(room, trait, value) {
    const configuredScore = room.cardScores?.[trait]?.[trait === "profession" ? professionBase(value) : value];
    const score = cleanScore(configuredScore, defaultOptionScore(trait, value));
    return (score - 50) / 50;
}

function calculateBunkerSurvivalChance(room) {
    const players = activePlayers(room);
    if (!players.length || !room.capacity) return null;
    let totalScore = 0;
    let revealedCards = 0;
    for (const player of players) {
        for (const [trait, value] of Object.entries(room.revealed[player.id] || {})) {
            totalScore += scoreRevealedCard(room, trait, value);
            revealedCards += 1;
        }
    }
    const maxCards = players.length * Math.max(1, room.traitOrder.length);
    const averageScore = revealedCards ? totalScore / revealedCards : 0;
    const informationBonus = (revealedCards / maxCards) * 7;
    const professionBonus = new Set(players.map((player) => professionRating(room.revealed[player.id]?.profession).role).filter(Boolean)).size * 2;
    return Math.max(20, Math.min(95, Math.round(55 + averageScore * 31 + informationBonus + Math.min(8, professionBonus))));
}

function publicState(room) {
    const currentTrait = room.round === 0 ? room.traitOrder?.[0] || null : null;
    return {
        code: room.code,
        hostId: room.host,
        phase: room.phase,
        disaster: room.disaster,
        round: room.round + 1,
        revealRounds: room.revealRounds || Math.max(1, room.traitOrder?.length || 1),
        currentTrait,
        categoryOrder: room.traitOrder || gameConfig.categories.map((category) => category.id),
        categoryNames: room.categoryNames || Object.fromEntries(gameConfig.categories.map((category) => [category.id, category.name])),
        revealedThisRound: room.revealedThisRound || {},
        capacity: room.capacity,
        actionSeconds: ACTION_DURATION_MS / 1000,
        turnPlayerId: currentTurnPlayerId(room),
        turnDeadline: room.turnDeadline || null,
        voteDeadline: room.voteDeadline || null,
        votedPlayerIds: Object.keys(room.votes || {}),
        bunkerSurvivalChance: room.phase === "finished" ? calculateBunkerSurvivalChance(room) : null,
        players: room.players.map((player) => ({
            id: player.id,
            nickname: player.nickname,
            avatarUrl: player.avatarUrl || null,
            left: Boolean(player.left),
            eliminated: room.eliminated.includes(player.id),
            revealed: room.revealed[player.id] || {}
        }))
    };
}

function emitRoom(room) {
    io.to(room.code).emit("roomState", publicState(room));
    for (const player of room.players) {
        if (player.left) continue;
        io.to(player.id).emit("yourCards", room.cards[player.id] || {});
    }
}

function emitError(socket, message) {
    socket.emit("errorMessage", message);
}

function clearActionTimer(room) {
    if (room.actionTimer) clearTimeout(room.actionTimer);
    room.actionTimer = null;
    room.timerKind = null;
}

function endGame(room) {
    clearActionTimer(room);
    room.phase = "finished";
    room.turnDeadline = null;
    room.voteDeadline = null;
    emitRoom(room);
    io.to(room.code).emit("gameFinished", {
        survivors: activePlayers(room).map((player) => player.nickname)
    });
}

function openVoting(room) {
    if (room.phase === "finished") return;
    clearActionTimer(room);
    room.phase = "voting";
    room.votes = {};
    room.turnDeadline = null;
    room.voteDeadline = Date.now() + ACTION_DURATION_MS;
    room.timerKind = "vote";
    room.actionTimer = setTimeout(() => resolveVote(room, true), ACTION_DURATION_MS);
    io.to(room.code).emit("votingStarted");
    emitRoom(room);
}

function playerHasAvailableCard(room, playerId) {
    if (room.round === 0) return !room.revealed[playerId]?.[room.traitOrder[0]];
    return room.traitOrder.some((trait) => !room.revealed[playerId]?.[trait]);
}

function activateNextTurn(room) {
    clearActionTimer(room);
    const activeIds = new Set(activePlayers(room).map((player) => player.id));
    while (room.turnIndex < room.turnOrder.length) {
        const playerId = currentTurnPlayerId(room);
        if (activeIds.has(playerId) && !room.revealedThisRound[playerId] && playerHasAvailableCard(room, playerId)) break;
        room.turnIndex += 1;
    }
    if (!currentTurnPlayerId(room)) {
        openVoting(room);
        return;
    }
    room.turnDeadline = Date.now() + ACTION_DURATION_MS;
    room.voteDeadline = null;
    room.timerKind = "turn";
    room.actionTimer = setTimeout(() => advanceRevealTurn(room, true), ACTION_DURATION_MS);
    emitRoom(room);
}

function beginRevealRound(room) {
    clearActionTimer(room);
    room.phase = "reveal";
    room.votes = {};
    room.voteDeadline = null;
    room.revealedThisRound = {};
    room.turnOrder = activePlayers(room).map((player) => player.id);
    room.turnIndex = 0;
    activateNextTurn(room);
}

function advanceRevealTurn(room, timedOut = false) {
    const playerId = currentTurnPlayerId(room);
    if (timedOut && playerId) {
        const player = room.players.find((candidate) => candidate.id === playerId);
        if (player) io.to(room.code).emit("turnSkipped", { nickname: player.nickname });
    }
    room.turnIndex += 1;
    activateNextTurn(room);
}

function startNextRound(room) {
    if (activePlayers(room).length <= room.capacity) return endGame(room);
    if (room.round >= room.revealRounds - 1) {
        io.to(room.code).emit("revealLimitReached");
        openVoting(room);
        return;
    }
    room.round += 1;
    io.to(room.code).emit("roundStarted", { chooseTrait: true });
    beginRevealRound(room);
}

function resolveVote(room, timedOut = false) {
    const voters = activePlayers(room);
    if (!timedOut && !voters.every((player) => room.votes[player.id])) return;
    clearActionTimer(room);
    room.voteDeadline = null;

    const totals = {};
    Object.values(room.votes).forEach((targetId) => {
        totals[targetId] = (totals[targetId] || 0) + 1;
    });
    const highest = Math.max(0, ...Object.values(totals));
    const candidates = voters.filter((player) => totals[player.id] === highest);
    if (!highest || candidates.length !== 1) {
        io.to(room.code).emit("voteTied", { timedOut });
        startNextRound(room);
        return;
    }

    const eliminatedId = candidates[0].id;
    const eliminatedPlayer = room.players.find((player) => player.id === eliminatedId);

    room.eliminated.push(eliminatedId);
    io.to(room.code).emit("playerEliminated", { nickname: eliminatedPlayer.nickname });
    startNextRound(room);
}

function continueAfterLeave(room, leavingId) {
    if (activePlayers(room).length === 0) {
        clearActionTimer(room);
        delete rooms[room.code];
        return;
    }
    if (!room.players.some((player) => player.id === room.host && !player.left)) room.host = activePlayers(room)[0].id;
    if (room.phase === "voting") {
        resolveVote(room);
        if (room.phase === "voting") emitRoom(room);
        return;
    }
    if (room.phase === "reveal") {
        const leavingTurnIndex = room.turnOrder.indexOf(leavingId);
        if (leavingTurnIndex >= 0 && leavingTurnIndex < room.turnIndex) room.turnIndex -= 1;
        room.turnOrder = room.turnOrder.filter((id) => id !== leavingId);
        activateNextTurn(room);
        return;
    }
    emitRoom(room);
}

function markPlayerLeft(room, playerId) {
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || player.left) return;
    cancelPendingLeave(player);
    player.left = true;
    room.eliminated = room.eliminated.filter((id) => id !== playerId);
    delete room.revealedThisRound[playerId];
    delete room.votes[playerId];
    for (const voterId of Object.keys(room.votes)) {
        if (room.votes[voterId] === playerId) delete room.votes[voterId];
    }
}

io.on("connection", (socket) => {
    socket.on("createRoom", (rawPayload = {}) => {
        const payload = typeof rawPayload === "string" ? { nickname: rawPayload } : rawPayload || {};
        const nickname = cleanNickname(payload.nickname);
        if (!nickname) return emitError(socket, "Введите никнейм.");
        if (roomFor(socket)) return emitError(socket, "Вы уже состоите в комнате.");

        const code = generateCode();
        rooms[code] = {
            code,
            host: socket.id,
            players: [{ id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(), left: false }],
            phase: "lobby",
            capacity: 0,
            round: 0,
            disaster: null,
            cards: {},
            revealed: {},
            revealedThisRound: {},
            traitOrder: [],
            categoryNames: {},
            eliminated: [],
            votes: {},
            turnOrder: [],
            turnIndex: 0,
            turnDeadline: null,
            voteDeadline: null,
            actionTimer: null,
            timerKind: null
        };
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: rooms[code].players[0].token });
        emitRoom(rooms[code]);
    });

    socket.on("joinRoom", ({ roomCode, nickname: rawNickname } = {}) => {
        const code = String(roomCode || "").trim().toUpperCase();
        const nickname = cleanNickname(rawNickname);
        const room = rooms[code];
        if (!nickname) return emitError(socket, "Введите никнейм.");
        if (!room) return emitError(socket, "Комната не найдена.");
        if (room.phase !== "lobby") return emitError(socket, "Игра уже началась.");
        if (activePlayers(room).length >= 12) return emitError(socket, "В комнате уже 12 игроков.");
        if (roomFor(socket)) return emitError(socket, "Вы уже состоите в комнате.");
        if (room.players.some((player) => !player.left && player.nickname.toLocaleLowerCase("ru") === nickname.toLocaleLowerCase("ru"))) {
            return emitError(socket, "Такой никнейм уже занят.");
        }
        const player = { id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(room), left: false };
        room.players.push(player);
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: player.token });
        emitRoom(room);
    });

    socket.on("resumeRoom", ({ roomCode, playerToken } = {}) => {
        const code = String(roomCode || "").trim().toUpperCase();
        const room = rooms[code];
        const token = String(playerToken || "");
        const player = room?.players.find((candidate) => !candidate.left && candidate.token === token);
        if (!room || !player) return socket.emit("resumeFailed");

        movePlayerToSocket(room, player, socket.id);
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: player.token });
        emitRoom(room);
    });

    socket.on("startGame", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Начать игру может только ведущий.");
        if (room.phase !== "lobby") return;
        if (activePlayers(room).length < MIN_PLAYERS_TO_START) return emitError(socket, "Нужно хотя бы три игрока.");
        room.phase = "reveal";
        room.capacity = Math.ceil(activePlayers(room).length / 2);
        room.traitOrder = gameConfig.categories.map((category) => category.id);
        room.revealRounds = revealRoundsFor(activePlayers(room).length, room.traitOrder.length);
        room.categoryNames = Object.fromEntries(gameConfig.categories.map((category) => [category.id, category.name]));
        room.cardScores = Object.fromEntries(gameConfig.categories.map((category) => [
            category.id,
            Object.fromEntries(category.options.map((option) => [option.value, option.score]))
        ]));
        room.disaster = randomItem(gameConfig.disasters);
        room.cards = assignCards(activePlayers(room), gameConfig.categories);
        room.revealed = Object.fromEntries(activePlayers(room).map((player) => [player.id, {}]));
        room.revealedThisRound = {};
        room.eliminated = [];
        room.votes = {};
        room.round = 0;
        io.to(room.code).emit("gameStarted");
        beginRevealRound(room);
    });

    socket.on("revealTrait", (requestedTrait) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "reveal" || room.eliminated.includes(socket.id)) return;
        if (currentTurnPlayerId(room) !== socket.id) return emitError(socket, "Сейчас ход другого игрока.");
        const trait = room.round === 0 ? room.traitOrder[0] : requestedTrait;
        if (!room.traitOrder.includes(trait)) return;
        if (room.revealedThisRound[socket.id]) return;
        if (room.revealed[socket.id][trait]) return emitError(socket, "Эта карта уже раскрыта.");
        room.revealed[socket.id][trait] = room.cards[socket.id][trait];
        room.revealedThisRound[socket.id] = trait;
        advanceRevealTurn(room);
    });

    socket.on("castVote", (targetId) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "voting" || room.eliminated.includes(socket.id)) return;
        if (!activePlayers(room).some((player) => player.id === targetId)) return emitError(socket, "Выберите игрока, который ещё в игре.");
        if (targetId === socket.id) return emitError(socket, "Нельзя голосовать за себя.");
        if (room.votes[socket.id]) return emitError(socket, "Ваш голос уже принят.");
        room.votes[socket.id] = targetId;
        socket.emit("voteAccepted");
        emitRoom(room);
        resolveVote(room);
    });

    socket.on("leaveRoom", () => {
        const room = roomFor(socket);
        if (!room) return socket.emit("leftRoom");
        socket.leave(room.code);
        markPlayerLeft(room, socket.id);
        continueAfterLeave(room, socket.id);
        socket.emit("leftRoom");
    });

    socket.on("disconnect", () => {
        const room = roomFor(socket);
        if (!room) return;
        schedulePendingLeave(room, socket.id);
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`Bunker started on http://localhost:${process.env.PORT || 3000}`);
    if (!process.env.ADMIN_PASSWORD) {
        console.warn("Админка использует временный пароль simik. Перед публикацией задайте ADMIN_PASSWORD.");
    }
});
