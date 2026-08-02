const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "bunker-admin-token";
const THEME_STORAGE_KEY = "bunker-color-theme";
const COLOR_THEMES = [
    { id: "amber", label: "Янтарь", icon: "☀", color: "#f1a84e" },
    { id: "radiation", label: "Радиация", icon: "☢", color: "#7ee58d" },
    { id: "frost", label: "Ночной лёд", icon: "✦", color: "#8abaff" }
];
let config = null;
let avatars = [];
let hiddenAvatars = [];
let adminSocket = null;
let isDirty = false;
let pendingRemoteConfig = null;
let adminRooms = [];
let selectedAdminGameId = "";
let adminHistory = [];
let selectedHistoryGameId = "";

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function applyColorTheme(themeId) {
    const theme = COLOR_THEMES.find((item) => item.id === themeId) || COLOR_THEMES[0];
    document.documentElement.dataset.theme = theme.id === "amber" ? "" : theme.id;
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    $("#themeIcon").textContent = theme.icon;
    $("#themeToggle").setAttribute("aria-label", `Тема: ${theme.label}. Открыть выбор темы.`);
    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
        button.classList.toggle("is-active", button.dataset.themeChoice === theme.id);
    });
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.color);
}

function closeThemeMenu() {
    $("#themeMenu").classList.add("hidden");
    $("#themeToggle").setAttribute("aria-expanded", "false");
}

function toggleThemeMenu() {
    const menu = $("#themeMenu");
    const willOpen = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !willOpen);
    $("#themeToggle").setAttribute("aria-expanded", String(willOpen));
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function gamePhaseLabel(phase) {
    return ({ lobby: "Лобби", story: "История", reveal: "Раскрытие", voting: "Голосование", finished: "Итоги" })[phase] || "Подготовка";
}

function formatGameTime(value) {
    const date = Number(value) ? new Date(Number(value)) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—";
}

function adminPlayerAvatar(player) {
    const firstLetter = String(player?.nickname || "?").trim().charAt(0).toUpperCase() || "?";
    return `<span class="admin-game-player-avatar">${player?.avatarUrl ? `<img src="${escapeHtml(player.avatarUrl)}" alt="">` : escapeHtml(firstLetter)}</span>`;
}

function renderAdminGameDetails(room, state) {
    if (!room || !state) {
        $("#adminGameDetails").classList.add("hidden");
        $("#adminGameDetails").innerHTML = "";
        return;
    }
    const currentPlayer = state.players?.find((player) => player.id === state.turnPlayerId)?.nickname || room.currentPlayer || "—";
    const players = Array.isArray(state.players) ? state.players : [];
    const bunkerTraits = Array.isArray(state.bunkerTraits) && state.bunkerTraits.length
        ? state.bunkerTraits.map((trait) => `${trait.name}: ${trait.value}`).join(" · ")
        : "ещё не выбраны";
    $("#adminGameDetails").innerHTML = `
        <div class="admin-game-details-top"><div><p class="eyebrow">ПРОСМОТР ИГРЫ</p><h3>Игра №${escapeHtml(room.gameId)}</h3><p>Код комнаты: <strong>${escapeHtml(room.code)}</strong> · создана в ${formatGameTime(room.createdAt)}</p></div><span class="admin-game-phase">${escapeHtml(gamePhaseLabel(room.phase))}</span></div>
        <div class="admin-game-detail-grid">
            <div class="admin-game-detail-stat"><span>Игроки</span><strong>${room.playerCount}/${room.capacity || "—"}</strong></div>
            <div class="admin-game-detail-stat"><span>Раунд</span><strong>${room.phase === "lobby" ? "ожидание" : room.round}</strong></div>
            <div class="admin-game-detail-stat"><span>Ход</span><strong>${escapeHtml(currentPlayer)}</strong></div>
        </div>
        <div><p class="eyebrow">УЧАСТНИКИ</p><ul class="admin-game-players">${players.map((player) => `<li class="${player.left ? "is-left" : ""} ${player.eliminated ? "is-eliminated" : ""}">${adminPlayerAvatar(player)}<span>${escapeHtml(player.nickname)}<small>${player.left ? "вышел" : player.eliminated ? "исключён" : player.isBot ? "тест-бот" : "в игре"}</small></span></li>`).join("") || "<li>Игроков пока нет.</li>"}</ul></div>
        <div><p class="eyebrow">БУНКЕР</p><p>${escapeHtml(bunkerTraits)}</p></div>
        ${room.disaster ? `<div><p class="eyebrow">КАТАСТРОФА</p><p>${escapeHtml(room.disaster)}</p></div>` : ""}
        ${room.lastAction ? `<div><p class="eyebrow">ПОСЛЕДНЕЕ СОБЫТИЕ</p><p>${escapeHtml(room.lastAction)}</p></div>` : ""}
    `;
    $("#adminGameDetails").classList.remove("hidden");
}

function renderAdminRooms() {
    const count = adminRooms.length;
    $("#adminGamesCount").textContent = String(count);
    $("#adminGames").innerHTML = count ? adminRooms.map((room) => `
        <article class="admin-game-card ${room.gameId === selectedAdminGameId ? "is-selected" : ""}">
            <span class="admin-game-number">№${escapeHtml(room.gameId)}</span>
            <div class="admin-game-copy"><div><strong>${escapeHtml(gamePhaseLabel(room.phase))}</strong> <span class="admin-game-phase">${room.isSoloTest ? "тест" : "игра"}</span></div><div class="admin-game-meta"><span>код ${escapeHtml(room.code)}</span><span>${room.playerCount} игроков</span><span>${room.capacity ? `${room.capacity} мест` : "места определяются"}</span><span>${room.currentPlayer ? `ходит ${escapeHtml(room.currentPlayer)}` : `создана ${formatGameTime(room.createdAt)}`}</span></div></div>
            <button class="admin-game-watch" type="button" data-watch-game="${escapeHtml(room.gameId)}">Наблюдать</button>
        </article>
    `).join("") : '<p class="admin-games-empty">Сейчас нет активных комнат. Они появятся здесь сразу после создания.</p>';
    if (selectedAdminGameId && !adminRooms.some((room) => room.gameId === selectedAdminGameId)) {
        selectedAdminGameId = "";
        renderAdminGameDetails(null, null);
    }
}

function setAdminRooms(rooms) {
    adminRooms = Array.isArray(rooms) ? rooms : [];
    renderAdminRooms();
}

async function watchAdminGame(gameId) {
    selectedAdminGameId = String(gameId || "");
    renderAdminRooms();
    $("#adminGameDetails").classList.remove("hidden");
    $("#adminGameDetails").innerHTML = '<p class="admin-games-empty">Загружаю состояние игры…</p>';
    try {
        const response = await request(`/api/admin/rooms/${encodeURIComponent(selectedAdminGameId)}`);
        if (selectedAdminGameId !== String(response.room?.gameId || "")) return;
        renderAdminGameDetails(response.room, response.state);
    } catch (error) {
        if (selectedAdminGameId !== String(gameId || "")) return;
        selectedAdminGameId = "";
        renderAdminRooms();
        renderAdminGameDetails(null, null);
        showMessage("#saveMessage", error.message, "error");
    }
}

function formatDuration(milliseconds) {
    const totalMinutes = Math.max(0, Math.round((Number(milliseconds) || 0) / 60000));
    return totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)} ч ${totalMinutes % 60} мин` : `${totalMinutes} мин`;
}

function formatHistoryDate(timestamp) {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return "Дата неизвестна";
    return new Intl.DateTimeFormat("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    }).format(date);
}

function renderAdminHistoryDetails(game) {
    const target = $("#adminHistoryDetails");
    if (!game) {
        target.classList.add("hidden");
        target.innerHTML = "";
        return;
    }
    const participants = Array.isArray(game.participants) ? game.participants : [];
    const bunker = (game.bunkerTraits || []).map((trait) => `${trait.name}: ${trait.value}`).join(" · ") || "—";
    target.innerHTML = `
        <div class="admin-game-details-top"><div><p class="eyebrow">ЗАВЕРШЁННАЯ ИГРА</p><h3>Игра №${escapeHtml(game.gameId)}</h3><p>Комната <strong>${escapeHtml(game.roomCode)}</strong> · завершена ${escapeHtml(formatHistoryDate(game.finishedAt))}</p></div><button class="remove-history-game" type="button" data-delete-history="${escapeHtml(game.gameId)}">Удалить лог</button></div>
        <div class="admin-game-detail-grid"><div class="admin-game-detail-stat"><span>Длительность</span><strong>${formatDuration(game.durationMs)}</strong></div><div class="admin-game-detail-stat"><span>Раунды / голосования</span><strong>${Number(game.rounds) || 0} / ${Number(game.votingCount) || 0}</strong></div><div class="admin-game-detail-stat"><span>Шанс выживания</span><strong>${Number.isFinite(Number(game.survivalChance)) ? Number(game.survivalChance) + "%" : "—"}</strong></div><div class="admin-game-detail-stat"><span>Пресет / тема</span><strong>${escapeHtml(game.presetName || game.presetId || "Классический")} · ${escapeHtml(game.theme || "amber")}</strong></div><div class="admin-game-detail-stat"><span>Вместимость / причина</span><strong>${Number(game.capacity) || 0} · ${escapeHtml(game.finishReason || "—")}</strong></div></div>
        <div><p class="eyebrow">УЧАСТНИКИ</p><ul class="admin-game-players">${participants.map((player) => `<li class="${player.eliminated ? "is-eliminated" : ""} ${player.left ? "is-left" : ""}">${adminPlayerAvatar(player)}<span>${escapeHtml(player.nickname)}<small>${player.eliminated ? "исключён" : game.winners?.includes(player.nickname) ? "победитель" : player.left ? "вышел" : "участник"}</small></span></li>`).join("")}</ul></div>
        <div><p class="eyebrow">ПОБЕДИТЕЛИ</p><p>${escapeHtml((game.winners || []).join(", ") || "Нет")}</p></div>
        <div><p class="eyebrow">ПОРЯДОК ИСКЛЮЧЕНИЯ</p><p>${escapeHtml((game.eliminationOrder || []).join(" → ") || "Никого")}</p></div>
        <div><p class="eyebrow">КАТАСТРОФА И БУНКЕР</p><p>${escapeHtml(game.disaster || "—")}</p><p>${escapeHtml(bunker)}</p><p>Срок: ${escapeHtml(game.disasterDuration || "—")}</p></div>
        <div><p class="eyebrow">ИСПОЛЬЗОВАННЫЕ СПЕЦКАРТЫ</p><p>${escapeHtml((game.usedSpecialCards || []).map((card) => `${card.player}: ${card.name}`).join(", ") || "Нет")}</p></div>`;
    target.classList.remove("hidden");
    placeAdminHistoryDetails();
}

function placeAdminHistoryDetails() {
    const target = $("#adminHistoryDetails");
    const historyList = $("#adminHistory");
    if (!target || !historyList || !selectedHistoryGameId) return;
    const selectedCard = Array.from(historyList.querySelectorAll(".admin-game-card")).find((card) =>
        card.querySelector("[data-history-game]")?.dataset.historyGame === selectedHistoryGameId
    );
    if (selectedCard) selectedCard.after(target);
}

function renderAdminHistory() {
    const details = $("#adminHistoryDetails");
    const historyPanel = $("[data-editor-panel='history']");
    if (details && historyPanel && details.parentElement !== historyPanel) historyPanel.append(details);
    $("#adminHistoryCount").textContent = String(adminHistory.length);
    $("#adminHistory").innerHTML = adminHistory.length ? adminHistory.map((game) => `
        <article class="admin-game-card ${game.gameId === selectedHistoryGameId ? "is-selected" : ""}">
            <span class="admin-game-number"><b>№${escapeHtml(game.gameId)}</b><small>${escapeHtml(formatHistoryDate(game.finishedAt))}</small></span>
            <div class="admin-game-copy"><div><strong>${escapeHtml(game.roomCode)}</strong> <span class="admin-game-phase">${escapeHtml(game.presetName || game.presetId || "Классический")}</span></div><div class="admin-game-meta"><span>${(game.participants || []).length} участников</span><span>${(game.winners || []).length} победителей</span><span>${formatDuration(game.durationMs)}</span></div></div>
            <button class="admin-game-watch" type="button" data-history-game="${escapeHtml(game.gameId)}">Подробности</button>
        </article>`).join("") : '<p class="admin-games-empty">Завершённых игр пока нет.</p>';
    if (selectedHistoryGameId && adminHistory.some((game) => String(game.gameId) === selectedHistoryGameId)) {
        placeAdminHistoryDetails();
    } else if (selectedHistoryGameId) {
        selectedHistoryGameId = "";
        renderAdminHistoryDetails(null);
    }
}

function setAdminHistory(history) {
    adminHistory = Array.isArray(history) ? history : [];
    renderAdminHistory();
}

async function loadAdminHistory() {
    const room = $("#historyRoomSearch")?.value.trim() || "";
    const player = $("#historyPlayerSearch")?.value.trim() || "";
    const response = await request(`/api/admin/history?room=${encodeURIComponent(room)}&player=${encodeURIComponent(player)}`);
    setAdminHistory(response.games);
}

async function openHistoryGame(gameId) {
    selectedHistoryGameId = String(gameId || "");
    renderAdminHistory();
    const requestedGameId = selectedHistoryGameId;
    const target = $("#adminHistoryDetails");
    target.innerHTML = '<p class="admin-games-empty">Загружаю подробности игры…</p>';
    target.classList.remove("hidden");
    placeAdminHistoryDetails();
    const response = await request(`/api/admin/history/${encodeURIComponent(requestedGameId)}`);
    if (selectedHistoryGameId !== requestedGameId) return;
    renderAdminHistoryDetails(response.game);
}

function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
}

function markDirty() {
    isDirty = true;
}

function applyRemoteConfig(nextConfig) {
    if (!nextConfig || !config || Number(nextConfig.revision) <= Number(config.revision)) return;
    if (isDirty) {
        pendingRemoteConfig = nextConfig;
        $("#reloadLatest").classList.remove("hidden");
        showMessage("#saveMessage", "Другой администратор сохранил изменения. Ваш черновик оставлен на экране и не будет перезаписан.", "error");
        return;
    }
    config = nextConfig;
    hiddenAvatars = config.hiddenAvatars || hiddenAvatars;
    renderCategories();
    renderBunkerTraits();
    renderSpecialCards();
    renderDisasters();
    renderAvatarLibrary();
    renderPresets();
    showMessage("#saveMessage", "Настройки обновлены другим администратором.", "success");
}

function connectAdminSocket() {
    if (typeof window.io !== "function" || !token()) return;
    adminSocket?.disconnect();
    adminSocket = window.io();
    adminSocket.on("connect", () => adminSocket.emit("admin:subscribe", { token: token() }));
    adminSocket.on("admin:ready", ({ rooms, history } = {}) => {
        setAdminRooms(rooms);
        if (Array.isArray(history)) setAdminHistory(history);
    });
    adminSocket.on("admin:config-updated", ({ config: nextConfig } = {}) => applyRemoteConfig(nextConfig));
    adminSocket.on("admin:rooms-updated", ({ rooms } = {}) => {
        setAdminRooms(rooms);
        if (selectedAdminGameId && adminRooms.some((room) => room.gameId === selectedAdminGameId)) {
            watchAdminGame(selectedAdminGameId);
        }
    });
    adminSocket.on("admin:avatars-updated", (library = {}) => {
        if (!Array.isArray(library.avatars)) return;
        avatars = library.avatars;
        hiddenAvatars = library.hiddenAvatars || hiddenAvatars;
        renderAvatarLibrary();
    });
    adminSocket.on("admin:history-updated", ({ games } = {}) => {
        if (Array.isArray(games)) setAdminHistory(games);
    });
    adminSocket.on("admin:unauthorized", () => showMessage("#saveMessage", "Сессия администратора истекла. Войдите заново.", "error"));
}

function showMessage(selector, message, type = "") {
    const target = $(selector);
    target.textContent = message;
    target.className = `message ${type}`;
}

async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(url, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body.message || "Не удалось выполнить запрос.");
        error.status = response.status;
        error.payload = body;
        throw error;
    }
    return body;
}

function renderCategories() {
    $("#categories").innerHTML = config.categories.map((category) => `
        <article class="category-card" data-id="${escapeHtml(category.id)}">
            <div class="category-top">
                <input class="category-name" value="${escapeHtml(category.name)}" aria-label="Название категории">
                <label class="category-enabled"><input class="category-enabled-input" type="checkbox" ${category.id === "profession" || category.enabled !== false ? "checked" : ""} ${category.id === "profession" ? "disabled" : ""}><span>${category.id === "profession" ? "всегда включена" : "включена"}</span></label>
                ${category.id === "profession" ? '<span class="locked">обязательна первой</span>' : '<button class="remove" type="button">Удалить</button>'}
            </div>
            <label>Варианты и их польза для бункера</label>
            <div class="category-options">
                ${category.options.map((option, index) => `
                    <div class="option-row ${category.id === "profession" ? "profession-option-row" : ""}">
                        <input class="option-value" value="${escapeHtml(option.value)}" aria-label="Вариант карточки">
                        <label class="option-score"><span>Польза, %</span><input type="number" class="option-score-input" min="0" max="100" step="1" value="${Number(option.score) || 0}" aria-label="Польза варианта для бункера в процентах"></label>
                        <label class="option-chance"><span>Выпадение, %</span><input type="number" class="option-chance-input" min="0" max="100" step="0.01" value="${Number(option.chance) || 0}" aria-label="Вероятность выпадения варианта в процентах"></label>
                        <button class="remove-option" type="button" data-option-index="${index}" aria-label="Удалить вариант">×</button>
                        ${category.id === "profession" ? `<label class="option-passive-item"><span>Пассивный предмет в багаж после раскрытия профессии</span><input class="option-passive-item-input" value="${escapeHtml(option.passiveItem || "")}" placeholder="Например, аптечка" aria-label="Пассивный предмет профессии"></label>` : ""}
                    </div>
                `).join("")}
            </div>
            <div class="distribution-actions"><p class="distribution-total">Сумма вероятностей: 100% из 100%</p><button class="equalize-chances" type="button">Распределить поровну</button></div>
            <button class="add-option" type="button">+ Добавить вариант</button>
        </article>
    `).join("");
    updateDistributionTotals();
}

function renderBunkerTraits() {
    const traits = Array.isArray(config.bunkerTraits) ? config.bunkerTraits : [];
    $("#bunkerTraits").innerHTML = traits.length ? traits.map((trait) => {
        const isWaterTrait = /water|вод|вокд/.test(`${trait.id || ""} ${trait.name || ""}`.toLocaleLowerCase("ru"));
        const isRandomPercentage = !isWaterTrait && Boolean(trait.randomPercentage);
        const options = trait.options.map((option, index) => [
            '<div class="option-row bunker-option-row">',
            '<input class="bunker-option-value" value="' + escapeHtml(option.value) + '" aria-label="Вариант характеристики бункера">',
            '<label class="option-chance"><span>Выпадение, %</span><input type="number" class="bunker-option-chance-input" min="0" max="100" step="0.01" value="' + (Number(option.chance) || 0) + '" aria-label="Вероятность выпадения варианта в процентах"></label>',
            '<label class="option-chance"><span>Занимает мест</span><input type="number" class="bunker-option-slots-input" min="0" max="12" step="1" value="' + (Math.max(0, Number(option.occupiedSlots) || 0)) + '" aria-label="Сколько мест в бункере занимает этот вариант"></label>',
            '<button class="remove-option remove-bunker-option" type="button" data-option-index="' + index + '" aria-label="Удалить вариант">×</button>',
            '</div>'
        ].join("")).join("");
        return [
            '<article class="category-card bunker-trait-card' + (isRandomPercentage ? ' is-random-percentage' : '') + '" data-id="' + escapeHtml(trait.id) + '">',
            '<div class="category-top"><input class="bunker-trait-name" value="' + escapeHtml(trait.name) + '" aria-label="Название характеристики бункера"><button class="remove remove-bunker-trait" type="button">Удалить</button></div>',
            isWaterTrait ? '' : '<label class="random-percentage-toggle"><input class="bunker-random-percentage-input" type="checkbox"' + (isRandomPercentage ? ' checked' : '') + '><span>Случайный процент от 0 до 100%</span></label>',
            '<div class="bunker-variant-editor"><label>Варианты и вероятность выпадения</label><div class="category-options">' + options + '</div><div class="distribution-actions"><p class="distribution-total">Сумма вероятностей: 100% из 100%</p><button class="equalize-chances equalize-bunker-chances" type="button">Распределить поровну</button></div><button class="add-option add-bunker-option" type="button">+ Добавить вариант</button></div>',
            '</article>'
        ].join("");
    }).join("") : '<p class="avatar-library-empty">Пока нет характеристик. Добавьте, например, запас воды, еды или состояние генератора.</p>';
    updateDistributionTotals();
    renderSupplyDurations();
}

function durationValues(kind, unit) {
    return (config?.supplyDurations?.[kind] || []).filter((item) => item.unit === unit).map((item) => item.amount).join(", ");
}

function renderSupplyDurations() {
    if (!$("#waterDurationDays")) return;
    $("#waterDurationDays").value = durationValues("water", "day");
    $("#waterDurationMonths").value = durationValues("water", "month");
    $("#foodDurationDays").value = durationValues("food", "day");
    $("#foodDurationMonths").value = durationValues("food", "month");
    renderSupplyDurationOdds();
}

function parseDurationInput(selector, unit) {
    return String($(selector)?.value || "").split(/[;,\s]+/).map(Number).filter((amount) => Number.isInteger(amount) && amount > 0 && amount <= 120).map((amount) => ({ amount, unit }));
}

function durationOddsText(label, daySelector, monthSelector) {
    const days = parseDurationInput(daySelector, "day").length;
    const months = parseDurationInput(monthSelector, "month").length;
    const total = days + months;
    if (!total) return `${label}: добавьте хотя бы один срок`;
    const dayChance = Math.round(days / total * 100);
    return `${label}: дни ≈ ${dayChance}%, месяцы ≈ ${100 - dayChance}%`;
}

function renderSupplyDurationOdds() {
    const target = $("#supplyDurationOdds");
    if (!target) return;
    target.textContent = [
        durationOddsText("Вода", "#waterDurationDays", "#waterDurationMonths"),
        durationOddsText("Еда", "#foodDurationDays", "#foodDurationMonths")
    ].join(" · ");
}

function renderSpecialCards() {
    const cards = Array.isArray(config.specialCards) ? config.specialCards : [];
    $("#specialCards").innerHTML = cards.length ? cards.map((card) => [
        '<article class="category-card special-card" data-id="' + escapeHtml(card.id) + '">',
        '<div class="category-top"><input class="special-card-name" value="' + escapeHtml(card.name) + '" aria-label="Название специальной карты"><button class="remove remove-special-card" type="button">Удалить</button></div>',
        '<label>Что делает карта</label><textarea class="special-card-description" rows="4" aria-label="Описание специальной карты">' + escapeHtml(card.description) + '</textarea>',
        '<div class="special-card-fields">',
        '<label>Эффект<select class="special-card-effect" aria-label="Эффект специальной карты"><option value="swap_random_trait"' + (card.effect === "swap_random_trait" ? " selected" : "") + '>Обмен случайной характеристикой</option><option value="swap_adjacent_profession"' + (card.effect === "swap_adjacent_profession" ? " selected" : "") + '>Обмен профессией с соседом (случайный вариант)</option><option value="reroll_own_trait"' + (card.effect === "reroll_own_trait" ? " selected" : "") + '>Зарандомить свою характеристику</option><option value="take_backpack"' + (card.effect === "take_backpack" ? " selected" : "") + '>Украсть предмет из багажа</option><option value="improve_health"' + (card.effect === "improve_health" ? " selected" : "") + '>Улучшить здоровье на случайное число стадий</option><option value="worsen_health"' + (card.effect === "worsen_health" ? " selected" : "") + '>Ухудшить здоровье на случайное число стадий</option><option value="increase_capacity"' + (card.effect === "increase_capacity" ? " selected" : "") + '>Добавить 1 место в бункере</option><option value="decrease_capacity"' + (card.effect === "decrease_capacity" ? " selected" : "") + '>Убрать 1 место в бункере</option><option value="random_capacity"' + (card.effect === "random_capacity" ? " selected" : "") + '>Случайно изменить размер бункера (±1)</option></select></label>',
        '</div>',
        '</article>'
    ].join("")).join("") : '<p class="avatar-library-empty">Пока нет спецкарт. Добавьте «Обмен случайной характеристикой» или «Забрать карточку рюкзака».</p>';
}

function updateDistributionTotals() {
    document.querySelectorAll("#categories .category-card, #bunkerTraits .bunker-trait-card").forEach((card) => {
        const total = [...card.querySelectorAll(".option-chance-input, .bunker-option-chance-input")].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
        const target = card.querySelector(".distribution-total");
        target.textContent = `Сумма вероятностей: ${Math.round(total * 100) / 100}% из 100%`;
        target.classList.toggle("invalid", Math.abs(total - 100) > 0.01);
    });
}

function renderDisasters() {
    $("#disasterOptions").innerHTML = config.disasters.map((disaster, index) => {
        const text = typeof disaster === "string" ? disaster : disaster.text || "";
        const shelterDuration = typeof disaster === "string" ? "Бессрочно" : disaster.shelterDuration || disaster.duration || "Бессрочно";
        return `
        <div class="disaster-row">
            <textarea class="disaster-value" rows="3" aria-label="Сценарий катастрофы">${escapeHtml(text)}</textarea>
            <label class="disaster-duration"><span>Сколько нужно провести в бункере</span><input class="disaster-duration-value" value="${escapeHtml(shelterDuration)}" maxlength="60" aria-label="Сколько нужно провести в бункере"></label>
            <button class="remove-option remove-disaster" type="button" data-disaster-index="${index}" aria-label="Удалить катастрофу">×</button>
        </div>
    `;
    }).join("");
}

function renderAvatarLibrary() {
    $("#avatarLibrary").innerHTML = avatars.length
        ? avatars.map((url) => {
            const filename = url.split("/").pop();
            const isBuiltIn = url.startsWith("/assets/survivor-avatars/");
            const isHidden = hiddenAvatars.includes(url);
            const action = isBuiltIn
                ? `<button class="toggle-library-avatar" type="button" data-avatar-url="${escapeHtml(url)}" data-next-hidden="${!isHidden}" aria-label="${isHidden ? "Вернуть аватар" : "Убрать аватар"}" title="${isHidden ? "Вернуть аватар" : "Убрать аватар"}"><span class="eye-icon" aria-hidden="true"></span></button><span class="library-avatar-label">${isHidden ? "скрыт" : "встроенный"}</span>`
                : `<button class="remove-library-avatar" type="button" data-avatar-file="${escapeHtml(filename)}" aria-label="Удалить аватар">×</button>`;
            return `<article class="library-avatar${isHidden ? " is-hidden" : ""}"><img src="${escapeHtml(url)}" alt="Аватар из набора">${action}</article>`;
        }).join("")
        : '<p class="avatar-library-empty">Пока нет аватаров. Игроки будут отображаться с первой буквой ника.</p>';
}

function presetContent(source) {
    return {
        categories: deepClone(source.categories || []),
        disasters: deepClone(source.disasters || []),
        bunkerTraits: deepClone(source.bunkerTraits || []),
        specialCards: deepClone(source.specialCards || []),
        supplyDurations: deepClone(source.supplyDurations || config.supplyDurations || {})
    };
}

function renderPresets() {
    const presets = Array.isArray(config?.presets) ? config.presets : [];
    $("#presetLibrary").innerHTML = presets.map((preset) => `
        <article class="preset-card ${preset.id === config.activePresetId ? "is-active" : ""}" data-preset-id="${escapeHtml(preset.id)}">
            <input class="preset-name" value="${escapeHtml(preset.name)}" aria-label="Название пресета">
            <span>${preset.categories?.length || 0} категорий · ${preset.disasters?.length || 0} катастроф</span>
            <div><button class="activate-preset" type="button">${preset.id === config.activePresetId ? "Активен" : "Открыть"}</button><button class="copy-preset" type="button">Копировать</button>${presets.length > 1 ? '<button class="delete-preset" type="button">Удалить</button>' : ""}</div>
        </article>`).join("");
}

function saveEditorIntoActivePreset() {
    const active = config.presets?.find((preset) => preset.id === config.activePresetId);
    if (!active) return;
    Object.assign(active, presetContent(collectConfig(false)));
}

function openPreset(presetId) {
    if (presetId === config.activePresetId) return;
    saveEditorIntoActivePreset();
    const target = config.presets.find((preset) => preset.id === presetId);
    if (!target) return;
    config.activePresetId = target.id;
    Object.assign(config, presetContent(target));
    markDirty();
    renderCategories();
    renderBunkerTraits();
    renderSpecialCards();
    renderDisasters();
    renderPresets();
}

function readImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Не удалось прочитать изображение."));
        reader.readAsDataURL(file);
    });
}

function makeCategory() {
    config.categories.push({
        id: `custom_${Date.now()}`,
        name: "Новая категория",
        options: [{ value: "Полезный опыт", score: 75, chance: 50 }, { value: "Сложное состояние", score: 25, chance: 50 }]
    });
    markDirty();
    renderCategories();
}

function makeBunkerTrait() {
    config = { ...config, ...collectConfig() };
    config.bunkerTraits = config.bunkerTraits || [];
    config.bunkerTraits.push({
        id: `bunker_${Date.now()}`,
        name: "Новая характеристика",
        options: [{ value: "Полностью исправно", chance: 50, occupiedSlots: 0 }, { value: "Работает с перебоями", chance: 50, occupiedSlots: 0 }]
    });
    markDirty();
    renderBunkerTraits();
}

function makeSpecialCard() {
    config = { ...config, ...collectConfig() };
    config.specialCards = config.specialCards || [];
    config.specialCards.push({
        id: `special_${Date.now()}`,
        name: "Обмен случайной характеристикой",
        description: "В начале игры карта случайно выберет характеристику. Один раз обменяйтесь ею с выбранным игроком.",
        effect: "swap_random_trait"
    });
    markDirty();
    renderSpecialCards();
}

function collectConfig(includePresets = true) {
    const categories = [...document.querySelectorAll("#categories .category-card")].map((card) => ({
        id: card.dataset.id,
        name: card.querySelector(".category-name").value,
        enabled: card.dataset.id === "profession" || Boolean(card.querySelector(".category-enabled-input")?.checked),
        options: [...card.querySelectorAll(".option-row")].map((option) => ({
            value: option.querySelector(".option-value").value,
            score: Number(option.querySelector(".option-score-input").value),
            chance: Number(option.querySelector(".option-chance-input").value),
            passiveItem: option.querySelector(".option-passive-item-input")?.value || ""
        }))
    }));
    const bunkerTraits = [...document.querySelectorAll("#bunkerTraits .bunker-trait-card")].map((card) => {
        const id = card.dataset.id;
        const name = card.querySelector(".bunker-trait-name").value;
        const isWaterTrait = /water|вод|вокд/.test(`${id} ${name}`.toLocaleLowerCase("ru"));
        return {
        id,
        name,
        randomPercentage: !isWaterTrait && Boolean(card.querySelector(".bunker-random-percentage-input")?.checked),
        options: [...card.querySelectorAll(".bunker-option-row")].map((option) => ({
            value: option.querySelector(".bunker-option-value").value,
            chance: Number(option.querySelector(".bunker-option-chance-input").value),
            occupiedSlots: Number(option.querySelector(".bunker-option-slots-input").value)
        }))
        };
    });
    const specialCards = [...document.querySelectorAll("#specialCards .special-card")].map((card) => ({
        id: card.dataset.id,
        name: card.querySelector(".special-card-name").value,
        description: card.querySelector(".special-card-description").value,
        effect: card.querySelector(".special-card-effect").value
    }));
    const disasters = [...document.querySelectorAll(".disaster-row")].map((row) => ({
        text: row.querySelector(".disaster-value").value,
        shelterDuration: row.querySelector(".disaster-duration-value").value
    }));
    const supplyDurations = {
        water: [...parseDurationInput("#waterDurationDays", "day"), ...parseDurationInput("#waterDurationMonths", "month")],
        food: [...parseDurationInput("#foodDurationDays", "day"), ...parseDurationInput("#foodDurationMonths", "month")]
    };
    const content = { categories, disasters, bunkerTraits, bunkerTraitsSeedVersion: config.bunkerTraitsSeedVersion, backpackWeaponSeedVersion: config.backpackWeaponSeedVersion, waterTraitLabelSeedVersion: config.waterTraitLabelSeedVersion, waterOptionsSeedVersion: config.waterOptionsSeedVersion, waterRandomPercentSeedVersion: config.waterRandomPercentSeedVersion, waterDurationSeedVersion: config.waterDurationSeedVersion, backpackWaterSeedVersion: config.backpackWaterSeedVersion, backpackFoodSeedVersion: config.backpackFoodSeedVersion, genderOptionsSeedVersion: config.genderOptionsSeedVersion, healthCategorySeedVersion: config.healthCategorySeedVersion, specialCardLibrarySeedVersion: config.specialCardLibrarySeedVersion, disasterDurationSeedVersion: config.disasterDurationSeedVersion, contentFillSeedVersion: config.contentFillSeedVersion, coreContentSeedVersion: config.coreContentSeedVersion, specialCards, supplyDurations, hiddenAvatars, revision: config.revision };
    if (!includePresets) return content;
    const presets = deepClone(config.presets || []);
    const active = presets.find((preset) => preset.id === config.activePresetId);
    if (active) Object.assign(active, presetContent(content));
    return { ...content, presets, activePresetId: config.activePresetId || presets[0]?.id || "classic" };
}

async function loadEditor() {
    const [nextConfig, avatarResponse, roomsResponse, historyResponse] = await Promise.all([request("/api/admin/config"), request("/api/admin/avatars"), request("/api/admin/rooms"), request("/api/admin/history")]);
    config = nextConfig;
    avatars = avatarResponse.avatars;
    hiddenAvatars = avatarResponse.hiddenAvatars || [];
    setAdminRooms(roomsResponse.rooms);
    setAdminHistory(historyResponse.games);
    renderCategories();
    renderBunkerTraits();
    renderSpecialCards();
    renderDisasters();
    renderAvatarLibrary();
    renderPresets();
    isDirty = false;
    pendingRemoteConfig = null;
    $("#reloadLatest").classList.add("hidden");
    $("#loginView").classList.add("hidden");
    $("#editorView").classList.remove("hidden");
    $("#logout").classList.remove("hidden");
    connectAdminSocket();
}

function setEditorTab(tabName) {
    document.querySelectorAll(".admin-tab").forEach((tab) => {
        const active = tab.dataset.editorTab === tabName;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-editor-panel]").forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.editorPanel !== tabName);
    });
}

document.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => setEditorTab(tab.dataset.editorTab));
});

$("#login").addEventListener("click", async () => {
    const password = $("#password").value;
    try {
        const response = await request("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
        });
        localStorage.setItem(TOKEN_KEY, response.token);
        await loadEditor();
        if (response.usesDefaultPassword) showMessage("#saveMessage", "Используется временный пароль. Перед публикацией обязательно задайте ADMIN_PASSWORD.", "error");
    } catch (error) {
        showMessage("#loginMessage", error.message, "error");
    }
});

$("#password").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#login").click(); });
$("#addCategory").addEventListener("click", makeCategory);
$("#addBunkerTrait").addEventListener("click", makeBunkerTrait);
document.querySelector(".supply-duration-editor")?.addEventListener("input", () => {
    markDirty();
    renderSupplyDurationOdds();
});
$("#addSpecialCard").addEventListener("click", makeSpecialCard);
$("#createPreset").addEventListener("click", () => {
    saveEditorIntoActivePreset();
    const id = `preset_${Date.now()}`;
    const preset = { id, name: "Новый пресет", ...presetContent(collectConfig(false)) };
    config.presets = [...(config.presets || []), preset];
    config.activePresetId = id;
    markDirty();
    renderPresets();
});
$("#presetLibrary").addEventListener("input", (event) => {
    if (!event.target.matches(".preset-name")) return;
    const card = event.target.closest("[data-preset-id]");
    const preset = config.presets.find((item) => item.id === card?.dataset.presetId);
    if (preset) preset.name = event.target.value;
    markDirty();
});
$("#presetLibrary").addEventListener("click", (event) => {
    const card = event.target.closest("[data-preset-id]");
    if (!card) return;
    const presetId = card.dataset.presetId;
    if (event.target.closest(".activate-preset")) {
        openPreset(presetId);
        return;
    }
    if (event.target.closest(".copy-preset")) {
        saveEditorIntoActivePreset();
        const source = config.presets.find((preset) => preset.id === presetId);
        if (!source) return;
        const copy = deepClone(source);
        copy.id = `preset_${Date.now()}`;
        copy.name = `${source.name} — копия`;
        config.presets.push(copy);
        markDirty();
        renderPresets();
        return;
    }
    if (event.target.closest(".delete-preset") && config.presets.length > 1) {
        config.presets = config.presets.filter((preset) => preset.id !== presetId);
        if (config.activePresetId === presetId) {
            const next = config.presets[0];
            config.activePresetId = next.id;
            Object.assign(config, presetContent(next));
            renderCategories();
            renderBunkerTraits();
            renderSpecialCards();
            renderDisasters();
        }
        markDirty();
        renderPresets();
    }
});
$("#refreshAdminGames").addEventListener("click", async () => {
    try {
        const response = await request("/api/admin/rooms");
        setAdminRooms(response.rooms);
        if (selectedAdminGameId) await watchAdminGame(selectedAdminGameId);
    } catch (error) {
        showMessage("#saveMessage", error.message, "error");
    }
});
$("#adminGames").addEventListener("click", (event) => {
    const button = event.target.closest("[data-watch-game]");
    if (button) watchAdminGame(button.dataset.watchGame);
});
$("#refreshAdminHistory").addEventListener("click", () => loadAdminHistory().catch((error) => showMessage("#saveMessage", error.message, "error")));
$("#clearAdminHistory").addEventListener("click", async () => {
    if (!window.confirm("Удалить всю историю игр? Следующая сессия получит номер 0000000. Отменить это действие нельзя.")) return;
    try {
        await request("/api/admin/history", { method: "DELETE" });
        selectedHistoryGameId = "";
        renderAdminHistoryDetails(null);
        setAdminHistory([]);
        showMessage("#saveMessage", "История очищена. Нумерация новых сессий начнётся с 0000000.", "success");
    } catch (error) {
        showMessage("#saveMessage", error.message, "error");
    }
});
let historySearchTimer = 0;
[$("#historyRoomSearch"), $("#historyPlayerSearch")].forEach((input) => input.addEventListener("input", () => {
    clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => loadAdminHistory().catch((error) => showMessage("#saveMessage", error.message, "error")), 260);
}));
$("#adminHistory").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-game]");
    if (button) openHistoryGame(button.dataset.historyGame).catch((error) => showMessage("#saveMessage", error.message, "error"));
});
$("#adminHistoryDetails").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-history]");
    if (!button) return;
    try {
        await request(`/api/admin/history/${encodeURIComponent(button.dataset.deleteHistory)}`, { method: "DELETE" });
        selectedHistoryGameId = "";
        renderAdminHistoryDetails(null);
        await loadAdminHistory();
        showMessage("#saveMessage", "Лог игры удалён.", "success");
    } catch (error) {
        showMessage("#saveMessage", error.message, "error");
    }
});
$("#addDisaster").addEventListener("click", () => {
    config.disasters.push({ text: "Новый сценарий катастрофы.", shelterDuration: "Бессрочно" });
    markDirty();
    renderDisasters();
});
$("#adminAvatarFile").addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;

    const validFiles = files.filter((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size <= 350 * 1024);
    const rejectedCount = files.length - validFiles.length;
    if (!validFiles.length) {
        showMessage("#saveMessage", "Нужны PNG, JPG или WebP размером до 350 КБ.", "error");
        return;
    }

    let uploadedCount = 0;
    let latestAvatarLibrary = { avatars, hiddenAvatars };
    const errors = [];
    for (const file of validFiles) {
        try {
            const imageData = await readImage(file);
            const response = await request("/api/admin/avatars", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageData })
            });
            latestAvatarLibrary = response;
            uploadedCount += 1;
        } catch (error) {
            errors.push(`${file.name}: ${error.message}`);
        }
    }
    avatars = latestAvatarLibrary.avatars;
    hiddenAvatars = latestAvatarLibrary.hiddenAvatars || [];
    renderAvatarLibrary();

    const skippedCount = rejectedCount + errors.length;
    const result = `Загружено: ${uploadedCount}${skippedCount ? `, пропущено: ${skippedCount}` : ""}.`;
    showMessage("#saveMessage", errors.length ? `${result} ${errors[0]}` : result, uploadedCount ? "success" : "error");
});
$("#categories").addEventListener("click", (event) => {
    const card = event.target.closest(".category-card");
    if (!card) return;
    if (event.target.closest(".equalize-chances")) {
        const draft = collectConfig();
        config = { ...config, ...draft };
        const categoryToEqualize = config.categories.find((item) => item.id === card.dataset.id);
        const count = categoryToEqualize?.options.length || 0;
        if (!count) return;
        const baseChance = Math.floor((100 / count) * 100) / 100;
        categoryToEqualize.options.forEach((option, index) => {
            option.chance = index === count - 1 ? Math.round((100 - baseChance * (count - 1)) * 100) / 100 : baseChance;
        });
        markDirty();
        renderCategories();
        return;
    }
    const category = config.categories.find((item) => item.id === card.dataset.id);
    if (event.target.closest(".remove")) {
        config.categories = config.categories.filter((item) => item.id !== card.dataset.id);
        markDirty();
        renderCategories();
        return;
    }
    if (event.target.closest(".add-option")) {
        category.options.push({ value: "Новый вариант", score: 50, chance: 0 });
        markDirty();
        renderCategories();
        return;
    }
    const removeOption = event.target.closest(".remove-option");
    if (removeOption) {
        category.options.splice(Number(removeOption.dataset.optionIndex), 1);
        markDirty();
        renderCategories();
    }
});
$("#categories").addEventListener("input", (event) => {
    markDirty();
    if (event.target.matches(".option-chance-input")) updateDistributionTotals();
});
$("#bunkerTraits").addEventListener("click", (event) => {
    const card = event.target.closest(".bunker-trait-card");
    if (!card) return;
    const draft = collectConfig();
    config = { ...config, ...draft };
    const trait = config.bunkerTraits.find((item) => item.id === card.dataset.id);
    if (!trait) return;
    if (event.target.closest(".equalize-bunker-chances")) {
        const count = trait.options.length;
        if (!count) return;
        const baseChance = Math.floor((100 / count) * 100) / 100;
        trait.options.forEach((option, index) => {
            option.chance = index === count - 1 ? Math.round((100 - baseChance * (count - 1)) * 100) / 100 : baseChance;
        });
        markDirty();
        renderBunkerTraits();
        return;
    }
    if (event.target.closest(".remove-bunker-trait")) {
        config.bunkerTraits = config.bunkerTraits.filter((item) => item.id !== card.dataset.id);
        markDirty();
        renderBunkerTraits();
        return;
    }
    if (event.target.closest(".add-bunker-option")) {
        trait.options.push({ value: "Новый вариант", chance: 0 });
        markDirty();
        renderBunkerTraits();
        return;
    }
    const removeOption = event.target.closest(".remove-bunker-option");
    if (removeOption) {
        trait.options.splice(Number(removeOption.dataset.optionIndex), 1);
        markDirty();
        renderBunkerTraits();
    }
});
$("#bunkerTraits").addEventListener("input", (event) => {
    markDirty();
    if (event.target.matches(".bunker-option-chance-input")) updateDistributionTotals();
});
$("#bunkerTraits").addEventListener("change", (event) => {
    if (!event.target.matches(".bunker-random-percentage-input")) return;
    config = { ...config, ...collectConfig() };
    markDirty();
    renderBunkerTraits();
});
$("#specialCards").addEventListener("click", (event) => {
    const card = event.target.closest(".special-card");
    if (!card || !event.target.closest(".remove-special-card")) return;
    config = { ...config, ...collectConfig() };
    config.specialCards = config.specialCards.filter((item) => item.id !== card.dataset.id);
    markDirty();
    renderSpecialCards();
});
$("#specialCards").addEventListener("input", markDirty);
$("#disasterOptions").addEventListener("input", markDirty);
$("#disasterOptions").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-disaster");
    if (!button) return;
    config.disasters.splice(Number(button.dataset.disasterIndex), 1);
    markDirty();
    renderDisasters();
});
$("#avatarLibrary").addEventListener("click", async (event) => {
    const toggleButton = event.target.closest(".toggle-library-avatar");
    if (toggleButton) {
        try {
            const response = await request("/api/admin/avatars/visibility", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: toggleButton.dataset.avatarUrl,
                    hidden: toggleButton.dataset.nextHidden === "true"
                })
            });
            avatars = response.avatars;
            hiddenAvatars = response.hiddenAvatars || [];
            if (config && Number.isSafeInteger(response.revision)) {
                config.hiddenAvatars = hiddenAvatars;
                config.revision = response.revision;
                if (pendingRemoteConfig?.revision === response.revision) {
                    pendingRemoteConfig = null;
                    $("#reloadLatest").classList.add("hidden");
                }
            }
            renderAvatarLibrary();
            showMessage("#saveMessage", toggleButton.dataset.nextHidden === "true" ? "Аватар убран из случайного набора." : "Аватар снова в наборе.", "success");
        } catch (error) {
            showMessage("#saveMessage", error.message, "error");
        }
        return;
    }
    const button = event.target.closest(".remove-library-avatar");
    if (!button) return;
    try {
        const response = await request(`/api/admin/avatars/${encodeURIComponent(button.dataset.avatarFile)}`, { method: "DELETE" });
        avatars = response.avatars;
        hiddenAvatars = response.hiddenAvatars || [];
        renderAvatarLibrary();
        showMessage("#saveMessage", "Аватар удалён из набора.", "success");
    } catch (error) {
        showMessage("#saveMessage", error.message, "error");
    }
});
$("#save").addEventListener("click", async () => {
    try {
        const nextConfig = collectConfig();
        config = await request("/api/admin/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextConfig)
        });
        hiddenAvatars = config.hiddenAvatars || hiddenAvatars;
        isDirty = false;
        pendingRemoteConfig = null;
        $("#reloadLatest").classList.add("hidden");
        renderCategories();
        renderBunkerTraits();
        renderSpecialCards();
        renderDisasters();
        renderPresets();
        showMessage("#saveMessage", "Настройки сохранены.", "success");
    } catch (error) {
        if (error.status === 409 && error.payload?.config) {
            pendingRemoteConfig = error.payload.config;
            $("#reloadLatest").classList.remove("hidden");
            showMessage("#saveMessage", "Другой администратор уже сохранил новую версию. Ваши изменения остались на экране — загрузите свежую версию и внесите их повторно.", "error");
            return;
        }
        showMessage("#saveMessage", error.message, "error");
    }
});
$("#reloadLatest").addEventListener("click", () => {
    if (!pendingRemoteConfig) return;
    config = pendingRemoteConfig;
    hiddenAvatars = config.hiddenAvatars || hiddenAvatars;
    pendingRemoteConfig = null;
    isDirty = false;
    $("#reloadLatest").classList.add("hidden");
    renderCategories();
    renderBunkerTraits();
    renderSpecialCards();
    renderDisasters();
    renderAvatarLibrary();
    renderPresets();
    showMessage("#saveMessage", "Загружена последняя сохранённая версия.", "success");
});
$("#logout").addEventListener("click", () => {
    adminSocket?.disconnect();
    adminSocket = null;
    localStorage.removeItem(TOKEN_KEY);
    config = null;
    isDirty = false;
    pendingRemoteConfig = null;
    adminRooms = [];
    selectedAdminGameId = "";
    renderAdminRooms();
    renderAdminGameDetails(null, null);
    $("#editorView").classList.add("hidden");
    $("#loginView").classList.remove("hidden");
    $("#logout").classList.add("hidden");
});

$("#themeToggle").addEventListener("click", toggleThemeMenu);
document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => {
        applyColorTheme(button.dataset.themeChoice);
        closeThemeMenu();
    });
});
document.addEventListener("click", (event) => {
    if (!event.target.closest(".theme-control")) closeThemeMenu();
});
applyColorTheme(localStorage.getItem(THEME_STORAGE_KEY) || "amber");

if (token()) {
    loadEditor().catch(() => localStorage.removeItem(TOKEN_KEY));
}
