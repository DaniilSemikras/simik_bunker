const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const {
    applyHealthStageChange,
    formatHealthState,
    getEliminationsPerRound,
    normalizeHealthState,
    parseHealthState,
    selectRematchPlayers
} = require("./lib/game-rules");
const { GameHistoryStore } = require("./lib/game-history-store");

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
let nextGameId = 0;
const TRAITS = {
    profession: ["врач скорой помощи", "инженер-энергетик", "фермер", "повар", "психолог", "строитель", "программист", "военный", "биолог", "механик", "учитель", "ветеринар"],
    health: ["полностью здоров", "аллергия на пыль", "астма", "бессонница", "диабет под контролем", "идеальное зрение", "хроническая мигрень", "перелом руки срастается", "сильный иммунитет", "панические атаки", "донор крови", "близорукость"],
    gender: ["мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина", "мужчина", "женщина"],
    age: ["18 лет", "21 год", "24 года", "29 лет", "34 года", "37 лет", "41 год", "45 лет", "47 лет", "52 года", "58 лет", "63 года"],
    body: ["атлетическое телосложение", "худощавое телосложение", "крепкое телосложение", "среднее телосложение", "рост 195 см", "рост 158 см", "быстро устаю", "выносливый", "после травмы колена", "гибкий", "сильные руки", "плохая координация"],
    parents: ["есть маленький ребёнок", "двое взрослых детей", "родители — фермеры", "родители живут за границей", "сирота", "ухаживаю за пожилой мамой", "есть младшая сестра", "воспитываю племянника", "родители — врачи", "единственный ребёнок в семье", "есть новорождённый сын", "семья в другом городе"],
    backpack: ["аптечка и набор лекарств", "набор инструментов", "семена овощей", "солнечная батарея", "палатка и спальник", "рация", "фильтр для воды", "запас кофе", "генератор на педалях", "дрон", "ящик консервов", "тёплая одежда", "оружие"],
    specialAbility: ["умею оказывать первую помощь", "починю почти любую технику", "умею вскрывать замки", "владею жестовым языком", "нахожу воду по местности", "знаю основы химии", "умею выращивать грибы", "помню карты наизусть", "говорю на пяти языках", "вижу в темноте лучше большинства", "умею успокаивать людей", "разбираюсь в радиосвязи"]
};
const TRAIT_ORDER = Object.keys(TRAITS);
const CATEGORY_NAMES = {
    profession: "Профессия",
    health: "Здоровье",
    gender_age: "Пол и возраст",
    gender: "Пол",
    age: "Возраст",
    body: "Телосложение",
    character: "Характер",
    family: "Семья",
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

function includesAny(text, terms) {
    return terms.some((term) => text.includes(term));
}

function professionBunkerFit(room, professionValue) {
    const profession = professionBase(professionValue).toLocaleLowerCase("ru");
    const bunkerTraits = room?.bunkerTraits || [];
    const traitText = (terms) => bunkerTraits
        .filter((trait) => includesAny(`${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru"), terms))
        .map((trait) => String(trait?.value || "").toLocaleLowerCase("ru"))
        .join(" ");
    const technical = includesAny(profession, ["электрик", "энергетик", "инженер", "электрон", "механик", "строител", "программист"]);
    const electrician = includesAny(profession, ["электрик", "энергетик", "электрон"]);
    const builder = includesAny(profession, ["инженер", "механик", "строител"]);
    const scientist = includesAny(profession, ["биолог", "химик", "учен", "лаборант", "врач", "медик", "фармацевт"]);
    const farmer = includesAny(profession, ["фермер", "агроном", "садовод"]);
    const foodExpert = includesAny(profession, ["фермер", "агроном", "садовод", "повар", "кулинар", "биолог", "ветеринар"]);
    const waterExpert = includesAny(profession, ["инженер", "электрик", "механик", "химик", "биолог", "гидролог", "сантехник"]);
    const medic = includesAny(profession, ["врач", "медик", "фельдшер", "хирург", "медсестр", "ветеринар", "психолог"]);
    const warehouseExpert = includesAny(profession, ["логист", "кладов", "военн", "охран", "механик", "строител", "повар"]);
    const reasons = [];
    let bonus = 0;
    const addBonus = (amount, reason) => {
        if (!amount || bonus >= 45) return;
        const applied = Math.min(amount, 45 - bonus);
        bonus += applied;
        reasons.push(`${reason} +${applied}`);
    };
    const specialization = traitText(["specialization", "назначен", "специализ"]);
    if (/технич/.test(specialization) && technical) addBonus(18, "подходит техническому бункеру");
    if (/(лаборатор|научн)/.test(specialization) && scientist) addBonus(18, "полезна для лаборатории");
    if (/ферм/.test(specialization) && foodExpert) addBonus(18, "полезна для фермы");
    if (/медицин/.test(specialization) && medic) addBonus(18, "полезна для медблока");
    if (/(склад|снабжен)/.test(specialization) && warehouseExpert) addBonus(18, "полезна для склада снабжения");

    const electricity = traitText(["electricity", "электр"]);
    if (/(поврежден|слом|нужен электрик|аварийн)/.test(electricity)) {
        if (electrician) addBonus(30, "может восстановить электрику");
        else if (technical) addBonus(14, "поможет с ремонтом электрики");
    }
    const ventilation = traitText(["ventilation", "вентиляц"]);
    if (/(слом|исход|нужен ремонт|аварийн)/.test(ventilation)) {
        if (technical) addBonus(24, "может наладить вентиляцию");
        else if (scientist) addBonus(10, "разберётся с фильтрацией воздуха");
    }
    const condition = traitText(["condition", "состояни"]);
    if (/(критическ|поврежден|срочн.*ремонт|ремонт)/.test(condition) && builder) {
        addBonus(22, "нужна для ремонта бункера");
    }
    const food = traitText(["food", "еда", "питани"]);
    if (/(еды нет|3 дня|недел)/.test(food)) {
        if (farmer) addBonus(24, "поможет наладить запасы еды");
        else if (foodExpert) addBonus(14, "поможет с питанием");
    }
    const water = traitText(["water", "вод"]);
    if (/(воды нет|3 дня|недел)/.test(water) && waterExpert) {
        addBonus(12, "поможет с очисткой и поиском воды");
    }
    const residents = traitText(["resident", "жител", "обитател"]);
    if (/(агресс|конфликт|опасн|мар[оа]дер)/.test(residents) && includesAny(profession, ["военн", "спасател", "пожарн", "охран", "полиц"])) {
        addBonus(16, "сможет обеспечить безопасность при опасных жителях");
    }
    return { bonus, reasons };
}

function professionItemBunkerFit(room, professionValue, itemValue) {
    const item = String(itemValue || "").toLocaleLowerCase("ru");
    if (!item) return { bonus: 0, reasons: [] };
    const bunker = (room?.bunkerTraits || []).map((trait) => `${trait?.id || ""} ${trait?.name || ""} ${trait?.value || ""}`).join(" ").toLocaleLowerCase("ru");
    const disaster = String(room?.disaster || "").toLocaleLowerCase("ru");
    const profession = professionBase(professionValue).toLocaleLowerCase("ru");
    const reasons = [];
    let bonus = 0;
    const addBonus = (amount, reason) => {
        if (!amount || bonus >= 28) return;
        const applied = Math.min(amount, 28 - bonus);
        bonus += applied;
        reasons.push(`${reason} +${applied}`);
    };
    const technicalFailure = /(электр|вентил|состояни).*(сломан|поврежден|аварийн|ремонт)|(?:сломан|поврежден|аварийн|ремонт).*(электр|вентил|состояни)/.test(bunker);
    const lowFood = /(еды нет|3 дня|недел|голод)/.test(bunker);
    const lowWater = /(воды нет|3 дня|недел|очистк)/.test(bunker);
    const specialization = bunker;

    if (/(мультитул|предохранител|инструмент|ремонт|кабель|креп[её]ж)/.test(item) && technicalFailure) {
        addBonus(20, "профессиональный набор ускоряет ремонт систем");
    }
    if (/(семен|выращиван|культиватор|удобрен)/.test(item) && (/ферм/.test(specialization) || lowFood)) {
        addBonus(20, "семена и инвентарь помогут наладить питание");
    }
    if (/(па[йе]к|консерв|горелк|запас еды)/.test(item) && lowFood) {
        addBonus(16, "запас продовольствия поддержит команду при нехватке еды");
    }
    if (/(аптечк|лекарств|медицин)/.test(item) && (/(медицин|лаборатор)/.test(specialization) || /(вирус|эпидем|токсич|радиац)/.test(disaster))) {
        addBonus(18, "медицинский запас особенно важен в этой катастрофе");
    }
    if (/(реактив|анализ|фильтр|очистк)/.test(item) && (lowWater || /лаборатор/.test(specialization))) {
        addBonus(18, "набор пригодится для проверки и очистки воды");
    }
    if (/(рация|связ|фонар|аварийн)/.test(item) && /(военн|спасател|пожарн|связист|радист)/.test(profession)) {
        addBonus(10, "аварийный комплект усиливает роль в координации команды");
    }
    return { bonus, reasons };
}

function defaultOptionScore(trait, value) {
    const text = String(value || "").toLocaleLowerCase("ru");
    if (trait === "profession") return Math.round(50 + professionRating(value).score * 45);
    if (trait === "gender" || trait === "parents" || trait === "character" || trait === "family") return 50;
    if (trait === "age" || trait === "gender_age") {
        const age = Number((text.match(/\d{1,3}/) || [])[0]);
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
const GAME_HISTORY_PATH = path.join(__dirname, "data", "game-history.json");
const EMPTY_LOBBY_TTL_MS = 3 * 60 * 1000;
const BUILT_IN_AVATAR_DIRECTORY = path.join(__dirname, "public", "assets", "survivor-avatars");
const AVATAR_DIRECTORY = path.join(__dirname, "public", "uploads", "avatars");
const MAX_AVATAR_BYTES = 350 * 1024;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "simik";
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || "").trim();
const ENABLE_TEST_MODE = String(process.env.ENABLE_TEST_MODE || "").toLocaleLowerCase("en") === "true";
const gameHistoryStore = new GameHistoryStore({
    filePath: GAME_HISTORY_PATH,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SECRET_KEY
});
const adminSessions = new Map();
const ADMIN_ROOM = "admin-editors";
const BUNKER_TRAITS_SEED_VERSION = 3;
const BACKPACK_WEAPON_SEED_VERSION = 1;
const WATER_TRAIT_LABEL_SEED_VERSION = 1;
const WATER_OPTIONS_SEED_VERSION = 1;
const WATER_RANDOM_PERCENT_SEED_VERSION = 1;
const WATER_DURATION_SEED_VERSION = 1;
const BACKPACK_WATER_SEED_VERSION = 1;
const GENDER_OPTIONS_SEED_VERSION = 2;
const HEALTH_CATEGORY_SEED_VERSION = 1;
const SPECIAL_CARD_LIBRARY_SEED_VERSION = 5;
const DISASTER_DURATION_SEED_VERSION = 1;
const CONTENT_FILL_SEED_VERSION = 2;
const WEAPON_BACKPACK_OPTION = { value: "Оружие", score: 70, chance: 10 };
const WATER_BACKPACK_OPTIONS = [
    { value: "Запас питьевой воды на 3 дня", score: 72, chance: 8 },
    { value: "Канистры воды на 2 недели", score: 84, chance: 7 },
    { value: "Запас питьевой воды на месяц", score: 94, chance: 5 }
];
const DEFAULT_SUPPLY_DURATIONS = {
    water: [
        { amount: 2, unit: "day" }, { amount: 3, unit: "day" }, { amount: 7, unit: "day" },
        { amount: 14, unit: "day" }, { amount: 1, unit: "month" }, { amount: 3, unit: "month" }
    ],
    food: [
        { amount: 3, unit: "day" }, { amount: 7, unit: "day" }, { amount: 12, unit: "day" },
        { amount: 14, unit: "day" }, { amount: 1, unit: "month" }, { amount: 3, unit: "month" }
    ]
};
const DEFAULT_GENDER_AGE_CATEGORY = {
    id: "gender_age",
    name: "Пол и возраст",
    options: [
        { value: "Мужчина, 19 лет", score: 40, chance: 8.33 },
        { value: "Мужчина, 27 лет", score: 75, chance: 8.33 },
        { value: "Мужчина, 36 лет", score: 75, chance: 8.33 },
        { value: "Мужчина, 48 лет", score: 75, chance: 8.33 },
        { value: "Мужчина, 63 года", score: 10, chance: 8.33 },
        { value: "Мужчина, 76 лет", score: 10, chance: 8.33 },
        { value: "Женщина, 18 лет", score: 40, chance: 8.33 },
        { value: "Женщина, 25 лет", score: 75, chance: 8.33 },
        { value: "Женщина, 34 года", score: 75, chance: 8.33 },
        { value: "Женщина, 42 года", score: 75, chance: 8.33 },
        { value: "Женщина, 55 лет", score: 75, chance: 8.33 },
        { value: "Женщина, 68 лет", score: 10, chance: 8.37 }
    ]
};
const DEFAULT_CHARACTER_CATEGORY = {
    id: "character",
    name: "Характер",
    options: [
        { value: "Спокойный и собранный", score: 82, chance: 14 },
        { value: "Лидер, но вспыльчивый", score: 58, chance: 12 },
        { value: "Доброжелательный оптимист", score: 74, chance: 14 },
        { value: "Паникёр", score: 22, chance: 10 },
        { value: "Рациональный одиночка", score: 64, chance: 12 },
        { value: "Конфликтный, но решительный", score: 38, chance: 10 },
        { value: "Внимательный командный игрок", score: 86, chance: 14 },
        { value: "Скрытный интроверт", score: 48, chance: 14 }
    ]
};
const DEFAULT_HEALTH_CATEGORY = {
    id: "health",
    name: "Здоровье",
    options: [
        { value: "Полностью здоров", score: 95, chance: 20 },
        { value: "Сильный иммунитет", score: 90, chance: 10 },
        { value: "Аллергия на пыль", score: 55, chance: 10 },
        { value: "Астма под контролем", score: 50, chance: 10 },
        { value: "Диабет под контролем", score: 45, chance: 10 },
        { value: "Близорукость", score: 65, chance: 10 },
        { value: "Хроническая мигрень", score: 35, chance: 10 },
        { value: "Бессонница", score: 35, chance: 8 },
        { value: "Перелом руки срастается", score: 30, chance: 6 },
        { value: "Панические атаки", score: 30, chance: 6 }
    ]
};
const DEFAULT_BUNKER_TRAITS = [
    {
        id: "specialization",
        name: "Назначение бункера",
        options: [
            { value: "Обычный гражданский бункер", chance: 25 },
            { value: "Технический бункер", chance: 18 },
            { value: "Научная лаборатория", chance: 16 },
            { value: "Фермерский бункер", chance: 16 },
            { value: "Медицинский бункер", chance: 13 },
            { value: "Склад снабжения", chance: 12 }
        ]
    },
    {
        id: "water",
        name: "Наличие воды",
        options: [
            { value: "Воды нет", chance: 15 },
            { value: "Запас воды на 3 дня", chance: 35 },
            { value: "Запас воды на месяц", chance: 30 },
            { value: "Запас воды на год", chance: 20 }
        ]
    },
    {
        id: "food",
        name: "Еда",
        options: [
            { value: "Еды нет", chance: 15 },
            { value: "Запас еды на 3 дня", chance: 35 },
            { value: "Запас еды на месяц", chance: 30 },
            { value: "Запас еды на год", chance: 20 }
        ]
    },
    {
        id: "electricity",
        name: "Электричество",
        options: [
            { value: "Генератор работает", chance: 45 },
            { value: "Только аварийное освещение", chance: 25 },
            { value: "Проводка повреждена — нужен электрик", chance: 30 }
        ]
    },
    {
        id: "ventilation",
        name: "Вентиляция",
        options: [
            { value: "Вентиляция исправна", chance: 45 },
            { value: "Фильтры на исходе", chance: 30 },
            { value: "Вентиляция сломана — нужен ремонт", chance: 25 }
        ]
    },
    {
        id: "condition",
        name: "Состояние бункера",
        options: [
            { value: "Полностью исправен", chance: 35 },
            { value: "Нужен косметический ремонт", chance: 25 },
            { value: "Повреждены жилые модули", chance: 25 },
            { value: "Критическое состояние — нужен срочный ремонт", chance: 15 }
        ]
    },
    {
        id: "previous_residents",
        name: "Предыдущие жители",
        options: [
            { value: "Бункер пуст", chance: 55, occupiedSlots: 0 },
            { value: "Внутри живёт бездомный", chance: 30, occupiedSlots: 1 },
            { value: "Внутри живут двое прежних жильцов", chance: 15, occupiedSlots: 2 }
        ]
    }
];
const DEFAULT_BACKPACK_CATEGORY = {
    id: "backpack",
    name: "Багаж",
    options: [
        WEAPON_BACKPACK_OPTION,
        { value: "Аптечка и набор лекарств", score: 85, chance: 14 },
        { value: "Набор инструментов", score: 85, chance: 12 },
        { value: "Фильтр для воды", score: 85, chance: 10 },
        { value: "Солнечная батарея", score: 85, chance: 10 },
        { value: "Рация", score: 85, chance: 8 },
        { value: "Ящик консервов", score: 85, chance: 16 },
        ...WATER_BACKPACK_OPTIONS
    ]
};
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
    }, DEFAULT_HEALTH_CATEGORY, DEFAULT_GENDER_AGE_CATEGORY, DEFAULT_CHARACTER_CATEGORY],
    disasters: DISASTERS,
    bunkerTraits: DEFAULT_BUNKER_TRAITS,
    bunkerTraitsSeedVersion: BUNKER_TRAITS_SEED_VERSION,
    backpackWeaponSeedVersion: BACKPACK_WEAPON_SEED_VERSION,
    waterTraitLabelSeedVersion: WATER_TRAIT_LABEL_SEED_VERSION,
    waterOptionsSeedVersion: WATER_OPTIONS_SEED_VERSION,
    waterRandomPercentSeedVersion: WATER_RANDOM_PERCENT_SEED_VERSION,
    waterDurationSeedVersion: WATER_DURATION_SEED_VERSION,
    backpackWaterSeedVersion: BACKPACK_WATER_SEED_VERSION,
    genderOptionsSeedVersion: GENDER_OPTIONS_SEED_VERSION,
    healthCategorySeedVersion: HEALTH_CATEGORY_SEED_VERSION,
    specialCardLibrarySeedVersion: SPECIAL_CARD_LIBRARY_SEED_VERSION,
    disasterDurationSeedVersion: DISASTER_DURATION_SEED_VERSION,
    contentFillSeedVersion: CONTENT_FILL_SEED_VERSION,
    specialCards: [
        {
            id: "swap_random_trait",
            name: "Обмен случайной характеристикой",
            description: "В начале игры карта выбирает характеристику. Один раз обменяйтесь ею с выбранным игроком.",
            effect: "swap_random_trait"
        },
        {
            id: "swap_adjacent_profession",
            name: "Соседский обмен профессией",
            description: "При выдаче карта случайно получает вариант: обмен с соседом слева, справа или со случайным соседом.",
            effect: "swap_adjacent_profession"
        },
        {
            id: "take_backpack",
            name: "Украсть предмет из багажа",
            description: "Один раз украдите предмет из багажа выбранного игрока. У вас он появится в той же карточке багажа, а у цели останется пусто.",
            effect: "take_backpack"
        },
        {
            id: "increase_capacity",
            name: "Расширить бункер",
            description: "Один раз добавьте одно место в бункере.",
            effect: "increase_capacity"
        },
        {
            id: "decrease_capacity",
            name: "Сократить бункер",
            description: "Один раз уберите одно место в бункере.",
            effect: "decrease_capacity"
        },
        {
            id: "random_capacity",
            name: "Изменить размер бункера",
            description: "Один раз случайно добавьте или уберите одно место в бункере.",
            effect: "random_capacity"
        },
        {
            id: "reroll_own_trait",
            name: "Переролл характеристики",
            description: "Один раз случайно измените одну свою характеристику.",
            effect: "reroll_own_trait"
        },
        {
            id: "improve_health",
            name: "Медицинский прорыв",
            description: "Выберите игрока: его заболевание улучшится на случайное количество стадий.",
            effect: "improve_health"
        },
        {
            id: "worsen_health",
            name: "Биологическая диверсия",
            description: "Выберите игрока: его заболевание ухудшится на случайное количество стадий.",
            effect: "worsen_health"
        }
    ],
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

function cleanOccupiedSlots(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(12, Math.round(parsed)));
}

function defaultChance(index, count) {
    if (!count) return 0;
    const base = Math.floor((100 / count) * 100) / 100;
    return index === count - 1 ? Math.round((100 - base * (count - 1)) * 100) / 100 : base;
}

function defaultProfessionItem(value) {
    const text = String(value || "").toLocaleLowerCase("ru");
    if (/(врач|фельдшер|медик|ветеринар|хирург)/.test(text)) return "аптечка, антибиотики и перевязочный набор";
    if (/(биолог|химик|лаборант|фармацевт)/.test(text)) return "реактивы и тест-набор для воды";
    if (/(электрик|энергетик|инженер|электронщик)/.test(text)) return "мультиметр, кабель и запас предохранителей";
    if (/(сантехник|гидролог)/.test(text)) return "фильтр и набор для очистки воды";
    if (/(фермер|агроном|садовод)/.test(text)) return "семена, удобрения и ручной культиватор";
    if (/(повар|кондитер|кулинар)/.test(text)) return "сухие пайки и походная горелка";
    if (/(строител|сварщик)/.test(text)) return "ремонтный набор и крепёж";
    if (/(механик|автомеханик)/.test(text)) return "слесарный набор и запасные детали";
    if (/(военн|спасател|пожарн|охранник|полиц)/.test(text)) return "рация, фонарь и аварийный набор";
    if (/(программист|радист|связист)/.test(text)) return "рация и диагностический набор";
    if (/(психолог|учител)/.test(text)) return "набор для коммуникации с группой";
    return "";
}

function bunkerTraitMatchesDefault(trait, defaultTrait) {
    const text = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
    const aliases = {
        water: ["water", "вод", "вокд"],
        food: ["food", "еда", "пищ", "питан"],
        electricity: ["electric", "электр", "свет"],
        ventilation: ["ventilat", "вентил"],
        condition: ["condition", "состояни", "ремонт", "поврежд"],
        specialization: ["specialization", "назначен", "специализ", "техническ", "лаборатор", "ферм"],
        previous_residents: ["previous", "предыдущ", "жител", "бомж"]
    };
    return (aliases[defaultTrait.id] || [defaultTrait.id]).some((term) => text.includes(term));
}

function seedDefaultBunkerTraits(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.bunkerTraitsSeedVersion) >= BUNKER_TRAITS_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const existing = Array.isArray(source.bunkerTraits) ? source.bunkerTraits : [];
    const missing = DEFAULT_BUNKER_TRAITS.filter((defaultTrait) => !existing.some((trait) => bunkerTraitMatchesDefault(trait, defaultTrait)));
    const traits = [...existing, ...clone(missing)];
    const specializationTrait = DEFAULT_BUNKER_TRAITS.find((trait) => trait.id === "specialization");
    const specialization = traits.filter((trait) => bunkerTraitMatchesDefault(trait, specializationTrait));
    const otherTraits = traits.filter((trait) => !bunkerTraitMatchesDefault(trait, specializationTrait));
    return {
        config: {
            ...source,
            bunkerTraits: [...specialization, ...otherTraits],
            bunkerTraitsSeedVersion: BUNKER_TRAITS_SEED_VERSION
        },
        changed: true
    };
}

function seedWaterTraitLabel(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.waterTraitLabelSeedVersion) >= WATER_TRAIT_LABEL_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const bunkerTraits = (Array.isArray(source.bunkerTraits) ? source.bunkerTraits : []).map((trait) => {
        const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
        return /(^|\s)water($|\s)|вод|вокд/.test(hint)
            ? { ...trait, name: "Наличие воды" }
            : trait;
    });
    return {
        config: {
            ...source,
            bunkerTraits,
            waterTraitLabelSeedVersion: WATER_TRAIT_LABEL_SEED_VERSION
        },
        changed: true
    };
}

function seedRandomWaterOptions(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.waterOptionsSeedVersion) >= WATER_OPTIONS_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const bunkerTraits = (Array.isArray(source.bunkerTraits) ? source.bunkerTraits : []).map((trait) => {
        const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
        if (!/water|вод|вокд/.test(hint)) return trait;
        const options = Array.isArray(trait?.options) ? trait.options : trait?.values;
        const hasOnlyStub = !Array.isArray(options) || options.length < 2 || options.every((option) => {
            const value = typeof option === "string" ? option : option?.value;
            return /^\d+$/.test(String(value || "").trim()) || isPlaceholderValue(value);
        });
        return hasOnlyStub
            ? { ...trait, name: "Наличие воды", options: clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "water").options), values: undefined }
            : trait;
    });
    return {
        config: { ...source, bunkerTraits, waterOptionsSeedVersion: WATER_OPTIONS_SEED_VERSION },
        changed: true
    };
}

function seedRandomWaterPercentage(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.waterRandomPercentSeedVersion) >= WATER_RANDOM_PERCENT_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const bunkerTraits = (Array.isArray(source.bunkerTraits) ? source.bunkerTraits : []).map((trait) => {
        const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
        return /water|вод|вокд/.test(hint) ? { ...trait, randomPercentage: true } : trait;
    });
    return {
        config: { ...source, bunkerTraits, waterRandomPercentSeedVersion: WATER_RANDOM_PERCENT_SEED_VERSION },
        changed: true
    };
}

function seedWaterAsDuration(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.waterDurationSeedVersion) >= WATER_DURATION_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const fallbackOptions = clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "water").options);
    const bunkerTraits = (Array.isArray(source.bunkerTraits) ? source.bunkerTraits : []).map((trait) => {
        const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
        if (!/water|вод|вокд/.test(hint)) return trait;
        const rawOptions = Array.isArray(trait?.options) ? trait.options : trait?.values;
        const hasDurationOptions = Array.isArray(rawOptions) && rawOptions.some((option) => {
            const value = typeof option === "string" ? option : option?.value;
            return /дн|месяц|год|лет|воды нет/i.test(String(value || ""));
        });
        return {
            ...trait,
            name: "Наличие воды",
            options: hasDurationOptions ? rawOptions : fallbackOptions,
            values: undefined,
            randomPercentage: false
        };
    });
    return {
        config: { ...source, bunkerTraits, waterDurationSeedVersion: WATER_DURATION_SEED_VERSION },
        changed: true
    };
}

function inferBunkerStayDuration(text) {
    const hint = String(text || "").toLocaleLowerCase("ru");
    const explicitDuration = hint.match(/\b(\d+)\s*(дн(?:я|ей|ь)?|месяц(?:а|ев)?|год(?:а)?|лет)\b/);
    if (explicitDuration) return explicitDuration[1] + " " + explicitDuration[2];
    if (/\b(?:на|через) год\b/.test(hint)) return "12 месяцев";
    if (/ядерн.*зим|радиаци/.test(hint)) return "18 месяцев";
    if (/токсич|туман/.test(hint)) return "14 месяцев";
    if (/вирус|эпидем|карантин/.test(hint)) return "12 месяцев";
    if (/солнечн.*вспыш/.test(hint)) return "12 месяцев";
    if (/метеорит|падени.*астероид/.test(hint)) return "12 месяцев";
    return "Бессрочно";
}

function pluralRu(amount, forms) {
    const value = Math.abs(Number(amount) || 0) % 100;
    const last = value % 10;
    if (value > 10 && value < 20) return forms[2];
    if (last === 1) return forms[0];
    if (last >= 2 && last <= 4) return forms[1];
    return forms[2];
}

function formatSupplyDuration(duration) {
    const amount = Math.max(1, Math.trunc(Number(duration?.amount) || 1));
    const unit = duration?.unit === "month" ? pluralRu(amount, ["месяц", "месяца", "месяцев"]) : pluralRu(amount, ["день", "дня", "дней"]);
    return `${amount} ${unit}`;
}

function materializeSupplyValue(value, kind, supplyDurations = DEFAULT_SUPPLY_DURATIONS) {
    const text = String(value || "").trim();
    if (!text || /(?:воды|еды)\s+нет/i.test(text)) return text;
    const options = supplyDurations?.[kind];
    if (!Array.isArray(options) || !options.length) return text;
    const duration = formatSupplyDuration(randomItem(options));
    if (kind === "water") return `Запас питьевой воды на ${duration}`;
    return `Запас еды на ${duration}`;
}

function randomDisasterDuration(disaster) {
    const text = disasterText(disaster).toLocaleLowerCase("ru");
    const pool = /ядер|радиаци|глобальн.*зараж/.test(text)
        ? ["5 лет", "10 лет", "25 лет"]
        : /вирус|эпидем|пандем|карантин/.test(text)
            ? ["1 год", "2 года", "3 года"]
            : /солнечн|метеорит|астероид|токсич|туман/.test(text)
                ? ["3 месяца", "6 месяцев", "1 год", "2 года"]
                : ["6 месяцев", "1 год", "2 года", "5 лет"];
    return randomItem(pool);
}

function disasterText(disaster) {
    return String(typeof disaster === "string" ? disaster : disaster?.text ?? disaster?.description ?? "").trim().replace(/\s+/g, " ");
}

function disasterDuration(disaster) {
    const text = disasterText(disaster);
    const configured = typeof disaster === "object" ? disaster?.shelterDuration ?? disaster?.duration : "";
    return cleanText(configured, 60) || inferBunkerStayDuration(text);
}

function seedDisasterDurations(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.disasterDurationSeedVersion) >= DISASTER_DURATION_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const disasters = (Array.isArray(source.disasters) ? source.disasters : []).map((disaster) => ({
        text: disasterText(disaster),
        shelterDuration: disasterDuration(disaster)
    })).filter((disaster) => disaster.text);
    return {
        config: {
            ...source,
            disasters,
            disasterDurationSeedVersion: DISASTER_DURATION_SEED_VERSION
        },
        changed: true
    };
}

function isPlaceholderValue(value) {
    return /^(?:перв(?:ый|ая)|втор(?:ой|ая)|трет(?:ий|ья)|четв[её]рт(?:ый|ая))\s+вариант$/i.test(String(value || "").trim());
}

function categoryContentKind(category) {
    const hint = `${category?.id || ""} ${category?.name || ""}`.toLocaleLowerCase("ru");
    if (/profession|професс/.test(hint)) return "profession";
    if (/health|здоров/.test(hint)) return "health";
    if (/gender[_-]?age|пол.*возраст|возраст.*пол/.test(hint)) return "gender_age";
    if (/gender|\bsex\b|пол\b/.test(hint)) return "gender";
    if (/age|возраст/.test(hint)) return "age";
    if (/body|телослож/.test(hint)) return "body";
    if (/character|характер/.test(hint)) return "character";
    if (/parents|family|семь|родител/.test(hint)) return "family";
    if (/backpack|рюкзак|багаж/.test(hint)) return "backpack";
    if (/hobby|хобби/.test(hint)) return "hobby";
    if (/orientation|ориентац/.test(hint)) return "orientation";
    if (/special|спец/.test(hint)) return "special";
    return "generic";
}

function categoryContentTemplate(category) {
    const templates = {
        profession: [["Врач скорой помощи", 95], ["Инженер-электрик", 92], ["Фермер", 90], ["Механик", 88], ["Строитель", 84], ["Повар", 76], ["Биолог", 78], ["Психолог", 62]],
        health: [["Полностью здоров", 95], ["Сильный иммунитет", 90], ["Астма под контролем", 55], ["Диабет под контролем", 50], ["Перелом руки срастается", 35], ["Хроническая мигрень", 40]],
        gender_age: DEFAULT_GENDER_AGE_CATEGORY.options.map((option) => [option.value, option.score]),
        gender: [["Мужчина", 50], ["Женщина", 50]],
        age: [["18 лет", 60], ["25 лет", 82], ["34 года", 86], ["42 года", 78], ["55 лет", 62], ["68 лет", 35]],
        body: [["Атлетическое телосложение", 88], ["Крепкое телосложение", 82], ["Среднее телосложение", 58], ["Худощавое телосложение", 54], ["После травмы колена", 30], ["Выносливый", 85]],
        family: [["Один, без иждивенцев", 75], ["Есть младшая сестра", 56], ["Ухаживает за пожилой мамой", 42], ["Семья в другом городе", 62], ["Есть маленький ребёнок", 45], ["Сирота", 65]],
        character: DEFAULT_CHARACTER_CATEGORY.options.map((option) => [option.value, option.score]),
        backpack: [["Оружие", 70], ["Аптечка и набор лекарств", 92], ["Набор инструментов", 88], ["Фильтр для воды", 86], ["Солнечная батарея", 83], ["Рация", 74], ["Ящик консервов", 82]],
        hobby: [["Выживание в дикой природе", 84], ["Садоводство", 78], ["Радиолюбительство", 72], ["Столярное дело", 74], ["Рыбалка", 62], ["Настольные игры", 44]],
        orientation: [["Гетеросексуал", 50], ["Бисексуал", 50], ["Гомосексуал", 50]],
        special: [["Оказывает первую помощь", 80], ["Чинит электрику", 90], ["Умеет выращивать грибы", 76], ["Разбирается в радиосвязи", 72], ["Вскрывает замки", 60], ["Успокаивает людей", 64]],
        generic: [["Полезный опыт", 75], ["Обычный вариант", 50], ["Сложное состояние", 25], ["Практический навык", 70], ["Редкий ресурс", 80]]
    };
    return templates[categoryContentKind(category)];
}

function optionsFromCategoryTemplate(category) {
    const template = categoryContentTemplate(category);
    return template.map(([value, score], index) => ({
        value,
        score,
        chance: defaultChance(index, template.length)
    }));
}

function bunkerContentTemplate(trait) {
    const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
    if (/previous|предыдущ|жител|бомж/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "previous_residents").options);
    if (/water|вод|вокд/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "water").options);
    if (/food|(?:^|\s)ед[аы](?:\s|$)|пищ|питан/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "food").options);
    if (/electric|электр|свет/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "electricity").options);
    if (/ventilat|вентил/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "ventilation").options);
    if (/condition|состояни|ремонт|поврежд/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "condition").options);
    if (/specialization|назначен|специализ|техническ|лаборатор|ферм/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "specialization").options);
    return [
        { value: "Полностью исправно", chance: 40, occupiedSlots: 0 },
        { value: "Работает с перебоями", chance: 35, occupiedSlots: 0 },
        { value: "Серьёзно повреждено", chance: 25, occupiedSlots: 0 }
    ];
}

function seedPlaceholderContent(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.contentFillSeedVersion) >= CONTENT_FILL_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const categories = (Array.isArray(source.categories) ? source.categories : []).map((category) => {
        const options = Array.isArray(category?.options) ? category.options : category?.values;
        if (!Array.isArray(options) || !options.some((option) => isPlaceholderValue(typeof option === "string" ? option : option?.value))) return category;
        if (options.every((option) => isPlaceholderValue(typeof option === "string" ? option : option?.value))) {
            return { ...category, options: optionsFromCategoryTemplate(category), values: undefined };
        }
        const replacements = categoryContentTemplate(category);
        let replacementIndex = 0;
        return {
            ...category,
            options: options.map((option) => {
                const value = typeof option === "string" ? option : option?.value;
                if (!isPlaceholderValue(value)) return option;
                const [nextValue, score] = replacements[replacementIndex++ % replacements.length];
                return typeof option === "string" ? { value: nextValue, score } : { ...option, value: nextValue, score };
            }),
            values: undefined
        };
    });
    const bunkerTraits = (Array.isArray(source.bunkerTraits) ? source.bunkerTraits : []).map((trait) => {
        const options = Array.isArray(trait?.options) ? trait.options : trait?.values;
        const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
        const isResidents = /previous|предыдущ|жител|бомж/.test(hint);
        const hasResidentOption = Array.isArray(options) && options.some((option) => /бункер пуст|бездом|жител/.test(String(typeof option === "string" ? option : option?.value || "").toLocaleLowerCase("ru")));
        if (isResidents && !hasResidentOption) {
            return { ...trait, options: bunkerContentTemplate(trait), values: undefined };
        }
        if (!Array.isArray(options) || !options.some((option) => isPlaceholderValue(typeof option === "string" ? option : option?.value))) return trait;
        if (options.every((option) => isPlaceholderValue(typeof option === "string" ? option : option?.value))) {
            return { ...trait, options: bunkerContentTemplate(trait), values: undefined };
        }
        const replacements = bunkerContentTemplate(trait);
        let replacementIndex = 0;
        return {
            ...trait,
            options: options.map((option) => {
                const value = typeof option === "string" ? option : option?.value;
                if (!isPlaceholderValue(value)) return option;
                const replacement = replacements[replacementIndex++ % replacements.length];
                return typeof option === "string" ? clone(replacement) : { ...option, value: replacement.value, occupiedSlots: replacement.occupiedSlots || 0 };
            }),
            values: undefined
        };
    });
    return {
        config: { ...source, categories, bunkerTraits, contentFillSeedVersion: CONTENT_FILL_SEED_VERSION },
        changed: true
    };
}

function isBackpackCategory(category) {
    const hint = `${category?.id || ""} ${category?.name || ""}`.toLocaleLowerCase("ru");
    return /backpack|рюкзак|багаж/.test(hint);
}

function isWeaponItem(value) {
    return /оруж|пистолет|автомат|винтовк|ружь|дробовик/.test(String(value || "").toLocaleLowerCase("ru"));
}

function optionsWithWeapon(rawOptions) {
    const source = Array.isArray(rawOptions) ? rawOptions : [];
    const total = source.reduce((sum, option, index) => sum + cleanChance(
        typeof option === "string" ? undefined : option?.chance,
        defaultChance(index, source.length)
    ), 0);
    const remainingChance = 100 - WEAPON_BACKPACK_OPTION.chance;
    let assignedChance = 0;
    const scaled = source.map((option, index) => {
        const rawChance = cleanChance(
            typeof option === "string" ? undefined : option?.chance,
            defaultChance(index, source.length)
        );
        const chance = index === source.length - 1
            ? Math.round((remainingChance - assignedChance) * 100) / 100
            : Math.round(((total > 0 ? rawChance / total : 1 / source.length) * remainingChance) * 100) / 100;
        assignedChance += chance;
        return typeof option === "string" ? { value: option, chance } : { ...option, chance };
    });
    return [...scaled, clone(WEAPON_BACKPACK_OPTION)];
}

function seedBackpackWeapon(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.backpackWeaponSeedVersion) >= BACKPACK_WEAPON_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const categories = Array.isArray(source.categories) ? clone(source.categories) : [];
    const backpackIndex = categories.findIndex(isBackpackCategory);
    if (backpackIndex < 0) {
        categories.push(clone(DEFAULT_BACKPACK_CATEGORY));
    } else {
        const category = categories[backpackIndex];
        const options = Array.isArray(category.options) ? category.options : category.values;
        if (!Array.isArray(options) || !options.some((option) => isWeaponItem(typeof option === "string" ? option : option?.value))) {
            categories[backpackIndex] = {
                ...category,
                options: optionsWithWeapon(options),
                values: undefined
            };
        }
    }
    return {
        config: {
            ...source,
            categories,
            backpackWeaponSeedVersion: BACKPACK_WEAPON_SEED_VERSION
        },
        changed: true
    };
}

function isWaterSupplyItem(value) {
    const text = String(value || "").toLocaleLowerCase("ru");
    return /(?:запас|канистр|бутыл|фляг).*(?:вод|питьев)|(?:вод|питьев).*(?:запас|канистр|бутыл|фляг)/.test(text);
}

function optionsWithWaterSupplies(rawOptions) {
    const source = Array.isArray(rawOptions) ? rawOptions : [];
    if (!source.length) return clone(DEFAULT_BACKPACK_CATEGORY.options);
    if (source.some((option) => isWaterSupplyItem(typeof option === "string" ? option : option?.value))) return source;
    const waterChance = WATER_BACKPACK_OPTIONS.reduce((sum, option) => sum + option.chance, 0);
    const availableChance = 100 - waterChance;
    const total = source.reduce((sum, option, index) => sum + cleanChance(
        typeof option === "string" ? undefined : option?.chance,
        defaultChance(index, source.length)
    ), 0);
    let assignedChance = 0;
    const adjusted = source.map((option, index) => {
        const rawChance = cleanChance(
            typeof option === "string" ? undefined : option?.chance,
            defaultChance(index, source.length)
        );
        const chance = index === source.length - 1
            ? Math.round((availableChance - assignedChance) * 100) / 100
            : Math.round(((total > 0 ? rawChance / total : 1 / source.length) * availableChance) * 100) / 100;
        assignedChance += chance;
        return typeof option === "string" ? { value: option, chance } : { ...option, chance };
    });
    return [...adjusted, ...clone(WATER_BACKPACK_OPTIONS)];
}

function seedBackpackWater(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.backpackWaterSeedVersion) >= BACKPACK_WATER_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const categories = Array.isArray(source.categories) ? clone(source.categories) : [];
    const backpackIndex = categories.findIndex(isBackpackCategory);
    if (backpackIndex < 0) {
        categories.push(clone(DEFAULT_BACKPACK_CATEGORY));
    } else {
        const category = categories[backpackIndex];
        categories[backpackIndex] = {
            ...category,
            options: optionsWithWaterSupplies(Array.isArray(category.options) ? category.options : category.values),
            values: undefined
        };
    }
    return {
        config: {
            ...source,
            categories,
            backpackWaterSeedVersion: BACKPACK_WATER_SEED_VERSION
        },
        changed: true
    };
}

function isProfileCategory(category) {
    const id = String(category?.id || "").toLocaleLowerCase("ru");
    const name = String(category?.name || "").toLocaleLowerCase("ru").trim();
    return ["gender", "age", "family", "gender_age", "character"].includes(id)
        || /^(пол|возраст|семья|характер|пол и возраст)$/.test(name);
}

function seedProfileCategories(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.genderOptionsSeedVersion) >= GENDER_OPTIONS_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const categories = Array.isArray(source.categories) ? clone(source.categories) : [];
    const profileIndexes = categories.map((category, index) => isProfileCategory(category) ? index : -1).filter((index) => index >= 0);
    const healthIndex = categories.findIndex((category) => /health|здоров/.test(`${category?.id || ""} ${category?.name || ""}`.toLocaleLowerCase("ru")));
    const insertAt = profileIndexes.length ? profileIndexes[0] : Math.max(0, healthIndex + 1);
    const remainingCategories = categories.filter((category) => !isProfileCategory(category));
    remainingCategories.splice(Math.min(insertAt, remainingCategories.length), 0, clone(DEFAULT_GENDER_AGE_CATEGORY), clone(DEFAULT_CHARACTER_CATEGORY));
    return {
        config: {
            ...source,
            categories: remainingCategories,
            genderOptionsSeedVersion: GENDER_OPTIONS_SEED_VERSION
        },
        changed: true
    };
}

function seedHealthCategory(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.healthCategorySeedVersion) >= HEALTH_CATEGORY_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const categories = Array.isArray(source.categories) ? [...source.categories] : [];
    const healthIndex = categories.findIndex((category) => /health|здоров/.test(`${category?.id || ""} ${category?.name || ""}`.toLocaleLowerCase("ru")));
    if (healthIndex < 0) {
        const professionIndex = categories.findIndex((category) => String(category?.id || "").toLocaleLowerCase("ru") === "profession");
        categories.splice(Math.max(0, professionIndex + 1), 0, clone(DEFAULT_HEALTH_CATEGORY));
    }
    return {
        config: {
            ...source,
            categories,
            healthCategorySeedVersion: HEALTH_CATEGORY_SEED_VERSION
        },
        changed: true
    };
}

function seedSpecialCardLibrary(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.specialCardLibrarySeedVersion) >= SPECIAL_CARD_LIBRARY_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const specialCards = (Array.isArray(source.specialCards) ? source.specialCards : []).map((card) => (
        card?.effect === "swap_adjacent_profession" && [
            "Один раз случайно выберите соседа слева или справа и обменяйтесь с ним профессиями.",
            "Один раз выберите соседа слева, справа или случайно и обменяйтесь с ним профессиями."
        ].includes(card.description)
            ? { ...card, description: "При выдаче карта случайно получает вариант: обмен с соседом слева, справа или со случайным соседом." }
            : card
    ));
    const adjacentSwap = DEFAULT_GAME_CONFIG.specialCards.find((card) => card.effect === "swap_adjacent_profession");
    const hasAdjacentSwap = specialCards.some((card) => card?.effect === "swap_adjacent_profession" || /сосед|лев|прав/.test(`${card?.id || ""} ${card?.name || ""}`.toLocaleLowerCase("ru")));
    const capacityCards = DEFAULT_GAME_CONFIG.specialCards.filter((card) => ["increase_capacity", "decrease_capacity", "random_capacity"].includes(card.effect));
    const missingCapacityCards = capacityCards.filter((defaultCard) => !specialCards.some((card) => card?.effect === defaultCard.effect));
    const healthCards = DEFAULT_GAME_CONFIG.specialCards.filter((card) => ["improve_health", "worsen_health"].includes(card.effect));
    const missingHealthCards = healthCards.filter((defaultCard) => !specialCards.some((card) => card?.effect === defaultCard.effect));
    return {
        config: {
            ...source,
            specialCards: [
                ...specialCards,
                ...(hasAdjacentSwap ? [] : [clone(adjacentSwap)]),
                ...missingCapacityCards.map(clone),
                ...missingHealthCards.map(clone)
            ],
            specialCardLibrarySeedVersion: SPECIAL_CARD_LIBRARY_SEED_VERSION
        },
        changed: true
    };
}

function seedGameConfig(rawConfig) {
    const bunkerSeed = seedDefaultBunkerTraits(rawConfig);
    const waterLabelSeed = seedWaterTraitLabel(bunkerSeed.config);
    const waterOptionsSeed = seedRandomWaterOptions(waterLabelSeed.config);
    const waterPercentageSeed = seedRandomWaterPercentage(waterOptionsSeed.config);
    const waterDurationSeed = seedWaterAsDuration(waterPercentageSeed.config);
    const contentSeed = seedPlaceholderContent(waterDurationSeed.config);
    const backpackSeed = seedBackpackWeapon(contentSeed.config);
    const backpackWaterSeed = seedBackpackWater(backpackSeed.config);
    const profileSeed = seedProfileCategories(backpackWaterSeed.config);
    const healthSeed = seedHealthCategory(profileSeed.config);
    const specialCardSeed = seedSpecialCardLibrary(healthSeed.config);
    const disasterSeed = seedDisasterDurations(specialCardSeed.config);
    return {
        config: disasterSeed.config,
        changed: bunkerSeed.changed || waterLabelSeed.changed || waterOptionsSeed.changed || waterPercentageSeed.changed || waterDurationSeed.changed || backpackSeed.changed || backpackWaterSeed.changed || profileSeed.changed || healthSeed.changed || specialCardSeed.changed || disasterSeed.changed || contentSeed.changed
    };
}

function normalizeGameConfig(rawConfig, includePresets = true) {
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
            const normalizedOption = {
                value,
                score: cleanScore(rawScore, defaultOptionScore(id, value)),
                chance: cleanChance(rawChance, defaultChance(index, sourceOptions.length))
            };
            if (id === "profession") {
                normalizedOption.passiveItem = cleanText(typeof option === "string" ? "" : option?.passiveItem, 120) || defaultProfessionItem(value);
            }
            return normalizedOption;
        }).filter(Boolean).slice(0, 40);
        if (!id || !name || !options.length || usedIds.has(id)) return null;
        const chanceTotal = options.reduce((sum, option) => sum + option.chance, 0);
        if (Math.abs(chanceTotal - 100) > 0.01) {
            throw new Error(`Сумма вероятностей в категории «${name}» должна быть 100%. Сейчас: ${chanceTotal}%.`);
        }
        usedIds.add(id);
        return { id, name, options, enabled: id === "profession" ? true : category?.enabled !== false };
    }).filter(Boolean).slice(0, 12);

    const profession = categories.find((category) => category.id === "profession");
    const otherCategories = categories.filter((category) => category.id !== "profession");
    if (!profession) {
        otherCategories.unshift(clone(DEFAULT_GAME_CONFIG.categories.find((category) => category.id === "profession")));
    } else {
        otherCategories.unshift(profession);
    }
    const disasters = Array.isArray(rawConfig?.disasters)
        ? rawConfig.disasters.map((item) => {
            const text = disasterText(item);
            if (!text) return null;
            return { text, shelterDuration: disasterDuration(item) };
        }).filter(Boolean).slice(0, 30)
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
            return {
                value,
                chance: cleanChance(rawChance, defaultChance(index, source.length)),
                occupiedSlots: cleanOccupiedSlots(typeof option === "string" ? 0 : option?.occupiedSlots ?? option?.slots)
            };
        }).filter(Boolean).slice(0, 40);
        if (!id || !name || !options.length || usedBunkerTraitIds.has(id)) return null;
        const chanceTotal = options.reduce((sum, option) => sum + option.chance, 0);
        if (Math.abs(chanceTotal - 100) > 0.01) {
            throw new Error("Сумма вероятностей в характеристике бункера «" + name + "» должна быть 100%. Сейчас: " + chanceTotal + "%.");
        }
        usedBunkerTraitIds.add(id);
        const isWaterTrait = /water|вод|вокд/.test(`${id} ${name}`.toLocaleLowerCase("ru"));
        return { id, name, options, randomPercentage: isWaterTrait ? false : Boolean(trait?.randomPercentage) };
    }).filter(Boolean).slice(0, 16);

    const usedSpecialCardIds = new Set();
    const rawSpecialCards = Array.isArray(rawConfig?.specialCards) && rawConfig.specialCards.length
        ? rawConfig.specialCards
        : DEFAULT_GAME_CONFIG.specialCards;
    const normalizedSpecialCards = rawSpecialCards.map((card) => {
        const id = cleanCategoryId(card?.id);
        const name = cleanText(card?.name, 60);
        const description = cleanText(card?.description, 1200);
        const hint = `${id} ${name}`.toLocaleLowerCase("ru");
        const effect = card?.effect === "swap_adjacent_profession" || (/сосед|лев|прав/.test(hint) && /професс|специальност/.test(hint))
            ? "swap_adjacent_profession"
            : card?.effect === "improve_health" || (/улучш|леч|исцел/.test(hint) && /здоров|болез|стади/.test(hint))
                ? "improve_health"
                : card?.effect === "worsen_health" || (/ухудш|зараз|диверс/.test(hint) && /здоров|болез|стади/.test(hint))
                    ? "worsen_health"
            : /увелич|добав.*(?:мест|слот)|расшир/.test(hint)
            ? "increase_capacity"
            : /уменьш|отнят|убрат.*(?:мест|слот)|сократ/.test(hint)
                ? "decrease_capacity"
                : /размер.*бункер|бункер.*размер|измен.*(?:мест|слот)/.test(hint)
                    ? "random_capacity"
                    : /перерол|зарандом|рандом.*сво|измен.*сво.*характер/.test(hint)
                        ? "reroll_own_trait"
                        : card?.effect === "take_backpack"
                            ? "take_backpack"
                            : ["increase_capacity", "decrease_capacity", "random_capacity", "reroll_own_trait", "swap_adjacent_profession", "improve_health", "worsen_health"].includes(card?.effect)
                                ? card.effect
                                : card?.effect === "swap_random_trait" || card?.effect === "swap_trait"
                                    ? "swap_random_trait"
                                    : "";
        if (!id || !name || !description || !effect || usedSpecialCardIds.has(id)) return null;
        usedSpecialCardIds.add(id);
        return { id, name, description, effect };
    }).filter(Boolean).slice(0, 20);
    const specialCards = normalizedSpecialCards.length ? normalizedSpecialCards : clone(DEFAULT_GAME_CONFIG.specialCards);

    const hiddenAvatars = [...new Set(
        (Array.isArray(rawConfig?.hiddenAvatars) ? rawConfig.hiddenAvatars : [])
            .map((url) => String(url || ""))
            .filter((url) => /^\/assets\/survivor-avatars\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|svg)$/i.test(url))
    )];

    const rawRevision = Number(rawConfig?.revision);
    const revision = Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0;
    const bunkerTraitsSeedVersion = Number(rawConfig?.bunkerTraitsSeedVersion) >= BUNKER_TRAITS_SEED_VERSION
        ? BUNKER_TRAITS_SEED_VERSION
        : 0;
    const backpackWeaponSeedVersion = Number(rawConfig?.backpackWeaponSeedVersion) >= BACKPACK_WEAPON_SEED_VERSION
        ? BACKPACK_WEAPON_SEED_VERSION
        : 0;
    const waterTraitLabelSeedVersion = Number(rawConfig?.waterTraitLabelSeedVersion) >= WATER_TRAIT_LABEL_SEED_VERSION
        ? WATER_TRAIT_LABEL_SEED_VERSION
        : 0;
    const waterOptionsSeedVersion = Number(rawConfig?.waterOptionsSeedVersion) >= WATER_OPTIONS_SEED_VERSION
        ? WATER_OPTIONS_SEED_VERSION
        : 0;
    const waterRandomPercentSeedVersion = Number(rawConfig?.waterRandomPercentSeedVersion) >= WATER_RANDOM_PERCENT_SEED_VERSION
        ? WATER_RANDOM_PERCENT_SEED_VERSION
        : 0;
    const waterDurationSeedVersion = Number(rawConfig?.waterDurationSeedVersion) >= WATER_DURATION_SEED_VERSION
        ? WATER_DURATION_SEED_VERSION
        : 0;
    const backpackWaterSeedVersion = Number(rawConfig?.backpackWaterSeedVersion) >= BACKPACK_WATER_SEED_VERSION
        ? BACKPACK_WATER_SEED_VERSION
        : 0;
    const genderOptionsSeedVersion = Number(rawConfig?.genderOptionsSeedVersion) >= GENDER_OPTIONS_SEED_VERSION
        ? GENDER_OPTIONS_SEED_VERSION
        : 0;
    const healthCategorySeedVersion = Number(rawConfig?.healthCategorySeedVersion) >= HEALTH_CATEGORY_SEED_VERSION
        ? HEALTH_CATEGORY_SEED_VERSION
        : 0;
    const specialCardLibrarySeedVersion = Number(rawConfig?.specialCardLibrarySeedVersion) >= SPECIAL_CARD_LIBRARY_SEED_VERSION
        ? SPECIAL_CARD_LIBRARY_SEED_VERSION
        : 0;
    const disasterDurationSeedVersion = Number(rawConfig?.disasterDurationSeedVersion) >= DISASTER_DURATION_SEED_VERSION
        ? DISASTER_DURATION_SEED_VERSION
        : 0;
    const contentFillSeedVersion = Number(rawConfig?.contentFillSeedVersion) >= CONTENT_FILL_SEED_VERSION
        ? CONTENT_FILL_SEED_VERSION
        : 0;
    const supplyDurations = Object.fromEntries(["water", "food"].map((kind) => {
        const source = Array.isArray(rawConfig?.supplyDurations?.[kind]) ? rawConfig.supplyDurations[kind] : DEFAULT_SUPPLY_DURATIONS[kind];
        const values = source.map((duration) => ({
            amount: Math.max(1, Math.min(120, Math.trunc(Number(duration?.amount) || 0))),
            unit: duration?.unit === "month" ? "month" : "day"
        })).filter((duration) => duration.amount > 0);
        return [kind, values.length ? values : clone(DEFAULT_SUPPLY_DURATIONS[kind])];
    }));
    const baseConfig = { categories: otherCategories, disasters, bunkerTraits, bunkerTraitsSeedVersion, backpackWeaponSeedVersion, waterTraitLabelSeedVersion, waterOptionsSeedVersion, waterRandomPercentSeedVersion, waterDurationSeedVersion, backpackWaterSeedVersion, genderOptionsSeedVersion, healthCategorySeedVersion, specialCardLibrarySeedVersion, disasterDurationSeedVersion, contentFillSeedVersion, specialCards, supplyDurations, hiddenAvatars, revision };
    if (!includePresets) return baseConfig;

    const defaultPresetNames = [
        ["classic", "Классический"],
        ["realistic", "Реалистичный"],
        ["funny", "Смешной"],
        ["hard", "Сложный"],
        ["postapocalypse", "Постапокалипсис"],
        ["experimental", "Экспериментальный"]
    ];
    const rawPresets = Array.isArray(rawConfig?.presets) && rawConfig.presets.length
        ? rawConfig.presets
        : defaultPresetNames.map(([id, name]) => ({ id, name, ...clone(baseConfig) }));
    const presetIds = new Set();
    const presets = rawPresets.map((preset, index) => {
        const id = cleanCategoryId(preset?.id) || `preset_${index + 1}`;
        if (presetIds.has(id)) return null;
        presetIds.add(id);
        const content = normalizeGameConfig({
            categories: preset?.categories || baseConfig.categories,
            disasters: preset?.disasters || baseConfig.disasters,
            bunkerTraits: preset?.bunkerTraits || baseConfig.bunkerTraits,
            specialCards: preset?.specialCards || baseConfig.specialCards,
            supplyDurations: preset?.supplyDurations || baseConfig.supplyDurations,
            hiddenAvatars: baseConfig.hiddenAvatars,
            revision: 0
        }, false);
        return { id, name: cleanText(preset?.name, 50) || `Пресет ${index + 1}`, ...content };
    }).filter(Boolean).slice(0, 20);
    const availablePresets = presets.length ? presets : [{ id: "classic", name: "Классический", ...clone(baseConfig) }];
    const requestedActivePresetId = cleanCategoryId(rawConfig?.activePresetId);
    const activePresetId = availablePresets.some((preset) => preset.id === requestedActivePresetId) ? requestedActivePresetId : availablePresets[0].id;
    return { ...baseConfig, presets: availablePresets, activePresetId };
}

function loadGameConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return normalizeGameConfig(seedGameConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))).config);
        }
    } catch (error) {
        console.warn("Не удалось загрузить настройки игры, используются стандартные.", error.message);
    }
    return normalizeGameConfig(seedGameConfig(DEFAULT_GAME_CONFIG).config);
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
            const seeded = seedGameConfig(storedConfig);
            gameConfig = normalizeGameConfig(seeded.config);
            if (seeded.changed) {
                gameConfig.revision = Math.max(0, Number(gameConfig.revision) || 0) + 1;
                await saveGameConfig(gameConfig);
                console.log("Добавлены базовые характеристики бункера и оружие в багаж.");
            }
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
    return /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|svg)$/i.test(filename);
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
        ...listAvatarDirectory(BUILT_IN_AVATAR_DIRECTORY, "/assets/survivor-avatars", isImageFilename),
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

function gameDataForRoom(room) {
    const presets = Array.isArray(gameConfig.presets) ? gameConfig.presets : [];
    return presets.find((preset) => preset.id === room?.presetId)
        || presets.find((preset) => preset.id === gameConfig.activePresetId)
        || gameConfig;
}

function enabledGameCategories(gameData) {
    const categories = (gameData?.categories || []).filter((category) => category.id === "profession" || category.enabled !== false);
    const profession = categories.find((category) => category.id === "profession");
    return profession ? [profession, ...categories.filter((category) => category.id !== "profession")] : categories;
}

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

function broadcastAdminRooms() {
    io.to(ADMIN_ROOM).emit("admin:rooms-updated", { rooms: adminRoomSummaries() });
}

function broadcastAdminHistory() {
    io.to(ADMIN_ROOM).emit("admin:history-updated", { games: gameHistoryStore.list() });
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
app.get("/api/game-options", (_request, response) => {
    response.json({
        presets: (gameConfig.presets || []).map((preset) => ({ id: preset.id, name: preset.name })),
        activePresetId: gameConfig.activePresetId || "classic",
        testMode: ENABLE_TEST_MODE
    });
});
app.get("/test", (_request, response) => {
    if (!ENABLE_TEST_MODE) return response.status(404).send("Not Found");
    response.sendFile(path.join(__dirname, "public", "test.html"));
});

app.post("/api/admin/login", (request, response) => {
    if (String(request.body?.password || "") !== ADMIN_PASSWORD) {
        return response.status(401).json({ message: "Неверный пароль." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    response.json({ token, expiresInHours: 12, usesDefaultPassword: !process.env.ADMIN_PASSWORD });
});

app.get("/api/admin/config", requireAdmin, (_request, response) => response.json(gameConfig));

app.get("/api/admin/rooms", requireAdmin, (_request, response) => {
    response.json({ rooms: adminRoomSummaries() });
});

app.get("/api/admin/rooms/:gameId", requireAdmin, (request, response) => {
    const gameId = String(request.params.gameId || "");
    const room = Object.values(rooms).find((candidate) => candidate.gameId === gameId);
    if (!room) return response.status(404).json({ message: "Игра уже закрыта или не найдена." });
    response.json({ room: adminRoomSummary(room), state: publicState(room) });
});

app.get("/api/admin/history", requireAdmin, (request, response) => {
    response.json({ games: gameHistoryStore.list({ roomCode: request.query.room, player: request.query.player }) });
});

app.get("/api/admin/history/:gameId", requireAdmin, (request, response) => {
    const game = gameHistoryStore.get(request.params.gameId);
    if (!game) return response.status(404).json({ message: "Лог завершённой игры не найден." });
    response.json({ game });
});

app.delete("/api/admin/history", requireAdmin, async (_request, response) => {
    try {
        await gameHistoryStore.clear();
        nextGameId = 0;
        broadcastAdminHistory();
        response.json({ cleared: true, nextGameId: "0000000" });
    } catch (error) {
        response.status(502).json({ message: error.message || "Не удалось очистить историю." });
    }
});

app.delete("/api/admin/history/:gameId", requireAdmin, async (request, response) => {
    const deleted = await gameHistoryStore.delete(request.params.gameId);
    if (!deleted) return response.status(404).json({ message: "Лог завершённой игры не найден." });
    broadcastAdminHistory();
    response.json({ deleted: true });
});

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
    const builtInAvatars = listAvatarDirectory(BUILT_IN_AVATAR_DIRECTORY, "/assets/survivor-avatars", isImageFilename);
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

function generateGameId() {
    const gameId = String(nextGameId).padStart(7, "0");
    nextGameId += 1;
    return gameId;
}

function cleanNickname(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
}

const PROFESSION_RANKS = ["новичок", "вафля", "продвинутый", "нормис", "силач", "прайм"];

function professionBase(value) {
    return String(value || "").split(" — ")[0];
}

function pickWeightedEntry(options) {
    let roll = Math.random() * 100;
    for (const option of options) {
        roll -= option.chance;
        if (roll <= 0) return option;
    }
    return options[options.length - 1];
}

function pickWeightedOption(options) {
    return pickWeightedEntry(options).value;
}

function isHealthTrait(traitId, traitName = "") {
    return /health|здоров/.test(`${traitId || ""} ${traitName || ""}`.toLocaleLowerCase("ru"));
}

function healthBase(value) {
    return String(value || "").replace(/\s*[—-]\s*стади[яи]\s*[1-5]\s*\/\s*5\s*$/i, "").trim();
}

function healthStage(value) {
    return parseHealthState(value).stage;
}

function healthNeedsStage(value) {
    return /(астм|диабет|мигрен|бессон|паническ|гипертони|эпилепс|онколог|депресс)/.test(healthBase(value).toLocaleLowerCase("ru"));
}

function cardValueForCategory(category, value) {
    if (!isHealthTrait(category?.id, category?.name) || !healthNeedsStage(value)) return value;
    return `${value} — стадия ${Math.floor(Math.random() * 5) + 1}/5`;
}

function generatedCardValue(category, option, supplyDurations) {
    let value = option;
    const hint = `${category?.id || ""} ${category?.name || ""} ${value || ""}`.toLocaleLowerCase("ru");
    if (/(запас|канистр|питьев).*вод/.test(hint)) value = materializeSupplyValue(value, "water", supplyDurations);
    else if (/(запас.*ед|сухпа|консерв)/.test(hint)) value = materializeSupplyValue(value, "food", supplyDurations);
    return cardValueForCategory(category, value);
}

function assignCards(players, categories, supplyDurations) {
    return Object.fromEntries(players.map((player) => [
        player.id,
        Object.fromEntries(categories.map((category) => {
            const option = pickWeightedOption(category.options);
            return [category.id, category.id === "profession" ? option + " — " + randomItem(PROFESSION_RANKS) : generatedCardValue(category, option, supplyDurations)];
        }))
    ]));
}

function healthTraitId(room) {
    return (room.traitOrder || []).find((traitId) => isHealthTrait(traitId, room.categoryNames?.[traitId])) || null;
}

function initializeHealthStates(room) {
    const trait = healthTraitId(room);
    room.healthStates = {};
    if (!trait) return;
    for (const player of room.players) {
        const value = room.cards?.[player.id]?.[trait];
        if (value === undefined) continue;
        room.healthStates[player.id] = parseHealthState(value);
        room.cards[player.id][trait] = formatHealthState(room.healthStates[player.id]);
    }
}

function syncHealthCard(room, playerId, rawState) {
    const trait = healthTraitId(room);
    if (!trait || !room.cards?.[playerId]) return null;
    const state = normalizeHealthState(rawState, room.cards[playerId][trait]);
    room.healthStates = room.healthStates || {};
    room.healthStates[playerId] = state;
    const value = formatHealthState(state);
    room.cards[playerId][trait] = value;
    if (Object.prototype.hasOwnProperty.call(room.revealed?.[playerId] || {}, trait)) {
        room.revealed[playerId][trait] = value;
    }
    return { trait, state, value };
}

function isPreviousResidentsTrait(trait) {
    const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
    return /previous|предыдущ|жител|бомж/.test(hint);
}

function assignBunkerTraits(traits, playerCount, supplyDurations) {
    return traits.map((trait) => {
        if (trait.randomPercentage) {
            const fillPercent = Math.floor(Math.random() * 101);
            return {
                id: trait.id,
                name: trait.name,
                value: fillPercent + "%",
                fillPercent,
                occupiedSlots: 0,
                evictedResidents: 0
            };
        }
        const maximumResidentSlots = playerCount < 6 ? 0 : Math.max(0, Math.floor(playerCount / 2) - 2);
        const residentOptions = isPreviousResidentsTrait(trait)
            ? trait.options.filter((option) => cleanOccupiedSlots(option?.occupiedSlots) <= maximumResidentSlots)
            : null;
        const option = residentOptions?.length
            ? pickWeightedEntry(residentOptions)
            : residentOptions
                ? { value: "Бункер пуст", occupiedSlots: 0 }
                : pickWeightedEntry(trait.options);
        const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
        const materializedValue = /water|вод/.test(hint)
            ? materializeSupplyValue(option.value, "water", supplyDurations)
            : /food|(?:^|\s)ед[аы](?:\s|$)|питан/.test(hint)
                ? materializeSupplyValue(option.value, "food", supplyDurations)
                : option.value;
        return {
            id: trait.id,
            name: trait.name,
            value: materializedValue,
            occupiedSlots: cleanOccupiedSlots(option.occupiedSlots),
            evictedResidents: 0
        };
    });
}

function backpackTraitId(room) {
    return (room.traitOrder || []).find((traitId) => traitId === "backpack" || isBackpackCategory({
        id: traitId,
        name: room.categoryNames?.[traitId]
    })) || null;
}

function weaponSourceForPlayer(room, playerId) {
    const backpackTrait = backpackTraitId(room);
    const backpackValue = backpackTrait ? room.cards?.[playerId]?.[backpackTrait] : "";
    if (isWeaponItem(backpackValue)) return { type: "backpack", trait: backpackTrait, item: backpackValue };
    const professionItem = room.playerProfessionItems?.[playerId];
    if (isWeaponItem(professionItem)) return { type: "profession", item: professionItem };
    const extraBaggage = room.playerExtraBaggage?.[playerId] || [];
    const item = extraBaggage.find(isWeaponItem);
    return item ? { type: "extra", item } : null;
}

function weaponSourceIsRevealed(room, playerId, source) {
    if (!source) return false;
    if (source.type === "backpack") return Boolean(room.revealed?.[playerId]?.[source.trait]);
    if (source.type === "profession") return Boolean(room.revealed?.[playerId]?.profession);
    return true;
}

function useBunkerWeapon(room, playerId) {
    if (room.playerResidentEvictions?.[playerId]) return { error: "Этим оружием уже выгнали жителя." };
    const source = weaponSourceForPlayer(room, playerId);
    if (!source) return { error: "Чтобы выгнать жителя, в вашем багаже должно быть оружие." };
    if (!weaponSourceIsRevealed(room, playerId, source)) {
        return { error: "Сначала раскройте карточку с оружием — нельзя использовать скрытый предмет." };
    }
    const residentsTrait = (room.bunkerTraits || []).find((trait) => cleanOccupiedSlots(trait.occupiedSlots) > 0);
    if (!residentsTrait) return { error: "В бункере нет жителей, которые занимают места." };

    residentsTrait.occupiedSlots = Math.max(0, cleanOccupiedSlots(residentsTrait.occupiedSlots) - 1);
    residentsTrait.evictedResidents = (Number(residentsTrait.evictedResidents) || 0) + 1;
    room.bunkerOccupiedSlots = Math.max(0, (Number(room.bunkerOccupiedSlots) || 0) - 1);
    const previousCapacity = room.capacity;
    room.capacity = Math.min(activePlayers(room).length, room.capacity + 1);
    room.playerResidentEvictions = room.playerResidentEvictions || {};
    room.playerResidentEvictions[playerId] = {
        traitId: residentsTrait.id,
        at: Date.now()
    };
    return {
        residentsTrait,
        source,
        previousCapacity,
        capacity: room.capacity
    };
}

function assignSpecialCards(players, specialCards, traitOrder, bunkerCapacity, categoryNames = {}) {
    const exchangeTraits = traitOrder.filter((trait) => !["profession", "backpack"].includes(trait));
    const rerollTraits = traitOrder.filter((trait) => trait !== "profession");
    const healthTrait = traitOrder.find((trait) => isHealthTrait(trait, categoryNames[trait]));
    const canModifyCapacity = Number(bunkerCapacity) > 2;
    const usableCards = specialCards.filter((card) => (
        card.effect === "swap_random_trait" ? exchangeTraits.length > 0
            : card.effect === "swap_adjacent_profession" ? players.length > 1 && traitOrder.includes("profession")
            : card.effect === "take_backpack" ? traitOrder.includes("backpack")
                : card.effect === "reroll_own_trait" ? rerollTraits.length > 0
                    : ["improve_health", "worsen_health"].includes(card.effect) ? Boolean(healthTrait)
                    : ["increase_capacity", "decrease_capacity", "random_capacity"].includes(card.effect) && canModifyCapacity
    ));
    if (!usableCards.length) return {};
    return Object.fromEntries(players.map((player) => {
        const card = clone(randomItem(usableCards));
        card.trait = card.effect === "swap_random_trait" ? randomItem(exchangeTraits)
            : card.effect === "swap_adjacent_profession" ? "profession"
            : card.effect === "reroll_own_trait" ? randomItem(rerollTraits)
                : ["improve_health", "worsen_health"].includes(card.effect) ? healthTrait
                : card.effect === "take_backpack" ? "backpack" : null;
        if (card.effect === "swap_adjacent_profession") {
            card.direction = randomItem(["left", "right", "random"]);
            const variant = card.direction === "left"
                ? { name: "Обмен профессией — слева", description: "Обменяйтесь профессией с соседом слева." }
                : card.direction === "right"
                    ? { name: "Обмен профессией — справа", description: "Обменяйтесь профессией с соседом справа." }
                    : { name: "Обмен профессией — случайно", description: "Обменяйтесь профессией со случайным соседом." };
            card.name = variant.name;
            card.description = variant.description;
        }
        return [player.id, { ...card, used: false }];
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
const EMPTY_ROOM_TTL_MS = 30 * 60_000;
const FINISHED_ROOM_TTL_MS = 3 * 60_000;
const ROOM_CLOSE_EXTENSION_MS = 30_000;
const REMATCH_DECISION_MS = 60_000;
const MIN_PLAYERS_TO_START = 3;
const SKIP_VOTE = "__skip_vote__";
let launchGame = null;

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

function closeRoom(room, notifyPlayers = true) {
    if (!room || rooms[room.code] !== room) return;
    clearActionTimer(room);
    if (room.closeTimer) clearTimeout(room.closeTimer);
    room.closeTimer = null;
    if (room.rematchTimer) clearTimeout(room.rematchTimer);
    room.rematchTimer = null;
    if (room.lobbyTimer) clearTimeout(room.lobbyTimer);
    room.lobbyTimer = null;
    for (const player of room.players) cancelPendingLeave(player);
    if (notifyPlayers) io.to(room.code).emit("roomExpired");
    delete rooms[room.code];
    broadcastAdminRooms();
}

function cancelIdleLobbyClose(room) {
    if (room?.lobbyTimer) clearTimeout(room.lobbyTimer);
    if (room) {
        room.lobbyTimer = null;
        room.lobbyCloseDeadline = null;
    }
}

function scheduleIdleLobbyClose(room) {
    if (!room || room.isTestRoom || room.phase !== "lobby") return;
    cancelIdleLobbyClose(room);
    room.lobbyCloseDeadline = Date.now() + EMPTY_LOBBY_TTL_MS;
    room.lobbyTimer = setTimeout(() => {
        if (rooms[room.code] !== room || room.phase !== "lobby" || room.players.some((player) => !player.left && player.id !== room.host)) return;
        io.to(room.code).emit("lobbyClosed", { reason: "В лобби никто не присоединился за 3 минуты." });
        closeRoom(room, false);
    }, EMPTY_LOBBY_TTL_MS);
}

function scheduleRoomClose(room, deadline) {
    if (room.closeTimer) clearTimeout(room.closeTimer);
    room.roomCloseDeadline = deadline;
    room.closeTimer = setTimeout(() => closeRoom(room), Math.max(0, deadline - Date.now()));
}

function extendRoomClose(room) {
    const baseDeadline = Math.max(Date.now(), Number(room.roomCloseDeadline) || 0);
    const deadline = baseDeadline + ROOM_CLOSE_EXTENSION_MS;
    scheduleRoomClose(room, deadline);
    return deadline;
}

function rematchHumanPlayers(room) {
    return room.players.filter((player) => !player.left && !player.isBot);
}

function resetRoomToLobby(room) {
    clearActionTimer(room);
    room.phase = "lobby";
    room.rematchDeadline = null;
    room.rematchReadyIds = [];
    room.rematchDeclinedIds = [];
    room.rematchResolved = false;
    room.capacity = 0;
    room.bunkerBaseCapacity = 0;
    room.bunkerOccupiedSlots = 0;
    room.round = 0;
    room.disaster = null;
    room.disasterDuration = null;
    room.bunkerTraits = [];
    room.cards = {};
    room.healthStates = {};
    room.revealed = {};
    room.revealedAtFinish = {};
    room.revealedThisRound = {};
    room.playerSpecialCards = {};
    room.playerProfessionItems = {};
    room.playerExtraBaggage = {};
    room.playerResidentEvictions = {};
    room.usedSpecialCards = [];
    room.eliminated = [];
    room.eliminationOrder = [];
    room.votes = {};
    room.voteCandidateIds = null;
    room.pendingEliminationIds = [];
    room.turnOrder = [];
    room.turnIndex = 0;
    room.turnDeadline = null;
    room.voteDeadline = null;
    room.actionLog = [];
    room.actionLogSequence = 0;
    room.finishedAt = null;
    room.finishReason = null;
    room.roomCloseDeadline = null;
    if (room.closeTimer) clearTimeout(room.closeTimer);
    room.closeTimer = null;
}

function finalizeRematch(room) {
    if (!room || room.phase !== "finished" || room.rematchResolved) return false;
    room.rematchResolved = true;
    if (room.rematchTimer) clearTimeout(room.rematchTimer);
    room.rematchTimer = null;
    room.rematchDeadline = null;

    const preserveBots = Boolean(room.isSoloGame || room.isTestRoom);
    const selection = selectRematchPlayers(room.players, room.rematchReadyIds, preserveBots);
    const readyHumans = selection.readyHumans;
    if (!readyHumans.length) {
        io.to(room.code).emit("rematchClosed", { started: false, reason: "Никто не подтвердил участие в новой игре." });
        emitRoom(room);
        return false;
    }

    for (const player of selection.removed) {
        if (!player.isBot && !player.left) io.to(player.id).emit("rematchExcluded");
        io.sockets.sockets.get(player.id)?.leave(room.code);
        cancelPendingLeave(player);
    }
    room.players = selection.kept;
    room.players.forEach((player) => {
        player.left = false;
        player.disconnected = false;
        player.voluntaryLeft = false;
    });
    if (!room.players.some((player) => player.id === room.host)) room.host = readyHumans[0].id;
    room.gameId = generateGameId();
    room.historyRecorded = false;
    room.rematchReadyIds = [];
    room.rematchDeclinedIds = [];

    const canStartImmediately = room.players.filter((player) => !player.left).length >= MIN_PLAYERS_TO_START;
    if (canStartImmediately && typeof launchGame === "function") {
        const launched = launchGame(room, false);
        if (launched) {
            io.to(room.code).emit("gameRestarted", { gameId: room.gameId, playerCount: room.players.length });
            return true;
        }
    }

    resetRoomToLobby(room);
    io.to(room.code).emit("rematchLobby", { playerCount: room.players.length });
    emitRoom(room);
    return true;
}

function maybeFinalizeRematch(room) {
    if (!room || room.phase !== "finished" || room.rematchResolved) return false;
    const humans = rematchHumanPlayers(room);
    const readyIds = new Set(room.rematchReadyIds || []);
    const declinedIds = new Set(room.rematchDeclinedIds || []);
    if (humans.length && humans.every((player) => readyIds.has(player.id) || declinedIds.has(player.id))) {
        return finalizeRematch(room);
    }
    return false;
}

function startRematchWindow(room) {
    if (room.rematchTimer) clearTimeout(room.rematchTimer);
    room.rematchReadyIds = [];
    room.rematchDeclinedIds = [];
    room.rematchResolved = false;
    room.rematchDeadline = Date.now() + REMATCH_DECISION_MS;
    room.rematchTimer = setTimeout(() => finalizeRematch(room), REMATCH_DECISION_MS);
}

function movePlayerToSocket(room, player, socketId) {
    const previousId = player.id;
    cancelPendingLeave(player);
    if (previousId === socketId) return;

    player.id = socketId;
    if (room.host === previousId) room.host = socketId;
    room.turnOrder = (room.turnOrder || []).map((id) => id === previousId ? socketId : id);
    room.eliminated = (room.eliminated || []).map((id) => id === previousId ? socketId : id);

    for (const record of [room.cards, room.revealed, room.revealedThisRound, room.revealedAtFinish, room.playerSpecialCards, room.healthStates, room.playerProfessionItems, room.playerExtraBaggage, room.playerResidentEvictions]) {
        if (!record || !Object.prototype.hasOwnProperty.call(record, previousId)) continue;
        record[socketId] = record[previousId];
        delete record[previousId];
    }

    room.votes = Object.fromEntries(Object.entries(room.votes || {}).map(([voterId, targetId]) => [
        voterId === previousId ? socketId : voterId,
        targetId === previousId ? socketId : targetId
    ]));
    room.voteCandidateIds = Array.isArray(room.voteCandidateIds) ? room.voteCandidateIds.map((id) => id === previousId ? socketId : id) : room.voteCandidateIds;
    room.pendingEliminationIds = (room.pendingEliminationIds || []).map((id) => id === previousId ? socketId : id);
    room.rematchReadyIds = (room.rematchReadyIds || []).map((id) => id === previousId ? socketId : id);
    room.rematchDeclinedIds = (room.rematchDeclinedIds || []).map((id) => id === previousId ? socketId : id);
    player.left = false;
    player.disconnected = false;
}

function currentTurnPlayerId(room) {
    return room.turnOrder?.[room.turnIndex] || null;
}

function addActionLog(room, text, type = "system") {
    const entry = {
        id: (room.actionLogSequence || 0) + 1,
        text: cleanText(text, 240),
        type,
        at: Date.now()
    };
    room.actionLogSequence = entry.id;
    room.actionLog = [...(room.actionLog || []), entry].slice(-60);
}

function scoreRevealedCard(room, trait, value) {
    const isBackpack = /backpack|рюкзак|багаж/.test(`${trait || ""} ${room.categoryNames?.[trait] || ""}`.toLocaleLowerCase("ru"));
    if (isBackpack && /^(?:рюкзак забран|багаж пуст)$/i.test(String(value || "").trim())) return 0;
    const isHealth = isHealthTrait(trait, room.categoryNames?.[trait]);
    const scoreKey = trait === "profession" ? professionBase(value) : isHealth ? healthBase(value) : value;
    const configuredScore = room.cardScores?.[trait]?.[scoreKey];
    const score = cleanScore(configuredScore, defaultOptionScore(trait, scoreKey));
    if (trait === "profession") return Math.min(100, score + professionBunkerFit(room, value).bonus);
    const stage = isHealth ? healthStage(value) : 0;
    return stage ? Math.max(0, score - (stage - 1) * 8) : score;
}

function giveProfessionItem(room, playerId) {
    const profession = professionBase(room.revealed[playerId]?.profession || "").toLocaleLowerCase("ru");
    const item = room.professionItemsByProfession?.[profession];
    if (!item) return null;
    room.playerProfessionItems[playerId] = item;
    return item;
}

function adjacentPlayerId(room, playerId, direction = "random") {
    const players = activePlayers(room);
    const index = players.findIndex((player) => player.id === playerId);
    if (index < 0 || players.length < 2) return null;
    const leftId = players[(index - 1 + players.length) % players.length]?.id;
    const rightId = players[(index + 1) % players.length]?.id;
    if (direction === "left") return leftId && leftId !== playerId ? leftId : null;
    if (direction === "right") return rightId && rightId !== playerId ? rightId : null;
    const candidates = [...new Set([leftId, rightId])].filter((candidateId) => candidateId && candidateId !== playerId);
    return candidates.length ? randomItem(candidates) : null;
}

function useSpecialCard(room, playerId, targetId) {
    const specialCard = room.playerSpecialCards?.[playerId];
    if (!specialCard || specialCard.used) return { error: "Эта спецкарта уже использована." };
    if (!["swap_random_trait", "swap_adjacent_profession", "take_backpack", "increase_capacity", "decrease_capacity", "random_capacity", "reroll_own_trait", "improve_health", "worsen_health"].includes(specialCard.effect)) return { error: "Неизвестный эффект спецкарты." };
    if (!room.cards[playerId]) return { error: "Не удалось найти ваши карточки." };

    if (specialCard.effect === "swap_adjacent_profession") {
        const direction = ["left", "right", "random"].includes(specialCard.direction) ? specialCard.direction : "random";
        const neighborId = adjacentPlayerId(room, playerId, direction);
        if (!neighborId || !room.cards[neighborId]) return { error: "Для обмена нужен хотя бы один сосед в игре." };
        const trait = "profession";
        const myValue = room.cards[playerId][trait];
        const neighborValue = room.cards[neighborId][trait];
        room.cards[playerId][trait] = neighborValue;
        room.cards[neighborId][trait] = myValue;
        if (Object.prototype.hasOwnProperty.call(room.revealed[playerId] || {}, trait)) room.revealed[playerId][trait] = neighborValue;
        if (Object.prototype.hasOwnProperty.call(room.revealed[neighborId] || {}, trait)) room.revealed[neighborId][trait] = myValue;
        const myItem = room.playerProfessionItems?.[playerId];
        const neighborItem = room.playerProfessionItems?.[neighborId];
        if (room.playerProfessionItems) {
            if (neighborItem) room.playerProfessionItems[playerId] = neighborItem;
            else delete room.playerProfessionItems[playerId];
            if (myItem) room.playerProfessionItems[neighborId] = myItem;
            else delete room.playerProfessionItems[neighborId];
        }
        specialCard.used = true;
        specialCard.targetId = neighborId;
        return { card: specialCard, trait, action: specialCard.effect, targetId: neighborId, direction };
    }

    if (specialCard.effect === "increase_capacity") {
        const previousCapacity = room.capacity;
        room.capacity = Math.min(activePlayers(room).length, room.capacity + 1);
        if (room.capacity === previousCapacity) return { error: "В бункере уже достаточно мест для всех оставшихся игроков." };
        specialCard.used = true;
        return { card: specialCard, action: specialCard.effect, previousCapacity, capacity: room.capacity };
    }

    if (specialCard.effect === "decrease_capacity") {
        const previousCapacity = room.capacity;
        room.capacity = Math.max(2, room.capacity - 1);
        if (room.capacity === previousCapacity) return { error: "Нельзя уменьшить бункер меньше чем до двух мест." };
        specialCard.used = true;
        return { card: specialCard, action: specialCard.effect, previousCapacity, capacity: room.capacity };
    }

    if (specialCard.effect === "random_capacity") {
        const previousCapacity = room.capacity;
        const canIncrease = room.capacity < activePlayers(room).length;
        // Two places is the safe lower bound for the random resize card.
        const canDecrease = room.capacity > 2;
        if (!canIncrease && !canDecrease) return { error: "Размер бункера уже нельзя изменить." };
        const change = canIncrease && canDecrease ? (Math.random() < 0.5 ? 1 : -1) : canIncrease ? 1 : -1;
        room.capacity += change;
        specialCard.used = true;
        return { card: specialCard, action: specialCard.effect, previousCapacity, capacity: room.capacity, change };
    }

    if (specialCard.effect === "reroll_own_trait") {
        if (!room.traitOrder.includes(specialCard.trait)) return { error: "Для этой спецкарты в игре нет нужной категории." };
        const options = room.cardOptionsByTrait?.[specialCard.trait] || [];
        const previousValue = room.cards[playerId][specialCard.trait];
        const isHealth = isHealthTrait(specialCard.trait, room.categoryNames?.[specialCard.trait]);
        const previousBaseValue = isHealth ? healthBase(previousValue) : previousValue;
        const differentOptions = options.filter((option) => option.value !== previousBaseValue);
        const nextBaseValue = pickWeightedOption(differentOptions.length ? differentOptions : options);
        const nextValue = isHealth ? cardValueForCategory({ id: specialCard.trait, name: room.categoryNames?.[specialCard.trait] }, nextBaseValue) : nextBaseValue;
        if (!nextValue) return { error: "Для этой характеристики не хватает вариантов." };
        room.cards[playerId][specialCard.trait] = nextValue;
        if (isHealth) {
            room.healthStates = room.healthStates || {};
            room.healthStates[playerId] = parseHealthState(nextValue);
        }
        if (Object.prototype.hasOwnProperty.call(room.revealed[playerId] || {}, specialCard.trait)) {
            room.revealed[playerId][specialCard.trait] = nextValue;
        }
        specialCard.used = true;
        return { card: specialCard, trait: specialCard.trait, action: specialCard.effect, previousValue, value: nextValue };
    }

    if (["improve_health", "worsen_health"].includes(specialCard.effect)) {
        const trait = healthTraitId(room);
        if (!trait || !targetId || !room.cards?.[targetId]) return { error: "Выберите игрока, здоровье которого нужно изменить." };
        let state = normalizeHealthState(room.healthStates?.[targetId], room.cards[targetId][trait]);
        if (specialCard.effect === "worsen_health" && state.stage === 0) {
            const diseaseOptions = (room.cardOptionsByTrait?.[trait] || [])
                .map((option) => option.value)
                .filter((value) => parseHealthState(value).stage > 0 && !/смертельно болен/i.test(value));
            const diseaseName = healthBase(diseaseOptions.length ? randomItem(diseaseOptions) : "Острое заболевание");
            state = { ...state, diseaseName };
        }
        const amount = Math.floor(Math.random() * 4) + 1;
        const direction = specialCard.effect === "improve_health" ? "improve" : "worsen";
        const change = applyHealthStageChange(state, direction, amount);
        const synchronized = syncHealthCard(room, targetId, change.state);
        specialCard.used = true;
        specialCard.targetId = targetId;
        specialCard.healthChange = amount;
        specialCard.resultValue = synchronized?.value || formatHealthState(change.state);
        return {
            card: specialCard,
            trait,
            action: specialCard.effect,
            targetId,
            amount,
            value: specialCard.resultValue,
            alreadyHealthy: change.alreadyHealthy
        };
    }

    if (!room.traitOrder.includes(specialCard.trait) || !room.cards[targetId]) return { error: "Не удалось найти карточки выбранного игрока." };

    const myValue = room.cards[playerId][specialCard.trait];
    const targetValue = room.cards[targetId][specialCard.trait];
    if (myValue === undefined || targetValue === undefined) return { error: "Этой характеристики нет у выбранного игрока." };

    if (specialCard.effect === "take_backpack") {
        if (/^(?:рюкзак забран|багаж пуст)$/i.test(String(targetValue || "").trim())) return { error: "У этого игрока багаж уже пуст." };
        room.playerExtraBaggage = room.playerExtraBaggage || {};
        room.playerExtraBaggage[playerId] = [...(room.playerExtraBaggage[playerId] || []), targetValue];
        room.cards[targetId][specialCard.trait] = "Багаж пуст";
        room.revealed[targetId] = room.revealed[targetId] || {};
        room.revealed[targetId][specialCard.trait] = room.cards[targetId][specialCard.trait];
        specialCard.used = true;
        specialCard.targetId = targetId;
        specialCard.item = targetValue;
        return { card: specialCard, trait: specialCard.trait, action: specialCard.effect, item: targetValue, targetId };
    }

    room.cards[playerId][specialCard.trait] = targetValue;
    room.cards[targetId][specialCard.trait] = myValue;
    if (isHealthTrait(specialCard.trait, room.categoryNames?.[specialCard.trait])) {
        const myHealth = normalizeHealthState(room.healthStates?.[playerId], myValue);
        const targetHealth = normalizeHealthState(room.healthStates?.[targetId], targetValue);
        room.healthStates = room.healthStates || {};
        room.healthStates[playerId] = targetHealth;
        room.healthStates[targetId] = myHealth;
    }
    if (Object.prototype.hasOwnProperty.call(room.revealed[playerId] || {}, specialCard.trait)) {
        room.revealed[playerId][specialCard.trait] = targetValue;
    }
    if (Object.prototype.hasOwnProperty.call(room.revealed[targetId] || {}, specialCard.trait)) {
        room.revealed[targetId][specialCard.trait] = room.cards[targetId][specialCard.trait];
    }
    specialCard.used = true;
    specialCard.targetId = targetId;
    return { card: specialCard, trait: specialCard.trait, action: specialCard.effect };
}

function tryBotSpecialCard(room, bot) {
    const card = room.playerSpecialCards?.[bot.id];
    if (!card || card.used || Math.random() >= 0.32) return null;
    const requiresOtherTarget = ["swap_random_trait", "take_backpack"].includes(card.effect);
    const requiresAnyTarget = ["improve_health", "worsen_health"].includes(card.effect);
    const candidates = activePlayers(room).filter((player) => requiresOtherTarget ? player.id !== bot.id : true);
    const targetId = requiresOtherTarget || requiresAnyTarget ? randomItem(candidates)?.id : null;
    if ((requiresOtherTarget || requiresAnyTarget) && !targetId) return null;
    const result = useSpecialCard(room, bot.id, targetId);
    if (result.error) return null;
    const target = room.players.find((player) => player.id === result.targetId);
    const summary = result.action === "improve_health" || result.action === "worsen_health"
        ? `${bot.nickname} применяет «${result.card.name}» к ${target?.nickname}: ${result.value}.`
        : target
            ? `${bot.nickname} применяет «${result.card.name}» к ${target.nickname}.`
            : `${bot.nickname} применяет «${result.card.name}».`;
    addActionLog(room, summary, "special");
    room.usedSpecialCards = room.usedSpecialCards || [];
    room.usedSpecialCards.push({ player: bot.nickname, target: target?.nickname || null, name: result.card.name, effect: result.action, amount: result.amount || null, result: result.value || null, at: Date.now() });
    io.to(room.code).emit("specialCardUsed", {
        nickname: bot.nickname,
        targetNickname: target?.nickname || null,
        cardName: result.card.name,
        trait: result.trait,
        action: result.action,
        direction: result.direction || null,
        item: result.item || null,
        capacity: result.capacity || null,
        previousCapacity: result.previousCapacity || null,
        amount: result.amount || null,
        value: result.value || null,
        alreadyHealthy: Boolean(result.alreadyHealthy)
    });
    return result;
}

function calculateUtilityBreakdown(room) {
    const players = activePlayers(room);
    return players.map((player) => {
        let totalScore = 0;
        let revealedCards = 0;
        for (const [trait, value] of Object.entries(room.revealed[player.id] || {})) {
            totalScore += scoreRevealedCard(room, trait, value);
            revealedCards += 1;
        }
        const backpackTrait = backpackTraitId(room) || "backpack";
        for (const item of room.playerExtraBaggage?.[player.id] || []) {
            totalScore += scoreRevealedCard(room, backpackTrait, item);
            revealedCards += 1;
        }
        const professionValue = room.cards?.[player.id]?.profession || room.revealed?.[player.id]?.profession || "";
        const professionScoreKey = professionBase(professionValue);
        const professionBaseScore = cleanScore(room.cardScores?.profession?.[professionScoreKey], defaultOptionScore("profession", professionScoreKey));
        const professionScore = scoreRevealedCard(room, "profession", professionValue);
        const professionBonus = professionValue ? Math.max(0, professionScore - professionBaseScore) : 0;
        const professionReasons = professionBonus ? professionBunkerFit(room, professionValue).reasons : [];
        const professionItem = room.playerProfessionItems?.[player.id] || "";
        const professionItemFit = professionItem ? professionItemBunkerFit(room, professionValue, professionItem) : { bonus: 0, reasons: [] };
        if (professionItem) {
            totalScore += Math.min(100, 55 + professionItemFit.bonus);
            revealedCards += 1;
        }
        const contributions = [
            ...professionReasons.map((reason) => ({ source: professionValue || "Профессия", reason })),
            ...professionItemFit.reasons.map((reason) => ({ source: professionItem, reason }))
        ];
        return {
            playerId: player.id,
            utility: revealedCards ? Math.round(totalScore / revealedCards) : 0,
            totalScore,
            revealedCards,
            professionBonus,
            professionReasons,
            professionItem,
            professionItemBonus: professionItemFit.bonus,
            professionItemReasons: professionItemFit.reasons,
            contributions
        };
    });
}

function calculateBunkerSurvivalChance(room) {
    if (!room.capacity) return null;
    const breakdown = calculateUtilityBreakdown(room);
    const totalScore = breakdown.reduce((sum, player) => sum + player.totalScore, 0);
    const revealedCards = breakdown.reduce((sum, player) => sum + player.revealedCards, 0);
    return revealedCards ? Math.round(totalScore / revealedCards) : null;
}

function synchronizedBunkerTraits(room) {
    return (room.bunkerTraits || []).map((trait) => {
        const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
        if (!/water|вод/.test(hint)) return trait;
        const percentage = Number((String(trait?.value || "").match(/(\d{1,3})\s*%/) || [])[1]);
        if (!Number.isFinite(percentage)) return trait;
        return { ...trait, fillPercent: Math.max(0, Math.min(100, percentage)) };
    });
}

function playerFinalAbilities(room, playerId) {
    const values = [];
    const specialCard = room.playerSpecialCards?.[playerId];
    if (specialCard?.name) values.push(specialCard.name);
    const professionItem = room.playerProfessionItems?.[playerId];
    if (professionItem) values.push(`Бонус профессии: ${professionItem}`);
    const weapon = weaponSourceForPlayer(room, playerId);
    if (weapon) values.push("Оружие: изгнание жителя");
    for (const item of room.playerExtraBaggage?.[playerId] || []) {
        values.push(isWeaponItem(item) ? "Оружие: изгнание жителя" : `Полученный предмет: ${item}`);
    }
    if (room.playerResidentEvictions?.[playerId]) values.push("Изгнал прежнего жителя");
    return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function publicState(room) {
    const gameData = gameDataForRoom(room);
    const currentTrait = room.phase === "reveal" && room.round === 0 ? room.traitOrder?.[0] || null : null;
    const voteMarkers = Object.entries(room.votes || {}).reduce((markers, [voterId, targetId]) => {
        if (targetId === SKIP_VOTE) return markers;
        if (!markers[targetId]) markers[targetId] = [];
        markers[targetId].push(voterId);
        return markers;
    }, {});
    return {
        code: room.code,
        gameId: room.gameId,
        presetId: room.presetId || gameData.id || gameConfig.activePresetId || "classic",
        presetName: room.presetName || gameData.name || "Классический",
        visualTheme: room.visualTheme || "amber",
        serverNow: Date.now(),
        hostId: room.host,
        phase: room.phase,
        disaster: room.disaster,
        disasterDuration: room.disasterDuration || null,
        round: room.round + 1,
        revealRounds: room.revealRounds || Math.max(1, room.traitOrder?.length || 1),
        currentTrait,
        categoryOrder: room.traitOrder || gameData.categories.map((category) => category.id),
        categoryNames: room.categoryNames || Object.fromEntries(gameData.categories.map((category) => [category.id, category.name])),
        revealedThisRound: room.revealedThisRound || {},
        capacity: room.capacity,
        bunkerBaseCapacity: room.bunkerBaseCapacity || room.capacity,
        bunkerOccupiedSlots: room.bunkerOccupiedSlots || 0,
        bunkerTraits: synchronizedBunkerTraits(room),
        actionSeconds: ACTION_DURATION_MS / 1000,
        turnPlayerId: currentTurnPlayerId(room),
        turnDeadline: room.turnDeadline || null,
        voteDeadline: room.voteDeadline || null,
        votedPlayerIds: Object.keys(room.votes || {}),
        voteMarkers,
        eliminationsThisVote: room.eliminationsThisVote || 1,
        voteCandidateIds: Array.isArray(room.voteCandidateIds) ? room.voteCandidateIds : null,
        voteCanBeSkipped: voteCanBeSkipped(room),
        bunkerSurvivalChance: room.phase === "finished" ? calculateBunkerSurvivalChance(room) : null,
        utilityBreakdown: room.phase === "finished"
            ? calculateUtilityBreakdown(room).map(({ playerId, utility, revealedCards, professionBonus, professionReasons, professionItem, professionItemBonus, professionItemReasons, contributions }) => ({ playerId, utility, revealedCards, professionBonus, professionReasons, professionItem, professionItemBonus, professionItemReasons, contributions }))
            : [],
        roomCloseDeadline: room.roomCloseDeadline || null,
        lobbyCloseDeadline: room.lobbyCloseDeadline || null,
        rematchDeadline: room.rematchDeadline || null,
        rematchReadyIds: room.rematchReadyIds || [],
        rematchDeclinedIds: room.rematchDeclinedIds || [],
        rematchResolved: Boolean(room.rematchResolved),
        actionLog: room.actionLog || [],
        players: room.players.map((player) => ({
            id: player.id,
            nickname: player.nickname,
            avatarUrl: player.avatarUrl || null,
            isBot: Boolean(player.isBot),
            left: Boolean(player.left),
            eliminated: room.eliminated.includes(player.id),
            revealed: room.revealed[player.id] || {},
            finishRevealedTraits: room.revealedAtFinish?.[player.id] || [],
            professionItem: room.playerProfessionItems?.[player.id] || null,
            extraBaggage: room.playerExtraBaggage?.[player.id] || [],
            residentEviction: room.playerResidentEvictions?.[player.id] || null,
            abilities: room.phase === "finished" ? playerFinalAbilities(room, player.id) : [],
            usedSpecialCard: room.playerSpecialCards?.[player.id]?.used
                ? { name: room.playerSpecialCards[player.id].name, effect: room.playerSpecialCards[player.id].effect }
                : null
        }))
    };
}

function adminRoomSummary(room) {
    const active = activePlayers(room);
    const currentPlayer = room.players.find((player) => player.id === currentTurnPlayerId(room));
    const lastAction = room.actionLog?.[room.actionLog.length - 1] || null;
    return {
        gameId: room.gameId,
        code: room.code,
        phase: room.phase,
        playerCount: active.length,
        totalPlayerCount: room.players.filter((player) => !player.left).length,
        capacity: room.capacity,
        round: room.round + 1,
        createdAt: room.createdAt || null,
        isSoloTest: Boolean(room.isSoloTest),
        disaster: room.disaster || null,
        currentPlayer: currentPlayer?.nickname || null,
        lastAction: lastAction?.text || null,
        updatedAt: lastAction?.at || room.createdAt || null
    };
}

function adminRoomSummaries() {
    return Object.values(rooms)
        .map(adminRoomSummary)
        .sort((first, second) => Number(second.gameId) - Number(first.gameId));
}

function createGameHistoryRecord(room) {
    const utilityBreakdown = calculateUtilityBreakdown(room);
    const finishedAt = Number(room.finishedAt) || Date.now();
    const participants = room.players.map((player) => ({
        nickname: player.nickname,
        avatarUrl: player.avatarUrl || null,
        isBot: Boolean(player.isBot),
        left: Boolean(player.left),
        eliminated: room.eliminated.includes(player.id),
        cards: clone(room.cards?.[player.id] || {}),
        revealed: clone(room.revealed?.[player.id] || {}),
        specialCard: room.playerSpecialCards?.[player.id] ? clone(room.playerSpecialCards[player.id]) : null,
        abilities: playerFinalAbilities(room, player.id),
        professionItem: room.playerProfessionItems?.[player.id] || null,
        extraBaggage: clone(room.playerExtraBaggage?.[player.id] || [])
    }));
    const nicknameFor = (playerId) => room.players.find((player) => player.id === playerId)?.nickname || null;
    return {
        gameId: room.gameId,
        roomCode: room.code,
        roomCreatedAt: room.createdAt || null,
        startedAt: room.startedAt || null,
        finishedAt,
        durationMs: room.startedAt ? Math.max(0, finishedAt - room.startedAt) : 0,
        hostNickname: nicknameFor(room.host),
        participants,
        activeParticipants: activePlayers(room).map((player) => player.nickname),
        excludedPlayers: room.eliminated.map(nicknameFor).filter(Boolean),
        eliminationOrder: (room.eliminationOrder || []).map(nicknameFor).filter(Boolean),
        winners: activePlayers(room).map((player) => player.nickname),
        theme: room.visualTheme || "amber",
        presetId: room.presetId || gameConfig.activePresetId || "classic",
        presetName: room.presetName || room.presetId || "Классический",
        disaster: room.disaster || null,
        disasterDuration: room.disasterDuration || null,
        bunkerTraits: clone(synchronizedBunkerTraits(room)),
        capacity: room.capacity,
        bunkerBaseCapacity: room.bunkerBaseCapacity,
        rounds: room.round + 1,
        votingCount: room.votingCount || 0,
        usedSpecialCards: clone(room.usedSpecialCards || []),
        finishReason: room.finishReason || "capacity_reached",
        survivalChance: calculateBunkerSurvivalChance(room),
        utilityBreakdown: clone(utilityBreakdown),
        actionLog: clone(room.actionLog || [])
    };
}

function recordFinishedGame(room) {
    if (room.historyRecorded) return;
    room.historyRecorded = true;
    gameHistoryStore.append(createGameHistoryRecord(room))
        .then(broadcastAdminHistory)
        .catch((error) => console.warn("Не удалось сохранить историю игры.", error.message));
}

function emitRoom(room) {
    io.to(room.code).emit("roomState", publicState(room));
    for (const player of room.players) {
        if (player.left) continue;
        io.to(player.id).emit("yourCards", room.cards[player.id] || {});
        io.to(player.id).emit("yourSpecialCard", room.playerSpecialCards?.[player.id] || null);
        io.to(player.id).emit("yourWeaponStatus", {
            hasWeapon: Boolean(weaponSourceForPlayer(room, player.id)),
            revealed: weaponSourceIsRevealed(room, player.id, weaponSourceForPlayer(room, player.id)),
            used: Boolean(room.playerResidentEvictions?.[player.id]),
            canEvict: (room.bunkerTraits || []).some((trait) => cleanOccupiedSlots(trait.occupiedSlots) > 0)
        });
    }
    broadcastAdminRooms();
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

function pauseTestRoom(room) {
    if (!room?.isTestRoom || room.testPaused) return false;
    const deadline = room.phase === "voting" ? room.voteDeadline : room.phase === "reveal" ? room.turnDeadline : null;
    room.testPaused = true;
    room.testPausedTimerKind = room.phase === "voting" ? "vote" : room.phase === "reveal" ? "turn" : null;
    room.testPausedRemainingMs = deadline ? Math.max(250, deadline - Date.now()) : ACTION_DURATION_MS;
    clearActionTimer(room);
    room.turnDeadline = null;
    room.voteDeadline = null;
    return true;
}

function resumeTestRoom(room) {
    if (!room?.isTestRoom || !room.testPaused) return false;
    const timerKind = room.testPausedTimerKind;
    const remaining = Math.max(250, Number(room.testPausedRemainingMs) || ACTION_DURATION_MS);
    room.testPaused = false;
    room.testPausedTimerKind = null;
    room.testPausedRemainingMs = 0;
    if (timerKind === "vote" && room.phase === "voting") {
        room.voteDeadline = Date.now() + remaining;
        room.timerKind = "vote";
        room.actionTimer = setTimeout(() => resolveVote(room, true), remaining);
    } else if (timerKind === "turn" && room.phase === "reveal") {
        room.turnDeadline = Date.now() + remaining;
        room.timerKind = "turn";
        room.actionTimer = setTimeout(() => advanceRevealTurn(room, true), remaining);
    }
    return true;
}

function scheduleBotAction(room, callback, delay) {
    const timer = setTimeout(() => {
        room.botTimers = (room.botTimers || []).filter((item) => item !== timer);
        callback();
    }, delay);
    room.botTimers = room.botTimers || [];
    room.botTimers.push(timer);
}

function endGame(room, reason = "capacity_reached") {
    if (room.phase === "finished") return;
    clearActionTimer(room);
    room.revealedAtFinish = Object.fromEntries(activePlayers(room).map((player) => [
        player.id,
        Object.keys(room.cards[player.id] || {}).filter((trait) => !Object.prototype.hasOwnProperty.call(room.revealed[player.id] || {}, trait))
    ]));
    for (const player of room.players) {
        if (!room.cards[player.id]) continue;
        room.revealed[player.id] = { ...room.cards[player.id] };
    }
    room.phase = "finished";
    room.finishedAt = Date.now();
    room.finishReason = reason;
    room.turnDeadline = null;
    room.voteDeadline = null;
    room.votes = {};
    startRematchWindow(room);
    scheduleRoomClose(room, Date.now() + FINISHED_ROOM_TTL_MS);
    const winners = activePlayers(room).map((player) => player.nickname);
    addActionLog(room, "Игра окончена — все оставшиеся характеристики раскрыты.", "reveal");
    addActionLog(room, winners.length ? "Игра завершена. В бункере остались: " + winners.join(", ") + "." : "Игра завершена. Выживших не осталось.", "finish");
    emitRoom(room);
    recordFinishedGame(room);
    io.to(room.code).emit("gameFinished", {
        survivors: winners
    });
}

function votingCandidates(room) {
    const allowed = Array.isArray(room.voteCandidateIds) ? new Set(room.voteCandidateIds) : null;
    return activePlayers(room).filter((player) => !allowed || allowed.has(player.id));
}

function openVoting(room, { candidateIds = null, slots = null, preservePending = false } = {}) {
    if (room.phase === "finished") return;
    clearActionTimer(room);
    room.phase = "voting";
    room.votes = {};
    if (!preservePending) room.pendingEliminationIds = [];
    room.voteCandidateIds = Array.isArray(candidateIds) ? [...new Set(candidateIds)] : null;
    room.eliminationsThisVote = Math.max(1, Math.min(
        Number(slots) || getEliminationsPerRound(activePlayers(room).length, room.capacity, "auto"),
        Math.max(1, activePlayers(room).length - room.capacity)
    ));
    room.votingCount = (Number(room.votingCount) || 0) + 1;
    room.turnDeadline = null;
    room.voteDeadline = Date.now() + ACTION_DURATION_MS;
    room.timerKind = "vote";
    room.actionTimer = setTimeout(() => resolveVote(room, true), ACTION_DURATION_MS);
    addActionLog(room, room.eliminationsThisVote > 1 ? `Началось голосование: в этом раунде выбывают ${room.eliminationsThisVote} игрока.` : "Началось голосование.", "vote");
    io.to(room.code).emit("votingStarted", { eliminations: room.eliminationsThisVote, runoff: Boolean(room.voteCandidateIds) });
    emitRoom(room);
    activePlayers(room).filter((player) => player.isBot).forEach((bot, index) => {
        scheduleBotAction(room, () => {
            if (room.phase !== "voting" || room.votes[bot.id]) return;
            const candidates = votingCandidates(room).filter((player) => player.id !== bot.id);
            room.votes[bot.id] = candidates.length ? randomItem(candidates).id : SKIP_VOTE;
            const target = room.players.find((player) => player.id === room.votes[bot.id]);
            addActionLog(room, room.votes[bot.id] === SKIP_VOTE ? bot.nickname + " выбирает не исключать никого." : bot.nickname + " голосует против " + target?.nickname + ".", "vote");
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
    const lastAllowedRoundIndex = room.isSoloTest ? room.traitOrder.length - 1 : room.traitOrder.length - 2;
    return room.round < Math.max(0, lastAllowedRoundIndex);
}

function voteCanBeSkipped(room) {
    if (Array.isArray(room.voteCandidateIds)) return false;
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
        if (room.round === 0 && room.traitOrder.length > 1) return startNextRound(room);
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
            const specialResult = tryBotSpecialCard(room, currentPlayer);
            if (specialResult && ["increase_capacity", "random_capacity"].includes(specialResult.action) && activePlayers(room).length <= room.capacity) {
                endGame(room, "capacity_card");
                return;
            }
            emitRoom(room);
            const trait = room.round === 0
                ? room.traitOrder[0]
                : randomItem(room.traitOrder.filter((item) => !room.revealed[currentPlayer.id]?.[item]));
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
        const availableTraits = room.traitOrder.filter((trait) => !room.revealed[playerId]?.[trait]);
        const trait = room.round === 0 ? room.traitOrder[0] : randomItem(availableTraits);
        if (player && trait && revealTraitForPlayer(room, playerId, trait)) {
            io.to(room.code).emit("turnAutoRevealed", { nickname: player.nickname, trait });
            return;
        }
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
    const professionItem = trait === "profession" ? giveProfessionItem(room, playerId) : null;
    const player = room.players.find((candidate) => candidate.id === playerId);
    addActionLog(room, player?.nickname + " раскрывает «" + (room.categoryNames?.[trait] || trait) + "»: " + room.cards[playerId][trait] + ".", "reveal");
    if (professionItem) addActionLog(room, player?.nickname + " получает в багаж: " + professionItem + ".", "item");
    emitRoom(room);
    io.to(room.code).emit("cardRevealed", {
        playerId,
        nickname: player?.nickname,
        trait
    });
    if (professionItem) {
        io.to(room.code).emit("professionItemReceived", {
            playerId,
            nickname: player?.nickname,
            item: professionItem
        });
    }
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
    if (room.round >= room.revealRounds - 1 && hasAnotherRevealRound(room)) {
        room.revealRounds = Math.min(room.traitOrder.length, room.revealRounds + 1);
    }
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
    return activePlayers(room).length > room.capacity && hasAnotherRevealRound(room);
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
        addActionLog(room, "Голосование завершено: никого не исключили.", "vote");
        io.to(room.code).emit("voteSkipped", { timedOut });
        continueWithoutElimination(room);
        return;
    }
    const eligibleCandidates = votingCandidates(room);
    const slots = Math.min(
        Math.max(1, Number(room.eliminationsThisVote) || 1),
        Math.max(0, activePlayers(room).length - room.capacity),
        eligibleCandidates.length
    );
    const ranked = eligibleCandidates
        .map((player) => ({ player, votes: totals[player.id] || 0 }))
        .sort((first, second) => second.votes - first.votes);
    const cutoffVotes = ranked[slots - 1]?.votes || 0;
    const certain = ranked.filter((entry) => entry.votes > cutoffVotes).map((entry) => entry.player.id);
    const tiedAtCutoff = ranked.filter((entry) => entry.votes === cutoffVotes).map((entry) => entry.player.id);
    const remainingSlots = Math.max(0, slots - certain.length);

    if (!highestPlayerVotes || !slots || tiedAtCutoff.length > remainingSlots) {
        if (slots > 1 && cutoffVotes > 0 && tiedAtCutoff.length > remainingSlots) {
            room.pendingEliminationIds = [...new Set([...(room.pendingEliminationIds || []), ...certain])];
            const tiedNames = tiedAtCutoff.map((id) => room.players.find((player) => player.id === id)?.nickname).filter(Boolean);
            addActionLog(room, `Ничья за ${certain.length ? "следующее" : "первое"} место между: ${tiedNames.join(", ")}.`, "vote");
            io.to(room.code).emit("voteTied", { timedOut, runoff: true, slots: remainingSlots, candidates: tiedNames });
            openVoting(room, { candidateIds: tiedAtCutoff, slots: remainingSlots, preservePending: true });
            return;
        }
        addActionLog(room, "Голоса разделились — никто не исключен.", "vote");
        io.to(room.code).emit("voteTied", { timedOut, nextRound: canOpenAnotherDeadlockRound(room) });
        room.voteCandidateIds = null;
        room.pendingEliminationIds = [];
        continueAfterDeadlock(room);
        return;
    }

    const selectedIds = [...new Set([
        ...(room.pendingEliminationIds || []),
        ...certain,
        ...tiedAtCutoff.slice(0, remainingSlots)
    ])].slice(0, Math.max(0, activePlayers(room).length - room.capacity));
    const eliminatedNames = [];
    for (const eliminatedId of selectedIds) {
        if (room.eliminated.includes(eliminatedId)) continue;
        const eliminatedPlayer = room.players.find((player) => player.id === eliminatedId);
        if (!eliminatedPlayer) continue;
        room.eliminated.push(eliminatedId);
        room.eliminationOrder = [...(room.eliminationOrder || []), eliminatedId];
        eliminatedNames.push(eliminatedPlayer.nickname);
        addActionLog(room, eliminatedPlayer.nickname + " исключён из бункера.", "out");
        io.to(room.code).emit("playerEliminated", { nickname: eliminatedPlayer.nickname });
    }
    room.voteCandidateIds = null;
    room.pendingEliminationIds = [];
    if (eliminatedNames.length > 1) io.to(room.code).emit("playersEliminated", { nicknames: eliminatedNames });
    startNextRound(room);
}

function continueAfterLeave(room, leavingId) {
    if (activePlayers(room).length === 0) {
        scheduleRoomClose(room, Date.now() + EMPTY_ROOM_TTL_MS);
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

function markPlayerLeft(room, playerId, { voluntary = false } = {}) {
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (!player || player.left) return;
    cancelPendingLeave(player);
    player.left = true;
    player.disconnected = !voluntary;
    player.voluntaryLeft = voluntary;
    delete room.revealedThisRound[playerId];
    delete room.votes[playerId];
    for (const voterId of Object.keys(room.votes)) {
        if (room.votes[voterId] === playerId) delete room.votes[voterId];
    }
}

function createEmptyRoom(code, player, payload = {}) {
    return {
        code,
        gameId: generateGameId(),
        createdAt: Date.now(),
        host: player.id,
        players: [player],
        phase: "lobby",
        capacity: 0,
        round: 0,
        disaster: null,
        disasterDuration: null,
        bunkerTraits: [],
        playerSpecialCards: {},
        healthStates: {},
        playerProfessionItems: {},
        playerExtraBaggage: {},
        playerResidentEvictions: {},
        professionItemsByProfession: {},
        cardOptionsByTrait: {},
        cards: {},
        revealed: {},
        revealedAtFinish: {},
        revealedThisRound: {},
        traitOrder: [],
        categoryNames: {},
        eliminated: [],
        eliminationOrder: [],
        votes: {},
        votingCount: 0,
        eliminationsMode: "auto",
        eliminationsThisVote: 1,
        voteCandidateIds: null,
        pendingEliminationIds: [],
        usedSpecialCards: [],
        turnOrder: [],
        turnIndex: 0,
        turnDeadline: null,
        voteDeadline: null,
        actionTimer: null,
        timerKind: null,
        botTimers: [],
        roomCloseDeadline: null,
        closeTimer: null,
        lobbyCloseDeadline: null,
        lobbyTimer: null,
        rematchDeadline: null,
        rematchReadyIds: [],
        rematchDeclinedIds: [],
        rematchResolved: false,
        rematchTimer: null,
        testPaused: false,
        testPausedTimerKind: null,
        testPausedRemainingMs: 0,
        actionLog: [],
        actionLogSequence: 0,
        visualTheme: ["amber", "radiation", "frost"].includes(payload.visualTheme) ? payload.visualTheme : "amber",
        presetId: cleanCategoryId(payload.presetId) || gameConfig.activePresetId || "classic",
        isTestRoom: Boolean(payload.isTestRoom)
    };
}

function addBotsToRoom(room, requestedCount, prefix = "Бот") {
    const slots = Math.max(0, 12 - activePlayers(room).length);
    const count = Math.min(slots, Math.max(0, Math.trunc(Number(requestedCount) || 0)));
    let botNumber = room.players.filter((player) => player.isBot).length;
    for (let index = 0; index < count; index += 1) {
        botNumber += 1;
        room.players.push({
            id: "bot_" + crypto.randomBytes(10).toString("hex"),
            token: null,
            nickname: `${prefix} ${botNumber}`,
            avatarUrl: chooseAvatar(room),
            left: false,
            isBot: true,
            isTestPlayer: room.isTestRoom
        });
    }
    return count;
}

const TEST_SNAPSHOT_FIELDS = [
    "phase", "round", "revealRounds", "capacity", "bunkerBaseCapacity", "bunkerOccupiedSlots",
    "disaster", "disasterDuration", "bunkerTraits", "cards", "healthStates", "revealed",
    "revealedAtFinish", "revealedThisRound", "eliminated", "eliminationOrder", "votes",
    "playerSpecialCards", "playerProfessionItems", "playerExtraBaggage", "playerResidentEvictions",
    "usedSpecialCards", "turnOrder", "turnIndex", "voteCandidateIds", "pendingEliminationIds",
    "eliminationsThisVote", "votingCount", "actionLog", "actionLogSequence", "finishReason", "finishedAt",
    "testPaused", "testPausedTimerKind", "testPausedRemainingMs"
];

function rememberTestState(room) {
    if (!room?.isTestRoom) return;
    const snapshot = Object.fromEntries(TEST_SNAPSHOT_FIELDS.map((field) => [field, room[field] === undefined ? null : clone(room[field])]));
    room.testSnapshots = [...(room.testSnapshots || []), snapshot].slice(-20);
}

function restorePreviousTestState(room) {
    const snapshot = room?.testSnapshots?.pop();
    if (!snapshot) return false;
    clearActionTimer(room);
    if (room.closeTimer) clearTimeout(room.closeTimer);
    room.closeTimer = null;
    room.roomCloseDeadline = null;
    Object.assign(room, snapshot);
    room.turnDeadline = null;
    room.voteDeadline = null;
    if (["reveal", "voting"].includes(room.phase)) {
        room.testPaused = true;
        room.testPausedTimerKind = room.phase === "voting" ? "vote" : "turn";
        room.testPausedRemainingMs = ACTION_DURATION_MS;
    }
    return true;
}

io.on("connection", (socket) => {
    socket.on("admin:subscribe", (payload = {}) => {
        const token = String(payload?.token || "");
        if (!hasActiveAdminSession(token)) return socket.emit("admin:unauthorized");
        socket.join(ADMIN_ROOM);
        socket.emit("admin:ready", { revision: gameConfig.revision, rooms: adminRoomSummaries(), history: gameHistoryStore.list() });
    });

    socket.on("test:createRoom", ({ nickname: rawNickname } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        if (roomFor(socket)) return emitError(socket, "Вы уже состоите в комнате.");
        const nickname = cleanNickname(rawNickname) || "Тестировщик";
        const code = generateCode();
        const player = { id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(), left: false, isBot: false, isTestPlayer: true };
        rooms[code] = createEmptyRoom(code, player, { isTestRoom: true });
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: player.token, playerId: socket.id });
        socket.emit("test:ready", { code });
        emitRoom(rooms[code]);
    });

    socket.on("test:addBots", ({ count } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase !== "lobby") return emitError(socket, "Тестовых игроков можно добавить только в тестовом лобби.");
        addBotsToRoom(room, count, "Тест-бот");
        emitRoom(room);
    });

    socket.on("test:setPlayers", ({ count } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase !== "lobby") return emitError(socket, "Количество тестовых игроков меняется только в лобби.");
        const desiredTotal = Math.max(1, Math.min(12, Math.trunc(Number(count) || 1)));
        const realPlayers = room.players.filter((player) => !player.isBot && !player.left);
        const desiredBots = Math.max(0, desiredTotal - realPlayers.length);
        const bots = room.players.filter((player) => player.isBot);
        if (bots.length > desiredBots) {
            const removeIds = new Set(bots.slice(desiredBots).map((player) => player.id));
            room.players = room.players.filter((player) => !removeIds.has(player.id));
        } else if (bots.length < desiredBots) {
            addBotsToRoom(room, desiredBots - bots.length, "Тест-бот");
        }
        emitRoom(room);
    });

    socket.on("test:start", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase !== "lobby") return emitError(socket, "Тестовую игру сейчас нельзя запустить.");
        if (activePlayers(room).length < 2) addBotsToRoom(room, 2, "Тест-бот");
        launchGame(room, false);
    });

    socket.on("test:applyHealth", ({ targetId, direction, amount } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Изменение здоровья доступно только в запущенной тестовой игре.");
        const target = room.players.find((player) => player.id === targetId) || activePlayers(room)[0];
        const trait = healthTraitId(room);
        if (!target || !trait) return emitError(socket, "В тестовой игре нет цели или характеристики здоровья.");
        rememberTestState(room);
        const state = normalizeHealthState(room.healthStates?.[target.id], room.cards?.[target.id]?.[trait]);
        const result = applyHealthStageChange(state, direction === "improve" ? "improve" : "worsen", Math.max(1, Math.min(5, Number(amount) || 1)));
        const synchronized = syncHealthCard(room, target.id, result.state);
        addActionLog(room, `[TEST] ${target.nickname}: ${synchronized.value}.`, "special");
        emitRoom(room);
        socket.emit("test:healthApplied", { targetId: target.id, value: synchronized.value, amount: result.amount });
    });

    socket.on("test:giveSpecialCard", ({ effect } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Спецкарту можно выдать только в запущенной тестовой игре.");
        const gameData = gameDataForRoom(room);
        const template = (gameData.specialCards || []).find((card) => card.effect === effect);
        if (!template) return emitError(socket, "Такая спецкарта не найдена в пресете.");
        const assigned = assignSpecialCards([{ id: socket.id }], [template], room.traitOrder, room.capacity, room.categoryNames)[socket.id];
        if (!assigned) return emitError(socket, "Эта карта несовместима с текущей тестовой игрой.");
        rememberTestState(room);
        room.playerSpecialCards[socket.id] = assigned;
        emitRoom(room);
    });

    socket.on("test:useSpecialCard", ({ effect, targetId } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || ["lobby", "finished"].includes(room.phase)) return emitError(socket, "Принудительное применение доступно только в запущенной тестовой игре.");
        const gameData = gameDataForRoom(room);
        const template = (gameData.specialCards || []).find((card) => card.effect === effect);
        if (!template) return emitError(socket, "Такая спецкарта не найдена в пресете.");
        const assigned = assignSpecialCards([{ id: socket.id }], [template], room.traitOrder, room.capacity, room.categoryNames)[socket.id];
        if (!assigned) return emitError(socket, "Эта карта несовместима с текущей тестовой игрой.");
        const needsOtherPlayer = ["swap_random_trait", "take_backpack"].includes(assigned.effect);
        const needsPlayer = needsOtherPlayer || ["improve_health", "worsen_health"].includes(assigned.effect);
        const selectedTarget = activePlayers(room).find((player) => player.id === targetId && (!needsOtherPlayer || player.id !== socket.id))
            || activePlayers(room).find((player) => !needsOtherPlayer || player.id !== socket.id);
        if (needsPlayer && !selectedTarget) return emitError(socket, "Для этой карты нет подходящей цели.");
        rememberTestState(room);
        room.playerSpecialCards[socket.id] = assigned;
        const result = useSpecialCard(room, socket.id, needsPlayer ? selectedTarget.id : null);
        if (result.error) return emitError(socket, result.error);
        const target = room.players.find((player) => player.id === result.targetId);
        room.usedSpecialCards.push({ player: room.players.find((player) => player.id === socket.id)?.nickname || "Тестировщик", target: target?.nickname || null, name: result.card.name, effect: result.action, amount: result.amount || null, result: result.value || null, at: Date.now() });
        addActionLog(room, `[TEST] Применена спецкарта «${result.card.name}»${target ? ` к ${target.nickname}` : ""}.`, "special");
        emitRoom(room);
        io.to(room.code).emit("specialCardUsed", {
            nickname: room.players.find((player) => player.id === socket.id)?.nickname,
            targetNickname: target?.nickname || null,
            cardName: result.card.name,
            trait: result.trait,
            action: result.action,
            direction: result.direction || null,
            item: result.item || null,
            capacity: result.capacity || null,
            previousCapacity: result.previousCapacity || null,
            amount: result.amount || null,
            value: result.value || null,
            alreadyHealthy: Boolean(result.alreadyHealthy)
        });
        socket.emit("test:specialApplied", { effect: result.action, amount: result.amount || null, value: result.value || null });
    });

    socket.on("test:reveal", ({ targetId, trait, automatic = false } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || ["lobby", "finished"].includes(room.phase)) return emitError(socket, "Раскрытие сейчас недоступно.");
        const target = room.players.find((player) => player.id === targetId) || activePlayers(room)[0];
        const hiddenTraits = room.traitOrder.filter((item) => !Object.prototype.hasOwnProperty.call(room.revealed?.[target?.id] || {}, item));
        const requestedTrait = hiddenTraits.includes(trait) ? trait : null;
        const firstRoundTrait = room.round === 0 ? room.traitOrder[0] : null;
        const forcedTrait = hiddenTraits.includes(firstRoundTrait) ? firstRoundTrait : null;
        const selectedTrait = requestedTrait || forcedTrait || randomItem(hiddenTraits);
        if (!target || !selectedTrait || room.cards?.[target.id]?.[selectedTrait] === undefined) return emitError(socket, "Не удалось найти тестовую карточку.");
        if (automatic && room.phase === "reveal" && currentTurnPlayerId(room) === target.id) {
            rememberTestState(room);
            if (!revealTraitForPlayer(room, target.id, selectedTrait)) return emitError(socket, "Не удалось завершить тестовый ход.");
            return;
        }
        rememberTestState(room);
        room.revealed[target.id] = room.revealed[target.id] || {};
        room.revealed[target.id][selectedTrait] = room.cards[target.id][selectedTrait];
        if (selectedTrait === "profession") giveProfessionItem(room, target.id);
        addActionLog(room, `[TEST] ${target.nickname} раскрывает «${room.categoryNames?.[selectedTrait] || selectedTrait}».`, "reveal");
        emitRoom(room);
    });

    socket.on("test:setReveal", ({ targetId, trait, revealed } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Карточки доступны после запуска тестовой игры.");
        const target = room.players.find((player) => player.id === targetId);
        if (!target || !room.traitOrder.includes(trait) || room.cards?.[target.id]?.[trait] === undefined) return emitError(socket, "Карточка не найдена.");
        rememberTestState(room);
        room.revealed[target.id] = room.revealed[target.id] || {};
        if (revealed) {
            room.revealed[target.id][trait] = room.cards[target.id][trait];
            if (trait === "profession") giveProfessionItem(room, target.id);
            addActionLog(room, `[TEST] Открыта «${room.categoryNames?.[trait] || trait}» игрока ${target.nickname}.`, "reveal");
        } else {
            delete room.revealed[target.id][trait];
            if (trait === "profession") delete room.playerProfessionItems[target.id];
            addActionLog(room, `[TEST] Скрыта «${room.categoryNames?.[trait] || trait}» игрока ${target.nickname}.`, "system");
        }
        emitRoom(room);
    });

    socket.on("test:togglePause", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || ["lobby", "finished"].includes(room.phase)) return emitError(socket, "Пауза доступна в запущенной тестовой игре.");
        rememberTestState(room);
        if (room.testPaused) resumeTestRoom(room);
        else pauseTestRoom(room);
        addActionLog(room, room.testPaused ? "[TEST] Игра поставлена на паузу." : "[TEST] Игра продолжена.", "system");
        emitRoom(room);
    });

    socket.on("test:setRound", ({ round } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Раунд можно изменить после запуска.");
        rememberTestState(room);
        room.testPaused = false;
        room.round = Math.max(0, Math.min((room.revealRounds || room.traitOrder.length || 1) - 1, Math.trunc(Number(round) || 1) - 1));
        beginRevealRound(room);
        addActionLog(room, `[TEST] Установлен раунд ${room.round + 1}.`, "system");
        emitRoom(room);
    });

    socket.on("test:setPhase", ({ phase } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Фазу можно изменить после запуска.");
        if (!["story", "reveal", "voting", "finished"].includes(phase)) return emitError(socket, "Неизвестная фаза.");
        rememberTestState(room);
        room.testPaused = false;
        room.testPausedTimerKind = null;
        room.testPausedRemainingMs = 0;
        if (phase === "story") {
            clearActionTimer(room);
            room.phase = "story";
            room.turnDeadline = null;
            room.voteDeadline = null;
            emitRoom(room);
        } else if (phase === "reveal") beginRevealRound(room);
        else if (phase === "voting") openVoting(room);
        else endGame(room, "test_forced");
    });

    socket.on("test:setTurn", ({ targetId } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Не удалось назначить ход.");
        const target = activePlayers(room).find((player) => player.id === targetId);
        if (!target) return emitError(socket, "Не удалось назначить ход.");
        rememberTestState(room);
        clearActionTimer(room);
        room.phase = "reveal";
        room.testPaused = false;
        room.turnOrder = activePlayers(room).map((player) => player.id);
        room.turnIndex = room.turnOrder.indexOf(target.id);
        delete room.revealedThisRound[target.id];
        room.turnDeadline = Date.now() + ACTION_DURATION_MS;
        room.voteDeadline = null;
        room.timerKind = "turn";
        room.actionTimer = setTimeout(() => advanceRevealTurn(room, true), ACTION_DURATION_MS);
        addActionLog(room, `[TEST] Ход передан игроку ${target.nickname}.`, "system");
        emitRoom(room);
    });

    socket.on("test:setEliminated", ({ targetId, eliminated } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        const target = room?.players.find((player) => player.id === targetId);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby" || !target) return emitError(socket, "Игрок не найден.");
        rememberTestState(room);
        if (eliminated) {
            if (!room.eliminated.includes(target.id)) room.eliminated.push(target.id);
            if (!room.eliminationOrder.includes(target.id)) room.eliminationOrder.push(target.id);
        } else {
            room.eliminated = room.eliminated.filter((id) => id !== target.id);
            room.eliminationOrder = room.eliminationOrder.filter((id) => id !== target.id);
        }
        addActionLog(room, `[TEST] ${target.nickname}: ${eliminated ? "исключён" : "возвращён в игру"}.`, eliminated ? "out" : "system");
        emitRoom(room);
    });

    socket.on("test:openVoting", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || ["lobby", "finished"].includes(room.phase)) return emitError(socket, "Голосование сейчас недоступно.");
        rememberTestState(room);
        openVoting(room);
    });

    socket.on("test:forceTie", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase !== "voting") return emitError(socket, "Сначала откройте тестовое голосование.");
        const voters = activePlayers(room);
        if (voters.length < 2) return emitError(socket, "Для ничьей нужны хотя бы два игрока.");
        rememberTestState(room);
        clearActionTimer(room);
        const candidates = votingCandidates(room);
        const tieCandidates = candidates.slice(0, voters.length % 2 === 0 ? 2 : Math.min(3, candidates.length));
        room.votes = Object.fromEntries(voters.map((voter, index) => [voter.id, tieCandidates[index % tieCandidates.length].id]));
        resolveVote(room, true);
    });

    socket.on("test:advance", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id) return emitError(socket, "Управление доступно только ведущему тестовой комнаты.");
        rememberTestState(room);
        room.testPaused = false;
        room.testPausedTimerKind = null;
        room.testPausedRemainingMs = 0;
        if (room.phase === "story") beginRevealRound(room);
        else if (room.phase === "reveal") {
            room.turnIndex = room.turnOrder.length;
            activateNextTurn(room);
        } else if (room.phase === "voting") resolveVote(room, true);
    });

    socket.on("test:eliminate", ({ targetId } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "finished") return emitError(socket, "Игрока сейчас нельзя исключить.");
        const target = activePlayers(room).find((player) => player.id === targetId && player.id !== socket.id) || activePlayers(room).find((player) => player.id !== socket.id);
        if (!target) return emitError(socket, "Нет доступной цели.");
        rememberTestState(room);
        room.eliminated.push(target.id);
        room.eliminationOrder = [...(room.eliminationOrder || []), target.id];
        addActionLog(room, `[TEST] ${target.nickname} исключён.`, "out");
        if (activePlayers(room).length <= room.capacity) endGame(room, "test_elimination");
        else emitRoom(room);
    });

    socket.on("test:setCapacity", ({ capacity } = {}) => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Вместимость сейчас нельзя изменить.");
        rememberTestState(room);
        room.capacity = Math.max(1, Math.min(activePlayers(room).length, Math.trunc(Number(capacity) || room.capacity)));
        emitRoom(room);
    });

    socket.on("test:previous", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id) return emitError(socket, "Возврат доступен только ведущему тестовой комнаты.");
        if (!restorePreviousTestState(room)) return emitError(socket, "Предыдущего тестового состояния ещё нет.");
        emitRoom(room);
    });

    socket.on("test:notify", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id) return emitError(socket, "Уведомление доступно только в тестовой комнате.");
        socket.emit("test:notification", { message: "Тестовое уведомление: очередь и ручное закрытие работают." });
    });

    socket.on("test:reset", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id) return emitError(socket, "Сброс доступен только ведущему тестовой комнаты.");
        room.eliminated = [];
        room.players.forEach((player) => { player.left = false; });
        room.gameId = generateGameId();
        room.historyRecorded = false;
        launchGame(room, false);
    });

    socket.on("test:finish", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id || room.phase === "lobby") return emitError(socket, "Тестовую игру сейчас нельзя завершить.");
        endGame(room, "test_forced");
    });

    socket.on("test:state", () => {
        if (!ENABLE_TEST_MODE) return emitError(socket, "Тестовый режим выключен.");
        const room = roomFor(socket);
        if (!room?.isTestRoom || room.host !== socket.id) return emitError(socket, "Состояние доступно только ведущему тестовой комнаты.");
        const serializableRoom = { ...room };
        delete serializableRoom.actionTimer;
        delete serializableRoom.closeTimer;
        delete serializableRoom.botTimers;
        delete serializableRoom.rematchTimer;
        delete serializableRoom.lobbyTimer;
        delete serializableRoom.testSnapshots;
        serializableRoom.players = room.players.map(({
            token: _token,
            disconnectTimer: _disconnectTimer,
            pendingLeaveTimer: _pendingLeaveTimer,
            ...player
        }) => player);
        const snapshot = clone(serializableRoom);
        socket.emit("test:state", snapshot);
    });

    socket.on("createRoom", (rawPayload = {}) => {
        const payload = typeof rawPayload === "string" ? { nickname: rawPayload } : rawPayload || {};
        const nickname = cleanNickname(payload.nickname);
        if (!nickname) return emitError(socket, "Введите никнейм.");
        if (roomFor(socket)) return emitError(socket, "Вы уже состоите в комнате.");

        const code = generateCode();
        const player = { id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(), left: false, isBot: false };
        rooms[code] = createEmptyRoom(code, player, payload);
        scheduleIdleLobbyClose(rooms[code]);
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: rooms[code].players[0].token, playerId: socket.id });
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
        if (room.players.some((player) => !player.voluntaryLeft && player.nickname.toLocaleLowerCase("ru") === nickname.toLocaleLowerCase("ru"))) {
            return emitError(socket, "Такой никнейм уже занят.");
        }
        const player = { id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(room), left: false, isBot: false };
        room.players.push(player);
        cancelIdleLobbyClose(room);
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: player.token, playerId: socket.id });
        emitRoom(room);
    });

    socket.on("resumeRoom", ({ roomCode, playerToken } = {}) => {
        const code = String(roomCode || "").trim().toUpperCase();
        const room = rooms[code];
        const token = String(playerToken || "");
        const player = room?.players.find((candidate) => !candidate.voluntaryLeft && candidate.token === token);
        if (!room || !player) return socket.emit("resumeFailed");

        movePlayerToSocket(room, player, socket.id);
        if (room.phase !== "finished" && room.closeTimer) {
            clearTimeout(room.closeTimer);
            room.closeTimer = null;
            room.roomCloseDeadline = null;
        }
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: player.token, playerId: socket.id });
        emitRoom(room);
    });

    launchGame = function launchGameRoom(room, isSoloTest = false) {
        if (room.launchInProgress) return false;
        room.launchInProgress = true;
        clearActionTimer(room);
        cancelIdleLobbyClose(room);
        if (room.closeTimer) clearTimeout(room.closeTimer);
        room.closeTimer = null;
        room.roomCloseDeadline = null;
        if (room.rematchTimer) clearTimeout(room.rematchTimer);
        room.rematchTimer = null;
        room.rematchDeadline = null;
        room.rematchReadyIds = [];
        room.rematchDeclinedIds = [];
        room.rematchResolved = false;
        room.testPaused = false;
        room.testPausedTimerKind = null;
        room.testPausedRemainingMs = 0;
        room.isSoloTest = isSoloTest;
        const gameData = gameDataForRoom(room);
        room.presetId = gameData.id || room.presetId || gameConfig.activePresetId || "classic";
        room.presetName = gameData.name || "Классический";
        room.phase = "story";
        room.startedAt = Date.now();
        room.finishedAt = null;
        room.finishReason = null;
        room.bunkerBaseCapacity = isSoloTest ? 1 : Math.max(2, Math.floor(activePlayers(room).length / 2));
        const gameCategories = enabledGameCategories(gameData);
        room.traitOrder = gameCategories.map((category) => category.id);
        room.revealRounds = isSoloTest
            ? room.traitOrder.length
            : revealRoundsFor(activePlayers(room).length, room.traitOrder.length);
        room.categoryNames = Object.fromEntries(gameCategories.map((category) => [category.id, category.name]));
        room.cardScores = Object.fromEntries(gameCategories.map((category) => [
            category.id,
            Object.fromEntries(category.options.map((option) => [option.value, option.score]))
        ]));
        room.cardOptionsByTrait = Object.fromEntries(gameCategories.map((category) => [category.id, clone(category.options)]));
        const selectedDisaster = randomItem(gameData.disasters);
        room.disaster = disasterText(selectedDisaster);
        room.disasterDuration = randomDisasterDuration(selectedDisaster);
        room.bunkerTraits = assignBunkerTraits(gameData.bunkerTraits || [], activePlayers(room).length, gameData.supplyDurations);
        room.bunkerOccupiedSlots = room.bunkerTraits.reduce((total, trait) => total + cleanOccupiedSlots(trait.occupiedSlots), 0);
        room.capacity = Math.max(1, room.bunkerBaseCapacity - room.bunkerOccupiedSlots);
        room.cards = assignCards(activePlayers(room), gameCategories, gameData.supplyDurations);
        initializeHealthStates(room);
        room.playerSpecialCards = assignSpecialCards(activePlayers(room), gameData.specialCards || [], room.traitOrder, room.capacity, room.categoryNames);
        room.playerProfessionItems = {};
        room.playerExtraBaggage = {};
        room.playerResidentEvictions = {};
        room.professionItemsByProfession = Object.fromEntries((gameCategories.find((category) => category.id === "profession")?.options || []).map((option) => [
            String(option.value || "").toLocaleLowerCase("ru"),
            option.passiveItem || ""
        ]));
        room.revealed = Object.fromEntries(activePlayers(room).map((player) => [player.id, {}]));
        room.revealedAtFinish = {};
        room.revealedThisRound = {};
        room.eliminated = [];
        room.eliminationOrder = [];
        room.votes = {};
        room.votingCount = 0;
        room.eliminationsThisVote = 1;
        room.voteCandidateIds = null;
        room.pendingEliminationIds = [];
        room.usedSpecialCards = [];
        room.round = 0;
        room.actionLog = [];
        room.actionLogSequence = 0;
        addActionLog(room, "Игра началась. Катастрофа определена.", "system");
        if (room.bunkerOccupiedSlots) {
            addActionLog(room, `Предыдущие жители заняли ${room.bunkerOccupiedSlots} ${room.bunkerOccupiedSlots === 1 ? "место" : "места"} в бункере.`, "system");
        }
        io.to(room.code).emit("gameStarted");
        emitRoom(room);
        room.launchInProgress = false;
        return true;
    };

    socket.on("startGame", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Начать игру может только ведущий.");
        if (room.phase !== "lobby") return;
        if (activePlayers(room).length < MIN_PLAYERS_TO_START) return emitError(socket, "Нужно хотя бы три игрока.");
        launchGame(room);
    });

    socket.on("acknowledgeStory", () => {
        const room = roomFor(socket);
        if (!room || room.host !== socket.id) return emitError(socket, "Начать раунд после истории может только ведущий.");
        if (room.phase !== "story") return;
        addActionLog(room, "Ведущий начинает первый раунд.", "system");
        io.to(room.code).emit("roundStarted", { initial: true });
        beginRevealRound(room);
    });

    socket.on("extendRoomClose", () => {
        const room = roomFor(socket);
        const player = room?.players.find((candidate) => candidate.id === socket.id);
        if (!room || room.phase !== "finished" || !player || player.left) {
            return emitError(socket, "Продлить время можно только после завершения этой игры.");
        }
        extendRoomClose(room);
        addActionLog(room, `${player.nickname} продлевает просмотр результатов на 30 секунд.`, "system");
        emitRoom(room);
    });

    const handleRematchReady = () => {
        const room = roomFor(socket);
        const player = room?.players.find((candidate) => candidate.id === socket.id && !candidate.left && !candidate.isBot);
        if (!room || !player) return emitError(socket, "Вы не состоите в этой комнате.");
        if (room.phase !== "finished") return emitError(socket, "Текущая партия ещё не завершена.");
        if (room.rematchResolved || !room.rematchDeadline || Date.now() >= room.rematchDeadline) return emitError(socket, "Минута на решение уже закончилась.");
        room.rematchReadyIds = [...new Set([...(room.rematchReadyIds || []), socket.id])];
        room.rematchDeclinedIds = (room.rematchDeclinedIds || []).filter((id) => id !== socket.id);
        addActionLog(room, `${player.nickname} готов сыграть ещё раз.`, "system");
        io.to(room.code).emit("rematchUpdated", { nickname: player.nickname, ready: true });
        if (!maybeFinalizeRematch(room)) emitRoom(room);
    };

    socket.on("requestRematch", handleRematchReady);
    socket.on("continueSamePlayers", handleRematchReady);

    socket.on("declineRematch", () => {
        const room = roomFor(socket);
        const player = room?.players.find((candidate) => candidate.id === socket.id && !candidate.left && !candidate.isBot);
        if (!room || !player) return emitError(socket, "Вы не состоите в этой комнате.");
        if (room.phase !== "finished" || room.rematchResolved || !room.rematchDeadline || Date.now() >= room.rematchDeadline) {
            return emitError(socket, "Сейчас нельзя изменить решение о новой игре.");
        }
        room.rematchDeclinedIds = [...new Set([...(room.rematchDeclinedIds || []), socket.id])];
        room.rematchReadyIds = (room.rematchReadyIds || []).filter((id) => id !== socket.id);
        addActionLog(room, `${player.nickname} не участвует в следующей игре.`, "system");
        io.to(room.code).emit("rematchUpdated", { nickname: player.nickname, ready: false });
        if (!maybeFinalizeRematch(room)) emitRoom(room);
    });

    socket.on("revealTrait", (requestedTrait) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "reveal" || room.eliminated.includes(socket.id)) return;
        if (currentTurnPlayerId(room) !== socket.id) return emitError(socket, "Сейчас ход другого игрока.");
        if (!revealTraitForPlayer(room, socket.id, requestedTrait)) {
            return emitError(socket, "Эту карту сейчас нельзя раскрыть.");
        }
    });

    socket.on("useBunkerWeapon", () => {
        const room = roomFor(socket);
        if (!room || room.phase !== "reveal" || room.eliminated.includes(socket.id) || currentTurnPlayerId(room) !== socket.id) {
            return emitError(socket, "Оружие можно применить только в свой ход.");
        }
        const result = useBunkerWeapon(room, socket.id);
        if (result.error) return emitError(socket, result.error);
        const player = room.players.find((candidate) => candidate.id === socket.id);
        addActionLog(room, player?.nickname + " использует оружие и выгоняет одного жителя. Мест для игроков: " + result.previousCapacity + " → " + result.capacity + ".", "item");
        if (result.revealedTrait) {
            io.to(room.code).emit("cardRevealed", {
                playerId: socket.id,
                nickname: player?.nickname,
                trait: result.revealedTrait
            });
        }
        if (activePlayers(room).length <= room.capacity) endGame(room);
        else emitRoom(room);
        io.to(room.code).emit("residentEvicted", {
            nickname: player?.nickname,
            capacity: result.capacity,
            occupiedSlots: room.bunkerOccupiedSlots
        });
    });

    socket.on("useSpecialCard", (payload) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "reveal" || room.eliminated.includes(socket.id) || currentTurnPlayerId(room) !== socket.id) {
            return emitError(socket, "Спецкарту можно применить только в свой ход.");
        }
        const specialCard = room.playerSpecialCards?.[socket.id];
        const targetId = typeof payload === "string" ? payload : payload?.targetId;
        const requiresTarget = ["swap_random_trait", "take_backpack", "improve_health", "worsen_health"].includes(specialCard?.effect);
        const allowsSelfTarget = ["improve_health", "worsen_health"].includes(specialCard?.effect);
        if (requiresTarget && ((!allowsSelfTarget && targetId === socket.id) || !activePlayers(room).some((player) => player.id === targetId))) {
            return emitError(socket, allowsSelfTarget ? "Выберите игрока, который ещё в игре." : "Выберите другого игрока, который ещё в игре.");
        }
        const result = useSpecialCard(room, socket.id, requiresTarget ? targetId : null);
        if (result.error) return emitError(socket, result.error);
        const player = room.players.find((candidate) => candidate.id === socket.id);
        const target = room.players.find((candidate) => candidate.id === (result.targetId || targetId));
        const actionLog = result.action === "take_backpack"
            ? player?.nickname + " применяет «" + result.card.name + "» и забирает «" + result.item + "» у " + target?.nickname + " в свой багаж."
            : result.action === "swap_adjacent_profession"
                ? player?.nickname + " применяет «" + result.card.name + "» и меняется профессией с соседом " + (result.direction === "left" ? "слева" : result.direction === "right" ? "справа" : "случайно") + ": " + target?.nickname + "."
            : result.action === "increase_capacity"
                ? player?.nickname + " применяет «" + result.card.name + "»: мест в бункере " + result.previousCapacity + " → " + result.capacity + "."
                : result.action === "decrease_capacity" || result.action === "random_capacity"
                    ? player?.nickname + " применяет «" + result.card.name + "»: мест в бункере " + result.previousCapacity + " → " + result.capacity + "."
                    : result.action === "reroll_own_trait"
                        ? player?.nickname + " применяет «" + result.card.name + "» и меняет «" + (room.categoryNames?.[result.trait] || result.trait) + "»."
                        : result.action === "improve_health"
                            ? player?.nickname + " применяет «" + result.card.name + "» к " + target?.nickname + ": здоровье улучшено на " + result.amount + ", итог — " + result.value + "."
                            : result.action === "worsen_health"
                                ? player?.nickname + " применяет «" + result.card.name + "» к " + target?.nickname + ": здоровье ухудшено на " + result.amount + ", итог — " + result.value + "."
                        : player?.nickname + " применяет «" + result.card.name + "» и меняется «" + (room.categoryNames?.[result.trait] || result.trait) + "» с " + target?.nickname + ".";
        addActionLog(room, actionLog, "special");
        room.usedSpecialCards = room.usedSpecialCards || [];
        room.usedSpecialCards.push({
            player: player?.nickname || "",
            target: target?.nickname || null,
            name: result.card.name,
            effect: result.action,
            amount: result.amount || null,
            result: result.value || null,
            at: Date.now()
        });
        if (["increase_capacity", "random_capacity"].includes(result.action) && result.capacity > result.previousCapacity && activePlayers(room).length <= room.capacity) endGame(room);
        else emitRoom(room);
        io.to(room.code).emit("specialCardUsed", {
            nickname: player?.nickname,
            targetNickname: target?.nickname || null,
            cardName: result.card.name,
            trait: result.trait,
            action: result.action,
            direction: result.direction || null,
            item: result.item || null,
            capacity: result.capacity || null,
            previousCapacity: result.previousCapacity || null,
            amount: result.amount || null,
            value: result.value || null,
            alreadyHealthy: Boolean(result.alreadyHealthy)
        });
    });

    socket.on("castVote", (targetId) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "voting" || room.eliminated.includes(socket.id)) return;
        if (!activePlayers(room).some((player) => player.id === targetId)) return emitError(socket, "Выберите игрока, который ещё в игре.");
        if (Array.isArray(room.voteCandidateIds) && !room.voteCandidateIds.includes(targetId)) return emitError(socket, "В переголосовании можно выбрать только одного из спорных кандидатов.");
        if (targetId === socket.id) return emitError(socket, "Нельзя голосовать за себя.");
        if (room.votes[socket.id]) return emitError(socket, "Ваш голос уже принят.");
        room.votes[socket.id] = targetId;
        addActionLog(room, room.players.find((player) => player.id === socket.id)?.nickname + " голосует против " + room.players.find((player) => player.id === targetId)?.nickname + ".", "vote");
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
        addActionLog(room, room.players.find((player) => player.id === socket.id)?.nickname + " выбирает не исключать никого.", "vote");
        socket.emit("voteAccepted");
        emitRoom(room);
        resolveVote(room);
    });

    socket.on("closeLobby", () => {
        const room = roomFor(socket);
        if (!room || room.phase !== "lobby") return emitError(socket, "Закрыть можно только открытое лобби.");
        if (room.host !== socket.id) return emitError(socket, "Закрыть лобби может только ведущий.");
        io.to(room.code).emit("lobbyClosed", { reason: "Ведущий закрыл лобби." });
        closeRoom(room, false);
    });

    socket.on("leaveRoom", () => {
        const room = roomFor(socket);
        if (!room) return socket.emit("leftRoom");
        socket.leave(room.code);
        markPlayerLeft(room, socket.id, { voluntary: true });
        continueAfterLeave(room, socket.id);
        socket.emit("leftRoom");
    });

    socket.on("disconnect", () => {
        const room = roomFor(socket);
        if (!room) return;
        schedulePendingLeave(room, socket.id);
    });
});

Promise.all([
    initializeGameConfig(),
    gameHistoryStore.initialize().then(() => {
        const storedGames = gameHistoryStore.list();
        nextGameId = storedGames.length ? gameHistoryStore.maxNumericId() + 1 : 0;
    })
]).catch((error) => {
    console.warn("Не удалось полностью инициализировать внешнее хранилище. Сервер продолжит работу с локальными данными.", error.message);
}).finally(() => {
    server.listen(process.env.PORT || 3000, () => {
        console.log(`Bunker started on http://localhost:${process.env.PORT || 3000}`);
        if (!process.env.ADMIN_PASSWORD) {
            console.warn("Админка использует временный пароль simik. Перед публикацией задайте ADMIN_PASSWORD.");
        }
    });
});
