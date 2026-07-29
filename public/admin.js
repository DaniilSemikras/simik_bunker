const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "bunker-admin-token";
let config = null;
let avatars = [];
let hiddenAvatars = [];
let adminSocket = null;
let isDirty = false;
let pendingRemoteConfig = null;

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
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
    showMessage("#saveMessage", "Настройки обновлены другим администратором.", "success");
}

function connectAdminSocket() {
    if (typeof window.io !== "function" || !token()) return;
    adminSocket?.disconnect();
    adminSocket = window.io();
    adminSocket.on("connect", () => adminSocket.emit("admin:subscribe", { token: token() }));
    adminSocket.on("admin:config-updated", ({ config: nextConfig } = {}) => applyRemoteConfig(nextConfig));
    adminSocket.on("admin:avatars-updated", (library = {}) => {
        if (!Array.isArray(library.avatars)) return;
        avatars = library.avatars;
        hiddenAvatars = library.hiddenAvatars || hiddenAvatars;
        renderAvatarLibrary();
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
        const options = trait.options.map((option, index) => [
            '<div class="option-row bunker-option-row">',
            '<input class="bunker-option-value" value="' + escapeHtml(option.value) + '" aria-label="Вариант характеристики бункера">',
            '<label class="option-chance"><span>Выпадение, %</span><input type="number" class="bunker-option-chance-input" min="0" max="100" step="0.01" value="' + (Number(option.chance) || 0) + '" aria-label="Вероятность выпадения варианта в процентах"></label>',
            '<label class="option-chance"><span>Занимает мест</span><input type="number" class="bunker-option-slots-input" min="0" max="12" step="1" value="' + (Math.max(0, Number(option.occupiedSlots) || 0)) + '" aria-label="Сколько мест в бункере занимает этот вариант"></label>',
            '<button class="remove-option remove-bunker-option" type="button" data-option-index="' + index + '" aria-label="Удалить вариант">×</button>',
            '</div>'
        ].join("")).join("");
        return [
            '<article class="category-card bunker-trait-card" data-id="' + escapeHtml(trait.id) + '">',
            '<div class="category-top"><input class="bunker-trait-name" value="' + escapeHtml(trait.name) + '" aria-label="Название характеристики бункера"><button class="remove remove-bunker-trait" type="button">Удалить</button></div>',
            '<label>Варианты и вероятность выпадения</label>',
            '<div class="category-options">' + options + '</div>',
            '<div class="distribution-actions"><p class="distribution-total">Сумма вероятностей: 100% из 100%</p><button class="equalize-chances equalize-bunker-chances" type="button">Распределить поровну</button></div>',
            '<button class="add-option add-bunker-option" type="button">+ Добавить вариант</button>',
            '</article>'
        ].join("");
    }).join("") : '<p class="avatar-library-empty">Пока нет характеристик. Добавьте, например, запас воды, еды или состояние генератора.</p>';
    updateDistributionTotals();
}

function renderSpecialCards() {
    const cards = Array.isArray(config.specialCards) ? config.specialCards : [];
    $("#specialCards").innerHTML = cards.length ? cards.map((card) => [
        '<article class="category-card special-card" data-id="' + escapeHtml(card.id) + '">',
        '<div class="category-top"><input class="special-card-name" value="' + escapeHtml(card.name) + '" aria-label="Название специальной карты"><button class="remove remove-special-card" type="button">Удалить</button></div>',
        '<label>Что делает карта</label><textarea class="special-card-description" rows="4" aria-label="Описание специальной карты">' + escapeHtml(card.description) + '</textarea>',
        '<div class="special-card-fields">',
        '<label>Эффект<select class="special-card-effect" aria-label="Эффект специальной карты"><option value="swap_random_trait"' + (card.effect === "swap_random_trait" ? " selected" : "") + '>Обмен случайной характеристикой</option><option value="reroll_own_trait"' + (card.effect === "reroll_own_trait" ? " selected" : "") + '>Зарандомить свою характеристику</option><option value="take_backpack"' + (card.effect === "take_backpack" ? " selected" : "") + '>Забрать предмет в свой багаж</option><option value="increase_capacity"' + (card.effect === "increase_capacity" ? " selected" : "") + '>Добавить 1 место в бункере</option><option value="decrease_capacity"' + (card.effect === "decrease_capacity" ? " selected" : "") + '>Убрать 1 место в бункере</option><option value="random_capacity"' + (card.effect === "random_capacity" ? " selected" : "") + '>Случайно изменить размер бункера (±1)</option></select></label>',
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
            const isBuiltIn = url.startsWith("/assets/avatars/");
            const isHidden = hiddenAvatars.includes(url);
            const action = isBuiltIn
                ? `<button class="toggle-library-avatar" type="button" data-avatar-url="${escapeHtml(url)}" data-next-hidden="${!isHidden}" aria-label="${isHidden ? "Вернуть аватар" : "Убрать аватар"}" title="${isHidden ? "Вернуть аватар" : "Убрать аватар"}"><span class="eye-icon" aria-hidden="true"></span></button><span class="library-avatar-label">${isHidden ? "скрыт" : "встроенный"}</span>`
                : `<button class="remove-library-avatar" type="button" data-avatar-file="${escapeHtml(filename)}" aria-label="Удалить аватар">×</button>`;
            return `<article class="library-avatar${isHidden ? " is-hidden" : ""}"><img src="${escapeHtml(url)}" alt="Аватар из набора">${action}</article>`;
        }).join("")
        : '<p class="avatar-library-empty">Пока нет аватаров. Игроки будут отображаться с первой буквой ника.</p>';
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

function collectConfig() {
    const categories = [...document.querySelectorAll("#categories .category-card")].map((card) => ({
        id: card.dataset.id,
        name: card.querySelector(".category-name").value,
        options: [...card.querySelectorAll(".option-row")].map((option) => ({
            value: option.querySelector(".option-value").value,
            score: Number(option.querySelector(".option-score-input").value),
            chance: Number(option.querySelector(".option-chance-input").value),
            passiveItem: option.querySelector(".option-passive-item-input")?.value || ""
        }))
    }));
    const bunkerTraits = [...document.querySelectorAll("#bunkerTraits .bunker-trait-card")].map((card) => ({
        id: card.dataset.id,
        name: card.querySelector(".bunker-trait-name").value,
        options: [...card.querySelectorAll(".bunker-option-row")].map((option) => ({
            value: option.querySelector(".bunker-option-value").value,
            chance: Number(option.querySelector(".bunker-option-chance-input").value),
            occupiedSlots: Number(option.querySelector(".bunker-option-slots-input").value)
        }))
    }));
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
    return { categories, disasters, bunkerTraits, bunkerTraitsSeedVersion: config.bunkerTraitsSeedVersion, backpackWeaponSeedVersion: config.backpackWeaponSeedVersion, waterTraitLabelSeedVersion: config.waterTraitLabelSeedVersion, disasterDurationSeedVersion: config.disasterDurationSeedVersion, contentFillSeedVersion: config.contentFillSeedVersion, specialCards, hiddenAvatars, revision: config.revision };
}

async function loadEditor() {
    const [nextConfig, avatarResponse] = await Promise.all([request("/api/admin/config"), request("/api/admin/avatars")]);
    config = nextConfig;
    avatars = avatarResponse.avatars;
    hiddenAvatars = avatarResponse.hiddenAvatars || [];
    renderCategories();
    renderBunkerTraits();
    renderSpecialCards();
    renderDisasters();
    renderAvatarLibrary();
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
$("#addSpecialCard").addEventListener("click", makeSpecialCard);
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
    showMessage("#saveMessage", "Загружена последняя сохранённая версия.", "success");
});
$("#logout").addEventListener("click", () => {
    adminSocket?.disconnect();
    adminSocket = null;
    localStorage.removeItem(TOKEN_KEY);
    config = null;
    isDirty = false;
    pendingRemoteConfig = null;
    $("#editorView").classList.add("hidden");
    $("#loginView").classList.remove("hidden");
    $("#logout").classList.add("hidden");
});

if (token()) {
    loadEditor().catch(() => localStorage.removeItem(TOKEN_KEY));
}
