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
    backpack: ["аптечка и набор лекарств", "набор инструментов", "семена овощей", "солнечная батарея", "палатка и спальник", "рация", "фильтр для воды", "запас кофе", "генератор на педалях", "дрон", "ящик консервов", "тёплая одежда", "оружие"],
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
const BUNKER_TRAITS_SEED_VERSION = 1;
const BACKPACK_WEAPON_SEED_VERSION = 1;
const WATER_TRAIT_LABEL_SEED_VERSION = 1;
const WATER_OPTIONS_SEED_VERSION = 1;
const WATER_RANDOM_PERCENT_SEED_VERSION = 1;
const BACKPACK_WATER_SEED_VERSION = 1;
const GENDER_OPTIONS_SEED_VERSION = 1;
const DISASTER_DURATION_SEED_VERSION = 1;
const CONTENT_FILL_SEED_VERSION = 1;
const WEAPON_BACKPACK_OPTION = { value: "Оружие", score: 70, chance: 10 };
const WATER_BACKPACK_OPTIONS = [
    { value: "Запас питьевой воды на 3 дня", score: 72, chance: 8 },
    { value: "Канистры воды на 2 недели", score: 84, chance: 7 },
    { value: "Запас питьевой воды на месяц", score: 94, chance: 5 }
];
const DEFAULT_GENDER_CATEGORY = {
    id: "gender",
    name: "Пол",
    options: [
        { value: "Мужчина", score: 50, chance: 50 },
        { value: "Женщина", score: 50, chance: 50 }
    ]
};
const DEFAULT_BUNKER_TRAITS = [
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
    }],
    disasters: DISASTERS,
    bunkerTraits: DEFAULT_BUNKER_TRAITS,
    bunkerTraitsSeedVersion: BUNKER_TRAITS_SEED_VERSION,
    backpackWeaponSeedVersion: BACKPACK_WEAPON_SEED_VERSION,
    waterTraitLabelSeedVersion: WATER_TRAIT_LABEL_SEED_VERSION,
    waterOptionsSeedVersion: WATER_OPTIONS_SEED_VERSION,
    waterRandomPercentSeedVersion: WATER_RANDOM_PERCENT_SEED_VERSION,
    backpackWaterSeedVersion: BACKPACK_WATER_SEED_VERSION,
    genderOptionsSeedVersion: GENDER_OPTIONS_SEED_VERSION,
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
            id: "take_backpack",
            name: "Забрать карточку рюкзака",
            description: "Один раз заберите предмет из рюкзака выбранного игрока и добавьте его в свой багаж.",
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
    if (/(врач|фельдшер|медик|ветеринар)/.test(text)) return "аптечка и запас лекарств";
    if (/(электрик|энергетик|инженер|электронщик)/.test(text)) return "мультитул и запас предохранителей";
    if (/(фермер|агроном|садовод)/.test(text)) return "семена и мини-набор для выращивания";
    if (/(повар|кондитер)/.test(text)) return "набор сухих пайков";
    if (/(строител|сварщик)/.test(text)) return "ремонтный набор";
    if (/(механик|автомеханик)/.test(text)) return "набор инструментов";
    if (/(программист|радист|связист)/.test(text)) return "рация и набор для связи";
    if (/(психолог|учител)/.test(text)) return "набор для коммуникации с группой";
    return "";
}

function bunkerTraitMatchesDefault(trait, defaultTrait) {
    const text = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
    const aliases = {
        water: ["water", "вод", "вокд"],
        food: ["food", "ед", "пищ"],
        electricity: ["electric", "электр", "свет"],
        ventilation: ["ventilat", "вентил"],
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
    return {
        config: {
            ...source,
            bunkerTraits: [...existing, ...clone(missing)],
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
    if (/gender|\bsex\b|пол\b/.test(hint)) return "gender";
    if (/age|возраст/.test(hint)) return "age";
    if (/body|телослож/.test(hint)) return "body";
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
        gender: [["Мужчина", 50], ["Женщина", 50]],
        age: [["18 лет", 60], ["25 лет", 82], ["34 года", 86], ["42 года", 78], ["55 лет", 62], ["68 лет", 35]],
        body: [["Атлетическое телосложение", 88], ["Крепкое телосложение", 82], ["Среднее телосложение", 58], ["Худощавое телосложение", 54], ["После травмы колена", 30], ["Выносливый", 85]],
        family: [["Один, без иждивенцев", 75], ["Есть младшая сестра", 56], ["Ухаживает за пожилой мамой", 42], ["Семья в другом городе", 62], ["Есть маленький ребёнок", 45], ["Сирота", 65]],
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
    if (/water|вод|вокд/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "water").options);
    if (/food|ед|пищ/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "food").options);
    if (/electric|электр|свет/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "electricity").options);
    if (/ventilat|вентил/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "ventilation").options);
    if (/previous|предыдущ|жител|бомж/.test(hint)) return clone(DEFAULT_BUNKER_TRAITS.find((item) => item.id === "previous_residents").options);
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

function isGenderCategory(category) {
    const id = String(category?.id || "").toLocaleLowerCase("ru");
    const name = String(category?.name || "").toLocaleLowerCase("ru").trim();
    return id === "gender" || name === "пол";
}

function seedNormalGenderOptions(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    if (Number(source.genderOptionsSeedVersion) >= GENDER_OPTIONS_SEED_VERSION) {
        return { config: source, changed: false };
    }
    const categories = Array.isArray(source.categories) ? clone(source.categories) : [];
    const genderIndex = categories.findIndex(isGenderCategory);
    if (genderIndex < 0) {
        categories.push(clone(DEFAULT_GENDER_CATEGORY));
    } else {
        categories[genderIndex] = {
            ...categories[genderIndex],
            name: "Пол",
            options: clone(DEFAULT_GENDER_CATEGORY.options),
            values: undefined
        };
    }
    return {
        config: {
            ...source,
            categories,
            genderOptionsSeedVersion: GENDER_OPTIONS_SEED_VERSION
        },
        changed: true
    };
}

function seedGameConfig(rawConfig) {
    const bunkerSeed = seedDefaultBunkerTraits(rawConfig);
    const waterLabelSeed = seedWaterTraitLabel(bunkerSeed.config);
    const waterOptionsSeed = seedRandomWaterOptions(waterLabelSeed.config);
    const waterPercentageSeed = seedRandomWaterPercentage(waterOptionsSeed.config);
    const contentSeed = seedPlaceholderContent(waterPercentageSeed.config);
    const backpackSeed = seedBackpackWeapon(contentSeed.config);
    const backpackWaterSeed = seedBackpackWater(backpackSeed.config);
    const genderSeed = seedNormalGenderOptions(backpackWaterSeed.config);
    const disasterSeed = seedDisasterDurations(genderSeed.config);
    return {
        config: disasterSeed.config,
        changed: bunkerSeed.changed || waterLabelSeed.changed || waterOptionsSeed.changed || waterPercentageSeed.changed || backpackSeed.changed || backpackWaterSeed.changed || genderSeed.changed || disasterSeed.changed || contentSeed.changed
    };
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
        return { id, name, options, randomPercentage: Boolean(trait?.randomPercentage) };
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
        const effect = /увелич|добав.*(?:мест|слот)|расшир/.test(hint)
            ? "increase_capacity"
            : /уменьш|отнят|убрат.*(?:мест|слот)|сократ/.test(hint)
                ? "decrease_capacity"
                : /размер.*бункер|бункер.*размер|измен.*(?:мест|слот)/.test(hint)
                    ? "random_capacity"
                    : /перерол|зарандом|рандом.*сво|измен.*сво.*характер/.test(hint)
                        ? "reroll_own_trait"
                        : card?.effect === "take_backpack"
                            ? "take_backpack"
                            : ["increase_capacity", "decrease_capacity", "random_capacity", "reroll_own_trait"].includes(card?.effect)
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
            .filter((url) => /^\/assets\/avatars\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(url))
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
    const backpackWaterSeedVersion = Number(rawConfig?.backpackWaterSeedVersion) >= BACKPACK_WATER_SEED_VERSION
        ? BACKPACK_WATER_SEED_VERSION
        : 0;
    const genderOptionsSeedVersion = Number(rawConfig?.genderOptionsSeedVersion) >= GENDER_OPTIONS_SEED_VERSION
        ? GENDER_OPTIONS_SEED_VERSION
        : 0;
    const disasterDurationSeedVersion = Number(rawConfig?.disasterDurationSeedVersion) >= DISASTER_DURATION_SEED_VERSION
        ? DISASTER_DURATION_SEED_VERSION
        : 0;
    const contentFillSeedVersion = Number(rawConfig?.contentFillSeedVersion) >= CONTENT_FILL_SEED_VERSION
        ? CONTENT_FILL_SEED_VERSION
        : 0;
    return { categories: otherCategories, disasters, bunkerTraits, bunkerTraitsSeedVersion, backpackWeaponSeedVersion, waterTraitLabelSeedVersion, waterOptionsSeedVersion, waterRandomPercentSeedVersion, backpackWaterSeedVersion, genderOptionsSeedVersion, disasterDurationSeedVersion, contentFillSeedVersion, specialCards, hiddenAvatars, revision };
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

function assignCards(players, categories) {
    return Object.fromEntries(players.map((player) => [
        player.id,
        Object.fromEntries(categories.map((category) => {
            const option = pickWeightedOption(category.options);
            return [category.id, category.id === "profession" ? option + " — " + randomItem(PROFESSION_RANKS) : option];
        }))
    ]));
}

function isPreviousResidentsTrait(trait) {
    const hint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
    return /previous|предыдущ|жител|бомж/.test(hint);
}

function assignBunkerTraits(traits, playerCount) {
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
        const emptyResidentOptions = isPreviousResidentsTrait(trait) && playerCount < 6
            ? trait.options.filter((option) => cleanOccupiedSlots(option?.occupiedSlots) === 0)
            : null;
        const option = emptyResidentOptions?.length
            ? pickWeightedEntry(emptyResidentOptions)
            : emptyResidentOptions
                ? { value: "Бункер пуст", occupiedSlots: 0 }
                : pickWeightedEntry(trait.options);
        return {
            id: trait.id,
            name: trait.name,
            value: option.value,
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

function useBunkerWeapon(room, playerId) {
    if (room.playerResidentEvictions?.[playerId]) return { error: "Этим оружием уже выгнали жителя." };
    const source = weaponSourceForPlayer(room, playerId);
    if (!source) return { error: "Чтобы выгнать жителя, в вашем багаже должно быть оружие." };
    const residentsTrait = (room.bunkerTraits || []).find((trait) => cleanOccupiedSlots(trait.occupiedSlots) > 0);
    if (!residentsTrait) return { error: "В бункере нет жителей, которые занимают места." };

    const wasRevealed = Boolean(room.revealed?.[playerId]?.[source.trait]);
    if (source.type === "backpack") {
        room.revealed[playerId] = room.revealed[playerId] || {};
        room.revealed[playerId][source.trait] = source.item;
    }
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
        capacity: room.capacity,
        revealedTrait: source.type === "backpack" && !wasRevealed ? source.trait : null
    };
}

function assignSpecialCards(players, specialCards, traitOrder) {
    const exchangeTraits = traitOrder.filter((trait) => !["profession", "backpack"].includes(trait));
    const rerollTraits = traitOrder.filter((trait) => trait !== "profession");
    const usableCards = specialCards.filter((card) => (
        card.effect === "swap_random_trait" ? exchangeTraits.length > 0
            : card.effect === "take_backpack" ? traitOrder.includes("backpack")
                : card.effect === "reroll_own_trait" ? rerollTraits.length > 0
                    : ["increase_capacity", "decrease_capacity", "random_capacity"].includes(card.effect)
    ));
    if (!usableCards.length) return {};
    return Object.fromEntries(players.map((player) => {
        const card = clone(randomItem(usableCards));
        card.trait = card.effect === "swap_random_trait" ? randomItem(exchangeTraits)
            : card.effect === "reroll_own_trait" ? randomItem(rerollTraits)
                : card.effect === "take_backpack" ? "backpack" : null;
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
const FINISHED_ROOM_TTL_MS = 5 * 60_000;
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

function closeRoom(room, notifyPlayers = true) {
    if (!room || rooms[room.code] !== room) return;
    clearActionTimer(room);
    if (room.closeTimer) clearTimeout(room.closeTimer);
    room.closeTimer = null;
    for (const player of room.players) cancelPendingLeave(player);
    if (notifyPlayers) io.to(room.code).emit("roomExpired");
    delete rooms[room.code];
}

function movePlayerToSocket(room, player, socketId) {
    const previousId = player.id;
    cancelPendingLeave(player);
    if (previousId === socketId) return;

    player.id = socketId;
    if (room.host === previousId) room.host = socketId;
    room.turnOrder = (room.turnOrder || []).map((id) => id === previousId ? socketId : id);
    room.eliminated = (room.eliminated || []).map((id) => id === previousId ? socketId : id);

    for (const record of [room.cards, room.revealed, room.revealedThisRound, room.revealedAtFinish, room.playerSpecialCards, room.playerProfessionItems, room.playerExtraBaggage, room.playerResidentEvictions]) {
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
    const configuredScore = room.cardScores?.[trait]?.[trait === "profession" ? professionBase(value) : value];
    return cleanScore(configuredScore, defaultOptionScore(trait, value));
}

function giveProfessionItem(room, playerId) {
    const profession = professionBase(room.revealed[playerId]?.profession || "").toLocaleLowerCase("ru");
    const item = room.professionItemsByProfession?.[profession];
    if (!item) return null;
    room.playerProfessionItems[playerId] = item;
    return item;
}

function useSpecialCard(room, playerId, targetId) {
    const specialCard = room.playerSpecialCards?.[playerId];
    if (!specialCard || specialCard.used) return { error: "Эта спецкарта уже использована." };
    if (!["swap_random_trait", "take_backpack", "increase_capacity", "decrease_capacity", "random_capacity", "reroll_own_trait"].includes(specialCard.effect)) return { error: "Неизвестный эффект спецкарты." };
    if (!room.cards[playerId]) return { error: "Не удалось найти ваши карточки." };

    if (specialCard.effect === "increase_capacity") {
        const previousCapacity = room.capacity;
        room.capacity = Math.min(activePlayers(room).length, room.capacity + 1);
        if (room.capacity === previousCapacity) return { error: "В бункере уже достаточно мест для всех оставшихся игроков." };
        specialCard.used = true;
        return { card: specialCard, action: specialCard.effect, previousCapacity, capacity: room.capacity };
    }

    if (specialCard.effect === "decrease_capacity") {
        const previousCapacity = room.capacity;
        room.capacity = Math.max(1, room.capacity - 1);
        if (room.capacity === previousCapacity) return { error: "Нельзя уменьшить бункер меньше чем до одного места." };
        specialCard.used = true;
        return { card: specialCard, action: specialCard.effect, previousCapacity, capacity: room.capacity };
    }

    if (specialCard.effect === "random_capacity") {
        const previousCapacity = room.capacity;
        const canIncrease = room.capacity < activePlayers(room).length;
        const canDecrease = room.capacity > 1;
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
        const differentOptions = options.filter((option) => option.value !== previousValue);
        const nextValue = pickWeightedOption(differentOptions.length ? differentOptions : options);
        if (!nextValue) return { error: "Для этой характеристики не хватает вариантов." };
        room.cards[playerId][specialCard.trait] = nextValue;
        if (Object.prototype.hasOwnProperty.call(room.revealed[playerId] || {}, specialCard.trait)) {
            room.revealed[playerId][specialCard.trait] = nextValue;
        }
        specialCard.used = true;
        return { card: specialCard, trait: specialCard.trait, action: specialCard.effect, previousValue, value: nextValue };
    }

    if (!room.traitOrder.includes(specialCard.trait) || !room.cards[targetId]) return { error: "Не удалось найти карточки выбранного игрока." };

    const myValue = room.cards[playerId][specialCard.trait];
    const targetValue = room.cards[targetId][specialCard.trait];
    if (myValue === undefined || targetValue === undefined) return { error: "Этой характеристики нет у выбранного игрока." };

    if (specialCard.effect === "take_backpack") {
        if (targetValue === "рюкзак забран") return { error: "У этого игрока уже забрали предмет из рюкзака." };
        room.playerExtraBaggage = room.playerExtraBaggage || {};
        room.playerExtraBaggage[playerId] = [...(room.playerExtraBaggage[playerId] || []), targetValue];
        room.cards[targetId][specialCard.trait] = "рюкзак забран";
        if (Object.prototype.hasOwnProperty.call(room.revealed[targetId] || {}, specialCard.trait)) {
            room.revealed[targetId][specialCard.trait] = room.cards[targetId][specialCard.trait];
        }
        specialCard.used = true;
        specialCard.targetId = targetId;
        specialCard.item = targetValue;
        return { card: specialCard, trait: specialCard.trait, action: specialCard.effect, item: targetValue };
    }

    room.cards[playerId][specialCard.trait] = targetValue;
    room.cards[targetId][specialCard.trait] = myValue;
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

function calculateUtilityBreakdown(room) {
    const players = activePlayers(room);
    return players.map((player) => {
        let totalScore = 0;
        let revealedCards = 0;
        for (const [trait, value] of Object.entries(room.revealed[player.id] || {})) {
            totalScore += scoreRevealedCard(room, trait, value);
            revealedCards += 1;
        }
        return {
            playerId: player.id,
            utility: revealedCards ? Math.round(totalScore / revealedCards) : 0,
            totalScore,
            revealedCards
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

function publicState(room) {
    const currentTrait = room.phase === "reveal" && room.round === 0 ? room.traitOrder?.[0] || null : null;
    const voteMarkers = Object.entries(room.votes || {}).reduce((markers, [voterId, targetId]) => {
        if (targetId === SKIP_VOTE) return markers;
        if (!markers[targetId]) markers[targetId] = [];
        markers[targetId].push(voterId);
        return markers;
    }, {});
    return {
        code: room.code,
        hostId: room.host,
        phase: room.phase,
        disaster: room.disaster,
        disasterDuration: room.disasterDuration || null,
        round: room.round + 1,
        revealRounds: room.revealRounds || Math.max(1, room.traitOrder?.length || 1),
        currentTrait,
        categoryOrder: room.traitOrder || gameConfig.categories.map((category) => category.id),
        categoryNames: room.categoryNames || Object.fromEntries(gameConfig.categories.map((category) => [category.id, category.name])),
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
        voteCanBeSkipped: voteCanBeSkipped(room),
        bunkerSurvivalChance: room.phase === "finished" ? calculateBunkerSurvivalChance(room) : null,
        utilityBreakdown: room.phase === "finished"
            ? calculateUtilityBreakdown(room).map(({ playerId, utility, revealedCards }) => ({ playerId, utility, revealedCards }))
            : [],
        roomCloseDeadline: room.roomCloseDeadline || null,
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
            usedSpecialCard: room.playerSpecialCards?.[player.id]?.used
                ? { name: room.playerSpecialCards[player.id].name }
                : null
        }))
    };
}

function emitRoom(room) {
    io.to(room.code).emit("roomState", publicState(room));
    for (const player of room.players) {
        if (player.left) continue;
        io.to(player.id).emit("yourCards", room.cards[player.id] || {});
        io.to(player.id).emit("yourSpecialCard", room.playerSpecialCards?.[player.id] || null);
        io.to(player.id).emit("yourWeaponStatus", {
            hasWeapon: Boolean(weaponSourceForPlayer(room, player.id)),
            used: Boolean(room.playerResidentEvictions?.[player.id]),
            canEvict: (room.bunkerTraits || []).some((trait) => cleanOccupiedSlots(trait.occupiedSlots) > 0)
        });
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
    room.turnDeadline = null;
    room.voteDeadline = null;
    room.votes = {};
    room.roomCloseDeadline = Date.now() + FINISHED_ROOM_TTL_MS;
    room.closeTimer = setTimeout(() => closeRoom(room), FINISHED_ROOM_TTL_MS);
    const winners = activePlayers(room).map((player) => player.nickname);
    addActionLog(room, "Игра окончена — все оставшиеся характеристики раскрыты.", "reveal");
    addActionLog(room, winners.length ? "Игра завершена. В бункере остались: " + winners.join(", ") + "." : "Игра завершена. Выживших не осталось.", "finish");
    emitRoom(room);
    io.to(room.code).emit("gameFinished", {
        survivors: winners
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
    addActionLog(room, "Началось голосование.", "vote");
    io.to(room.code).emit("votingStarted");
    emitRoom(room);
    activePlayers(room).filter((player) => player.isBot).forEach((bot, index) => {
        scheduleBotAction(room, () => {
            if (room.phase !== "voting" || room.votes[bot.id]) return;
            const otherBots = activePlayers(room).filter((player) => player.isBot && player.id !== bot.id);
            room.votes[bot.id] = otherBots.length ? randomItem(otherBots).id : SKIP_VOTE;
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
        addActionLog(room, "Голосование завершено: никого не исключили.", "vote");
        io.to(room.code).emit("voteSkipped", { timedOut });
        continueWithoutElimination(room);
        return;
    }
    const candidates = voters.filter((player) => totals[player.id] === highestPlayerVotes);
    if (!highestPlayerVotes || candidates.length !== 1) {
        addActionLog(room, "Голоса разделились — никто не исключен.", "vote");
        io.to(room.code).emit("voteTied", { timedOut, nextRound: canOpenAnotherDeadlockRound(room) });
        continueAfterDeadlock(room);
        return;
    }

    const eliminatedId = candidates[0].id;
    const eliminatedPlayer = room.players.find((player) => player.id === eliminatedId);

    room.eliminated.push(eliminatedId);
    addActionLog(room, eliminatedPlayer.nickname + " исключён из бункера.", "out");
    io.to(room.code).emit("playerEliminated", { nickname: eliminatedPlayer.nickname });
    startNextRound(room);
}

function continueAfterLeave(room, leavingId) {
    if (activePlayers(room).length === 0) {
        closeRoom(room, false);
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
            disasterDuration: null,
            bunkerTraits: [],
            playerSpecialCards: {},
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
            votes: {},
            turnOrder: [],
            turnIndex: 0,
            turnDeadline: null,
            voteDeadline: null,
            actionTimer: null,
            timerKind: null,
            botTimers: [],
            roomCloseDeadline: null,
            closeTimer: null,
            actionLog: [],
            actionLogSequence: 0
        };
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
        if (room.players.some((player) => !player.left && player.nickname.toLocaleLowerCase("ru") === nickname.toLocaleLowerCase("ru"))) {
            return emitError(socket, "Такой никнейм уже занят.");
        }
        const player = { id: socket.id, token: newPlayerToken(), nickname, avatarUrl: chooseAvatar(room), left: false, isBot: false };
        room.players.push(player);
        socket.join(code);
        socket.emit("roomEntered", { code, playerToken: player.token, playerId: socket.id });
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
        socket.emit("roomEntered", { code, playerToken: player.token, playerId: socket.id });
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
        room.bunkerBaseCapacity = isSoloTest ? 1 : Math.max(2, Math.floor(activePlayers(room).length / 2));
        room.traitOrder = gameConfig.categories.map((category) => category.id);
        room.revealRounds = isSoloTest
            ? room.traitOrder.length
            : revealRoundsFor(activePlayers(room).length, room.traitOrder.length);
        room.categoryNames = Object.fromEntries(gameConfig.categories.map((category) => [category.id, category.name]));
        room.cardScores = Object.fromEntries(gameConfig.categories.map((category) => [
            category.id,
            Object.fromEntries(category.options.map((option) => [option.value, option.score]))
        ]));
        room.cardOptionsByTrait = Object.fromEntries(gameConfig.categories.map((category) => [category.id, clone(category.options)]));
        const selectedDisaster = randomItem(gameConfig.disasters);
        room.disaster = disasterText(selectedDisaster);
        room.disasterDuration = disasterDuration(selectedDisaster);
        room.bunkerTraits = assignBunkerTraits(gameConfig.bunkerTraits || [], activePlayers(room).length);
        room.bunkerOccupiedSlots = room.bunkerTraits.reduce((total, trait) => total + cleanOccupiedSlots(trait.occupiedSlots), 0);
        room.capacity = Math.max(1, room.bunkerBaseCapacity - room.bunkerOccupiedSlots);
        room.cards = assignCards(activePlayers(room), gameConfig.categories);
        room.playerSpecialCards = assignSpecialCards(activePlayers(room), gameConfig.specialCards || [], room.traitOrder);
        room.playerProfessionItems = {};
        room.playerExtraBaggage = {};
        room.playerResidentEvictions = {};
        room.professionItemsByProfession = Object.fromEntries((gameConfig.categories.find((category) => category.id === "profession")?.options || []).map((option) => [
            String(option.value || "").toLocaleLowerCase("ru"),
            option.passiveItem || ""
        ]));
        room.revealed = Object.fromEntries(activePlayers(room).map((player) => [player.id, {}]));
        room.revealedAtFinish = {};
        room.revealedThisRound = {};
        room.eliminated = [];
        room.votes = {};
        room.round = 0;
        room.actionLog = [];
        room.actionLogSequence = 0;
        addActionLog(room, "Игра началась. Катастрофа определена.", "system");
        if (room.bunkerOccupiedSlots) {
            addActionLog(room, `Предыдущие жители заняли ${room.bunkerOccupiedSlots} ${room.bunkerOccupiedSlots === 1 ? "место" : "места"} в бункере.`, "system");
        }
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
        addActionLog(room, "Ведущий начинает первый раунд.", "system");
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

    socket.on("useSpecialCard", (targetId) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "reveal" || room.eliminated.includes(socket.id) || currentTurnPlayerId(room) !== socket.id) {
            return emitError(socket, "Спецкарту можно применить только в свой ход.");
        }
        const specialCard = room.playerSpecialCards?.[socket.id];
        const requiresTarget = ["swap_random_trait", "take_backpack"].includes(specialCard?.effect);
        if (requiresTarget && (targetId === socket.id || !activePlayers(room).some((player) => player.id === targetId))) {
            return emitError(socket, "Выберите другого игрока, который ещё в игре.");
        }
        const result = useSpecialCard(room, socket.id, requiresTarget ? targetId : null);
        if (result.error) return emitError(socket, result.error);
        const player = room.players.find((candidate) => candidate.id === socket.id);
        const target = room.players.find((candidate) => candidate.id === targetId);
        const actionLog = result.action === "take_backpack"
            ? player?.nickname + " применяет «" + result.card.name + "» и забирает «" + result.item + "» у " + target?.nickname + " в свой багаж."
            : result.action === "increase_capacity"
                ? player?.nickname + " применяет «" + result.card.name + "»: мест в бункере " + result.previousCapacity + " → " + result.capacity + "."
                : result.action === "decrease_capacity" || result.action === "random_capacity"
                    ? player?.nickname + " применяет «" + result.card.name + "»: мест в бункере " + result.previousCapacity + " → " + result.capacity + "."
                    : result.action === "reroll_own_trait"
                        ? player?.nickname + " применяет «" + result.card.name + "» и меняет «" + (room.categoryNames?.[result.trait] || result.trait) + "»."
                        : player?.nickname + " применяет «" + result.card.name + "» и меняется «" + (room.categoryNames?.[result.trait] || result.trait) + "» с " + target?.nickname + ".";
        addActionLog(room, actionLog, "special");
        if (["increase_capacity", "random_capacity"].includes(result.action) && result.capacity > result.previousCapacity && activePlayers(room).length <= room.capacity) endGame(room);
        else emitRoom(room);
        io.to(room.code).emit("specialCardUsed", {
            nickname: player?.nickname,
            targetNickname: target?.nickname || null,
            cardName: result.card.name,
            trait: result.trait,
            action: result.action,
            item: result.item || null,
            capacity: result.capacity || null,
            previousCapacity: result.previousCapacity || null
        });
    });

    socket.on("castVote", (targetId) => {
        const room = roomFor(socket);
        if (!room || room.phase !== "voting" || room.eliminated.includes(socket.id)) return;
        if (!activePlayers(room).some((player) => player.id === targetId)) return emitError(socket, "Выберите игрока, который ещё в игре.");
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
