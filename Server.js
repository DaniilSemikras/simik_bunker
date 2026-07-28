const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "200kb" }));
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
const DISASTERS = [
    "После серии солнечных вспышек поверхность непригодна для жизни ещё 12 месяцев.",
    "Неизвестный вирус охватил планету. В бункере есть запас воздуха на год.",
    "Ядерная зима продлится 18 месяцев, а связи снаружи нет.",
    "Метеорит разрушил города. Выходить на поверхность безопасно только через год.",
    "Токсичный туман накрыл континент, а еды в бункере хватит на 14 месяцев."
];
const CONFIG_PATH = path.join(__dirname, "data", "game-config.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "simik";
const adminSessions = new Map();
const DEFAULT_GAME_CONFIG = {
    categories: TRAIT_ORDER.map((id) => ({ id, name: CATEGORY_NAMES[id], values: TRAITS[id] })),
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

function normalizeGameConfig(rawConfig) {
    const rawCategories = Array.isArray(rawConfig?.categories) ? rawConfig.categories : DEFAULT_GAME_CONFIG.categories;
    const usedIds = new Set();
    const categories = rawCategories.map((category) => {
        const id = cleanCategoryId(category?.id);
        const name = cleanText(category?.name, 40);
        const values = Array.isArray(category?.values)
            ? category.values.map((value) => cleanText(value, 120)).filter(Boolean).slice(0, 40)
            : [];
        if (!id || !name || !values.length || usedIds.has(id)) return null;
        usedIds.add(id);
        return { id, name, values };
    }).filter(Boolean).slice(0, 12);

    const profession = categories.find((category) => category.id === "profession");
    const otherCategories = categories.filter((category) => category.id !== "profession");
    if (!profession) {
        otherCategories.unshift(clone(DEFAULT_GAME_CONFIG.categories.find((category) => category.id === "profession")));
    } else {
        otherCategories.unshift(profession);
    }
    if (otherCategories.length < 2) {
        throw new Error("Нужно минимум две категории, включая профессию.");
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

function assignCards(players, categories) {
    const traitOrder = categories.map((category) => category.id);
    const decks = Object.fromEntries(categories.map((category) => [category.id, [...category.values].sort(() => Math.random() - 0.5)]));
    return Object.fromEntries(players.map((player, index) => [
        player.id,
        Object.fromEntries(traitOrder.map((trait) => [trait, decks[trait][index % decks[trait].length]]))
    ]));
}

function roomFor(socket) {
    return Object.values(rooms).find((room) => room.players.some((player) => player.id === socket.id && !player.left));
}

function activePlayers(room) {
    return room.players.filter((player) => !player.left && !room.eliminated.includes(player.id));
}

const ACTION_DURATION_MS = 60_000;

function currentTurnPlayerId(room) {
    return room.turnOrder?.[room.turnIndex] || null;
}

function scoreRevealedCard(trait, value) {
    const text = String(value).toLocaleLowerCase("ru");
    if (trait === "gender" || trait === "parents") return 0;
    if (trait === "age") {
        const age = Number.parseInt(text, 10);
        if (age < 20) return -1;
        if (age > 60) return -2;
        return 1;
    }

    const positive = ["врач", "инженер", "фермер", "повар", "военн", "биолог", "механик", "ветеринар", "здоров", "иммунитет", "идеальн", "атлет", "крепк", "вынослив", "аптечк", "инструмент", "семен", "батаре", "рация", "фильтр", "генератор", "консерв", "первая помощь", "почин", "замки", "химии", "грибы", "радиосвяз"];
    const negative = ["астма", "бессон", "диабет", "мигрень", "перелом", "паничес", "близорук", "быстро устаю", "травм", "плохая координац"];
    let score = positive.some((word) => text.includes(word)) ? 2 : 0;
    if (negative.some((word) => text.includes(word))) score -= 2;
    return score;
}

function calculateBunkerSurvivalChance(room) {
    const players = activePlayers(room);
    if (!players.length || !room.capacity) return null;
    const totalScore = players.reduce((sum, player) => sum + Object.entries(room.revealed[player.id] || {}).reduce((playerScore, [trait, value]) => playerScore + scoreRevealedCard(trait, value), 0), 0);
    const revealedCards = players.reduce((sum, player) => sum + Object.keys(room.revealed[player.id] || {}).length, 0);
    const maxRevealedCards = players.length * Math.max(1, room.traitOrder.length);
    const averageScore = totalScore / players.length;
    const informationBonus = (revealedCards / maxRevealedCards) * 6;
    return Math.max(20, Math.min(95, Math.round(55 + averageScore * 7 + informationBonus)));
}

function publicState(room) {
    const currentTrait = room.round === 0 ? room.traitOrder?.[0] || null : null;
    return {
        code: room.code,
        hostId: room.host,
        phase: room.phase,
        disaster: room.disaster,
        round: room.round + 1,
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
        bunkerSurvivalChance: calculateBunkerSurvivalChance(room),
        players: room.players.map((player) => ({
            id: player.id,
            nickname: player.nickname,
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
    if (room.round >= room.traitOrder.length - 1) {
        io.to(room.code).emit("allCardsRevealed");
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
    player.left = true;
    room.eliminated = room.eliminated.filter((id) => id !== playerId);
    delete room.revealedThisRound[playerId];
    delete room.votes[playerId];
    for (const voterId of Object.keys(room.votes)) {
        if (room.votes[voterId] === playerId) delete room.votes[voterId];
    }
}

io.on("connection", (socket) => {
    socket.on("createRoom", (rawNickname) => {
        const nickname = cleanNickname(rawNickname);
        if (!nickname) return emitError(socket, "Введите никнейм.");
        if (roomFor(socket)) return emitError(socket, "Вы уже состоите в комнате.");

        const code = generateCode();
        rooms[code] = {
            code,
            host: socket.id,
            players: [{ id: socket.id, nickname, left: false }],
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
        socket.emit("roomEntered", { code });
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
        room.players.push({ id: socket.id, nickname, left: false });
        socket.join(code);
        socket.emit("roomEntered", { code });
        emitRoom(room);
    });

    socket.on("startGame", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Начать игру может только ведущий.");
        if (room.phase !== "lobby") return;
        if (activePlayers(room).length < 2) return emitError(socket, "Нужно хотя бы два игрока.");
        room.phase = "reveal";
        room.capacity = Math.ceil(activePlayers(room).length / 2);
        room.traitOrder = gameConfig.categories.map((category) => category.id);
        room.categoryNames = Object.fromEntries(gameConfig.categories.map((category) => [category.id, category.name]));
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
        markPlayerLeft(room, socket.id);
        continueAfterLeave(room, socket.id);
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log(`Bunker started on http://localhost:${process.env.PORT || 3000}`);
    if (!process.env.ADMIN_PASSWORD) {
        console.warn("Админка использует временный пароль simik. Перед публикацией задайте ADMIN_PASSWORD.");
    }
});
