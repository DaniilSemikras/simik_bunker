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
app.use(express.static("public", {
    maxAge: 0,
    setHeaders(response) {
        response.setHeader("Cache-Control", "no-store, max-age=0");
    }
}));

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
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || "").trim();
const adminSessions = new Map();
const ADMIN_ROOM = "admin-editors";
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
    disasters: DISASTERS,
    bunkerTraits: [],
    hiddenAvatars: [],
    revision: 0
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
        ? rawConfig.disasters.map((item) => String(item || "").trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 30)
        : [];
    if (!disasters.length) throw new Error("Добавьте хотя бы один сценарий катастрофы.");

    const usedBunkerTraitIds = new Set();
    const bunkerTraits = (Array.isArray(rawConfig?.bunkerTraits) ? rawConfig.bunkerTraits : []).map((trait) => {
        const id = cleanCategoryId(trait?.id);
        const name = cleanText(trait?.name, 40);
        const rawOptions = Array.isArray(trait?.options) ? trait.options : trait?.values;
        const options = (Array.isArray(rawOptions) ? rawOptions : []).map((option, index, source) => {
            const value = cleanText(typeof option === "string" ? option : option?.value, 120);
            if (!value) return null;
            const rawChance = typeof option === "string" ? undefined : option?.chance;
            return { value, chance: cleanChance(rawChance, defaultChance(index, source.length)) };
        }).filter(Boolean).slice(0, 40);
        if (!id || !name || !options.length || usedBunkerTraitIds.has(id)) return null;
        const chanceTotal = options.reduce((sum, option) => sum + option.chance, 0);
        if (Math.abs(chanceTotal - 100) > 0.01) {
            throw new Error("Сумма вероятностей в характеристике бункера «" + name + "» должна быть 100%. Сейчас: " + chanceTotal + "%.");
        }
        usedBunkerTraitIds.add(id);
        return { id, name, options };
    }).filter(Boolean).slice(0, 16);

    const hiddenAvatars = [...new Set(
        (Array.isArray(rawConfig?.hiddenAvatars) ? rawConfig.hiddenAvatars : [])
            .map((url) => String(url || ""))
            .filter((url) => /^\/assets\/avatars\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(url))
    )];

    const rawRevision = Number(rawConfig?.revision);
    const revision = Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0;
    return { categories: otherCategories, disasters, bunkerTraits, hiddenAvatars, revision };
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

function saveGameConfigFile(config) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function usesSupabaseConfig() {
    return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

function supabaseHeaders(extra = {}) {
    return {
        apikey: SUPABASE_SECRET_KEY,
        authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        ...extra
    };
}

async function readSupabaseConfig() {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/bunker_config?select=config&id=eq.1`, {
        headers: supabaseHeaders()
    });
    if (!response.ok) throw new Error(`Supabase вернул ${response.status}.`);
    const records = await response.json();
    return records[0]?.config || null;
}

async function writeSupabaseConfig(config) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/bunker_config?on_conflict=id`, {
        method: "POST",
        headers: supabaseHeaders({
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal"
        }),
        body: JSON.stringify({ id: 1, config, updated_at: new Date().toISOString() })
    });
    if (!response.ok) throw new Error(`Supabase вернул ${response.status}.`);
}

async function saveGameConfig(config) {
    if (usesSupabaseConfig()) await writeSupabaseConfig(config);
    saveGameConfigFile(config);
}

async function initializeGameConfig() {
    if (!usesSupabaseConfig()) return;
    try {
        const storedConfig = await readSupabaseConfig();
        if (storedConfig) {
            gameConfig = normalizeGameConfig(storedConfig);
            console.log("Настройки игры загружены из Supabase.");
        } else {
            await writeSupabaseConfig(gameConfig);
            console.log("Базовые настройки игры сохранены в Supabase.");
        }
    } catch (error) {
        console.warn("Не удалось подключить настройки Supabase, используется запасной конфиг.", error.message);
    }
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

function listAllAvatarUrls() {
    return [
        ...listAvatarDirectory(BUILT_IN_AVATAR_DIRECTORY, "/assets/avatars", isImageFilename),
        ...listAvatarDirectory(AVATAR_DIRECTORY, "/uploads/avatars", isAvatarFilename)
    ];
}

function listAvatarUrls() {
    const hidden = new Set(gameConfig?.hiddenAvatars || []);
    return listAllAvatarUrls().filter((url) => !hidden.has(url));
}

function avatarLibraryResponse() {
    return {
        avatars: listAllAvatarUrls(),
        hiddenAvatars: gameConfig.hiddenAvatars || []
    };
}

function chooseAvatar(room) {
    const avatars = listAvatarUrls();
    if (!avatars.length) return null;
    const used = new Set(room?.players.map((player) => player.avatarUrl).filter(Boolean) || []);
    const available = avatars.filter((avatar) => !used.has(avatar));
    return randomItem(available.length ? available : avatars);
}

let gameConfig = loadGameConfig();

function hasActiveAdminSession(token) {
    const expiry = adminSessions.get(token);
    if (!expiry || expiry < Date.now()) {
        adminSessions.delete(token);
        return false;
    }
    return true;
}

function broadcastAdminConfig() {
    io.to(ADMIN_ROOM).emit("admin:config-updated", { config: gameConfig });
}

function broadcastAdminAvatars() {
    io.to(ADMIN_ROOM).emit("admin:avatars-updated", avatarLibraryResponse());
}

function getAdminToken(request) {
    const authorization = request.get("authorization") || "";
    return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function requireAdmin(request, response, next) {
    if (!hasActiveAdminSession(getAdminToken(request))) {
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

app.put("/api/admin/config", requireAdmin, async (request, response) => {
    try {
        const expectedRevision = Number(request.body?.revision);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== gameConfig.revision) {
            return response.status(409).json({
                message: "Настройки уже изменил другой администратор. Обновите данные перед сохранением.",
                config: gameConfig
            });
        }
        const nextConfig = normalizeGameConfig(request.body);
        nextConfig.revision = gameConfig.revision + 1;
        await saveGameConfig(nextConfig);
        gameConfig = nextConfig;
        broadcastAdminConfig();
        response.json(gameConfig);
    } catch (error) {
        response.status(400).json({ message: error.message || "Не удалось сохранить настройки." });
    }
});

app.get("/api/admin/avatars", requireAdmin, (_request, response) => {
    response.json(avatarLibraryResponse());
});

app.post("/api/admin/avatars", requireAdmin, (request, response) => {
    try {
        const url = saveAvatarToPool(request.body?.imageData);
        if (!url) throw new Error("Выберите изображение для аватара.");
        const library = { url, ...avatarLibraryResponse() };
        broadcastAdminAvatars();
        response.status(201).json(library);
    } catch (error) {
        response.status(400).json({ message: error.message || "Не удалось загрузить аватар." });
    }
});

app.put("/api/admin/avatars/visibility", requireAdmin, async (request, response) => {
    const url = String(request.body?.url || "");
    const builtInAvatars = listAvatarDirectory(BUILT_IN_AVATAR_DIRECTORY, "/assets/avatars", isImageFilename);
    if (!builtInAvatars.includes(url)) {
        return response.status(404).json({ message: "Аватар не найден." });
    }

    try {
        const nextConfig = clone(gameConfig);
        const hidden = new Set(nextConfig.hiddenAvatars || []);
        if (request.body?.hidden) hidden.add(url);
        else hidden.delete(url);
        nextConfig.hiddenAvatars = [...hidden];
        const normalizedConfig = normalizeGameConfig(nextConfig);
        normalizedConfig.revision = gameConfig.revision + 1;
        await saveGameConfig(normalizedConfig);
        gameConfig = normalizedConfig;
        broadcastAdminConfig();
        response.json({ ...avatarLibraryResponse(), revision: gameConfig.revision });
    } catch (error) {
        response.status(400).json({ message: error.message || "Не удалось обновить набор аватаров." });
    }
});

app.delete("/api/admin/avatars/:filename", requireAdmin, (request, response) => {
    const filename = String(request.params.filename || "");
    if (!isAvatarFilename(filename)) return response.status(404).json({ message: "Аватар не найден." });
    const target = path.join(AVATAR_DIRECTORY, filename);
    if (!fs.existsSync(target)) return response.status(404).json({ message: "Аватар не найден." });
    fs.unlinkSync(target);
    const library = avatarLibraryResponse();
    broadcastAdminAvatars();
    response.json(library);
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

function pickWeightedOption(options) {
    let roll = Math.random() * 100;
    for (const option of options) {
        roll -= option.chance;
        if (roll <= 0) return option.value;
    }
    return options[options.length - 1].value;
}

function assignCards(players, categories) {
    return Object.fromEntries(players.map((player) => [
        player.id,
        Object.fromEntries(categories.map((category) => {
            const option = pickWeightedOption(category.options);
            return [category.id, category.id === "profession" ? option + " — " + randomItem(PROFESSION_RANKS) : option];
        }))
    ]));
}

function assignBunkerTraits(traits) {
    return traits.map((trait) => ({
        id: trait.id,
        name: trait.name,
        value: pickWeightedOption(trait.options)
    }));
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
const SKIP_VOTE = "__skip_vote__";

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
    const currentTrait = room.phase === "reveal" && room.round === 0 ? room.traitOrder?.[0] || null : null;
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
        bunkerTraits: room.bunkerTraits || [],
        actionSeconds: ACTION_DURATION_MS / 1000,
        turnPlayerId: currentTurnPlayerId(room),
        turnDeadline: room.turnDeadline || null,
        voteDeadline: room.voteDeadline || null,
        votedPlayerIds: Object.keys(room.votes || {}),
        voteCanBeSkipped: voteCanBeSkipped(room),
        bunkerSurvivalChance: room.phase === "finished" ? calculateBunkerSurvivalChance(room) : null,
        players: room.players.map((player) => ({
            id: player.id,
            nickname: player.nickname,
            avatarUrl: player.avatarUrl || null,
            isBot: Boolean(player.isBot),
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
    for (const timer of room.botTimers || []) clearTimeout(timer);
    room.botTimers = [];
}

function scheduleBotAction(room, callback, delay) {
    const timer = setTimeout(() => {
        room.botTimers = (room.botTimers || []).filter((item) => item !== timer);
        callback();
    }, delay);
    room.botTimers = room.botTimers || [];
    room.botTimers.push(timer);
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
    activePlayers(room).filter((player) => player.isBot).forEach((bot, index) => {
        scheduleBotAction(room, () => {
            if (room.phase !== "voting" || room.votes[bot.id]) return;
            const otherBots = activePlayers(room).filter((player) => player.isBot && player.id !== bot.id);
            room.votes[bot.id] = otherBots.length ? randomItem(otherBots).id : SKIP_VOTE;
            emitRoom(room);
            resolveVote(room);
        }, 850 + index * 500);
    });
}

function playerHasAvailableCard(room, playerId) {
    if (room.round === 0) return !room.revealed[playerId]?.[room.traitOrder[0]];
    return room.traitOrder.some((trait) => !room.revealed[playerId]?.[trait]);
}

function hasAnotherRevealRound(room) {
    return room.round < room.traitOrder.length - 1;
}

function voteCanBeSkipped(room) {
    return activePlayers(room).length <= room.capacity || hasAnotherRevealRound(room);
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
        if (room.isSoloTest) return startNextRound(room);
        openVoting(room);
        return;
    }
    room.turnDeadline = Date.now() + ACTION_DURATION_MS;
    room.voteDeadline = null;
    room.timerKind = "turn";
    room.actionTimer = setTimeout(() => advanceRevealTurn(room, true), ACTION_DURATION_MS);
    emitRoom(room);
    const currentPlayer = room.players.find((player) => player.id === currentTurnPlayerId(room));
    if (currentPlayer?.isBot) {
        scheduleBotAction(room, () => {
            if (room.phase !== "reveal" || currentTurnPlayerId(room) !== currentPlayer.id) return;
            const trait = room.round === 0
                ? room.traitOrder[0]
                : room.traitOrder.find((item) => !room.revealed[currentPlayer.id]?.[item]);
            revealTraitForPlayer(room, currentPlayer.id, trait);
        }, 800);
    }
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

function revealTraitForPlayer(room, playerId, requestedTrait) {
    if (room.phase !== "reveal" || room.eliminated.includes(playerId)) return false;
    if (currentTurnPlayerId(room) !== playerId) return false;
    const trait = room.round === 0 ? room.traitOrder[0] : requestedTrait;
    if (!room.traitOrder.includes(trait) || room.revealedThisRound[playerId] || room.revealed[playerId]?.[trait]) return false;
    room.revealed[playerId][trait] = room.cards[playerId][trait];
    room.revealedThisRound[playerId] = trait;
    emitRoom(room);
    io.to(room.code).emit("cardRevealed", {
        playerId,
        nickname: room.players.find((player) => player.id === playerId)?.nickname,
        trait
    });
    setTimeout(() => {
        if (room.phase !== "reveal" || currentTurnPlayerId(room) !== playerId || room.revealedThisRound[playerId] !== trait) return;
        advanceRevealTurn(room);
    }, 620);
    return true;
}

function startNextRound(room) {
    if (room.isSoloTest) {
        if (room.round >= room.revealRounds - 1) return endGame(room);
        room.round += 1;
        io.to(room.code).emit("roundStarted", { chooseTrait: true });
        beginRevealRound(room);
        return;
    }
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

function continueWithoutElimination(room) {
    if (activePlayers(room).length <= room.capacity) return endGame(room);
    if (room.round >= room.revealRounds - 1 && hasAnotherRevealRound(room)) {
        room.revealRounds = Math.min(room.traitOrder.length, room.revealRounds + 1);
    }
    if (hasAnotherRevealRound(room)) return startNextRound(room);
    openVoting(room);
}

function canOpenAnotherDeadlockRound(room) {
    return activePlayers(room).length > room.capacity && room.round < room.traitOrder.length - 1;
}

function continueAfterDeadlock(room) {
    if (!canOpenAnotherDeadlockRound(room)) return openVoting(room);
    if (room.round >= room.revealRounds - 1) {
        room.revealRounds = Math.min(room.traitOrder.length, room.revealRounds + 1);
    }
    startNextRound(room);
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
    const skipVotes = totals[SKIP_VOTE] || 0;
    const highestPlayerVotes = Math.max(0, ...voters.map((player) => totals[player.id] || 0));
    if (skipVotes > 0 && skipVotes >= highestPlayerVotes) {
        io.to(room.code).emit("voteSkipped", { timedOut });
        continueWithoutElimination(room);
        return;
    }
    const candidates = voters.filter((player) => totals[player.id] === highestPlayerVotes);
    if (!highestPlayerVotes || candidates.length !== 1) {
        io.to(room.code).emit("voteTied", { timedOut, nextRound: canOpenAnotherDeadlockRound(room) });
        continueAfterDeadlock(room);
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
    socket.on("admin:subscribe", (payload = {}) => {
        const token = String(payload?.token || "");
        if (!hasActiveAdminSession(token)) return socket.emit("admin:unauthorized");
        socket.join(ADMIN_ROOM);
        socket.emit("admin:ready", { revision: gameConfig.revision });
    });

    socket.on("createRoom", (rawPayload = {}) => {
        const payload = typeof rawPayload === "string" ? { nickname: rawPayload } : rawPayload || {};
        const nickname = cleanNickname(payload.nickname);
        if (!nickname) return emitError(socket, "Введите никнейм.");
        if (roomFor(socket)) return emitError(socket, "Вы уже состоите в комнате.");

        const code = generateCode();
        rooms[code] = {
            code,
            host: socket.id,
            players: [{ id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(), left: false, isBot: false }],
            phase: "lobby",
            capacity: 0,
            round: 0,
            disaster: null,
            bunkerTraits: [],
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
            timerKind: null,
            botTimers: []
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
        const player = { id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(room), left: false, isBot: false };
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

    socket.on("addTestPlayers", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Добавлять тестовых игроков может только ведущий.");
        if (room.phase !== "lobby") return;
        const slots = 12 - activePlayers(room).length;
        if (slots <= 0) return emitError(socket, "В комнате уже максимум игроков.");
        const count = Math.min(2, slots);
        let botNumber = room.players.filter((player) => player.isBot).length;
        for (let index = 0; index < count; index += 1) {
            botNumber += 1;
            room.players.push({
                id: "bot_" + crypto.randomBytes(10).toString("hex"),
                token: null,
                nickname: "Тест-бот " + botNumber,
                avatarUrl: chooseAvatar(room),
                left: false,
                isBot: true
            });
        }
        emitRoom(room);
    });

    function launchGame(room, isSoloTest = false) {
        room.isSoloTest = isSoloTest;
        room.phase = "story";
        room.capacity = isSoloTest ? 1 : Math.ceil(activePlayers(room).length / 2);
        room.traitOrder = gameConfig.categories.map((category) => category.id);
        room.revealRounds = isSoloTest
            ? room.traitOrder.length
            : revealRoundsFor(activePlayers(room).length, room.traitOrder.length);
        room.categoryNames = Object.fromEntries(gameConfig.categories.map((category) => [category.id, category.name]));
        room.cardScores = Object.fromEntries(gameConfig.categories.map((category) => [
            category.id,
            Object.fromEntries(category.options.map((option) => [option.value, option.score]))
        ]));
        room.disaster = randomItem(gameConfig.disasters);
        room.bunkerTraits = assignBunkerTraits(gameConfig.bunkerTraits || []);
        room.cards = assignCards(activePlayers(room), gameConfig.categories);
        room.revealed = Object.fromEntries(activePlayers(room).map((player) => [player.id, {}]));
        room.revealedThisRound = {};
        room.eliminated = [];
        room.votes = {};
        room.round = 0;
        io.to(room.code).emit("gameStarted");
        emitRoom(room);
    }

    socket.on("startGame", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Начать игру может только ведущий.");
        if (room.phase !== "lobby") return;
        if (activePlayers(room).length < MIN_PLAYERS_TO_START) return emitError(socket, "Нужно хотя бы три игрока.");
        launchGame(room);
    });

    socket.on("startSoloTest", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Тестовый запуск доступен только ведущему.");
        if (room.phase !== "lobby") return;
        if (activePlayers(room).length !== 1) return emitError(socket, "Для теста в соло в комнате должен остаться один игрок.");
        launchGame(room, true);
    });

    socket.on("acknowledgeStory", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Начать раунд после истории может только ведущий.");
        if (room.phase !== "story") return;
        io.to(room.code).emit("roundStarted", { initial: true });
        beginRevealRound(room);
    });

    socket.on("revealTrait", (requestedTrait) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "reveal" || room.eliminated.includes(socket.id)) return;
        if (currentTurnPlayerId(room) !== socket.id) return emitError(socket, "Сейчас ход другого игрока.");
        if (!revealTraitForPlayer(room, socket.id, requestedTrait)) {
            return emitError(socket, "Эту карту сейчас нельзя раскрыть.");
        }
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

    socket.on("skipVote", () => {
        const room = roomFor(socket);
        if (!room || room.phase !== "voting" || room.eliminated.includes(socket.id)) return;
        if (!voteCanBeSkipped(room)) return emitError(socket, "Все доступные карты уже раскрыты — нужно выбрать, кого исключить.");
        if (room.votes[socket.id]) return emitError(socket, "Ваш голос уже принят.");
        room.votes[socket.id] = SKIP_VOTE;
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

initializeGameConfig().finally(() => {
    server.listen(process.env.PORT || 3000, () => {
        console.log(`Bunker started on http://localhost:${process.env.PORT || 3000}`);
        if (!process.env.ADMIN_PASSWORD) {
            console.warn("Админка использует временный пароль simik. Перед публикацией задайте ADMIN_PASSWORD.");
        }
    });
});
