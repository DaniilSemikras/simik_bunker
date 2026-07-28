const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "bunker-admin-token";
let config = null;
let avatars = [];

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
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
    if (!response.ok) throw new Error(body.message || "Не удалось выполнить запрос.");
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
                    <div class="option-row">
                        <input class="option-value" value="${escapeHtml(option.value)}" aria-label="Вариант карточки">
                        <label class="option-score"><span>Польза, %</span><input type="number" class="option-score-input" min="0" max="100" step="1" value="${Number(option.score) || 0}" aria-label="Польза варианта для бункера в процентах"></label>
                        <label class="option-chance"><span>Выпадение, %</span><input type="number" class="option-chance-input" min="0" max="100" step="0.01" value="${Number(option.chance) || 0}" aria-label="Вероятность выпадения варианта в процентах"></label>
                        <button class="remove-option" type="button" data-option-index="${index}" aria-label="Удалить вариант">×</button>
                    </div>
                `).join("")}
            </div>
            <p class="distribution-total">Сумма вероятностей: 100% из 100%</p>
            <button class="add-option" type="button">+ Добавить вариант</button>
        </article>
    `).join("");
    updateDistributionTotals();
}

function updateDistributionTotals() {
    document.querySelectorAll(".category-card").forEach((card) => {
        const total = [...card.querySelectorAll(".option-chance-input")].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
        const target = card.querySelector(".distribution-total");
        target.textContent = `Сумма вероятностей: ${Math.round(total * 100) / 100}% из 100%`;
        target.classList.toggle("invalid", Math.abs(total - 100) > 0.01);
    });
}

function renderDisasters() {
    $("#disasterOptions").innerHTML = config.disasters.map((disaster, index) => `
        <div class="disaster-row">
            <textarea class="disaster-value" rows="3" aria-label="Сценарий катастрофы">${escapeHtml(disaster)}</textarea>
            <button class="remove-option remove-disaster" type="button" data-disaster-index="${index}" aria-label="Удалить катастрофу">×</button>
        </div>
    `).join("");
}

function renderAvatarLibrary() {
    $("#avatarLibrary").innerHTML = avatars.length
        ? avatars.map((url) => {
            const filename = url.split("/").pop();
            return `<article class="library-avatar"><img src="${escapeHtml(url)}" alt="Аватар из набора"><button class="remove-library-avatar" type="button" data-avatar-file="${escapeHtml(filename)}" aria-label="Удалить аватар">×</button></article>`;
        }).join("")
        : '<p class="avatar-library-empty">Пока нет аватаров. Игроки без выбора будут отображаться с первой буквой ника.</p>';
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
        options: [{ value: "Первый вариант", score: 50, chance: 50 }, { value: "Второй вариант", score: 50, chance: 50 }]
    });
    renderCategories();
}

function collectConfig() {
    const categories = [...document.querySelectorAll(".category-card")].map((card) => ({
        id: card.dataset.id,
        name: card.querySelector(".category-name").value,
        options: [...card.querySelectorAll(".option-row")].map((option) => ({
            value: option.querySelector(".option-value").value,
            score: Number(option.querySelector(".option-score-input").value),
            chance: Number(option.querySelector(".option-chance-input").value)
        }))
    }));
    const disasters = [...document.querySelectorAll(".disaster-value")].map((input) => input.value);
    return { categories, disasters };
}

async function loadEditor() {
    const [nextConfig, avatarResponse] = await Promise.all([request("/api/admin/config"), request("/api/admin/avatars")]);
    config = nextConfig;
    avatars = avatarResponse.avatars;
    renderCategories();
    renderDisasters();
    renderAvatarLibrary();
    $("#loginView").classList.add("hidden");
    $("#editorView").classList.remove("hidden");
    $("#logout").classList.remove("hidden");
}

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
$("#addDisaster").addEventListener("click", () => {
    config.disasters.push("Новый сценарий катастрофы.");
    renderDisasters();
});
$("#adminAvatarFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 350 * 1024) {
        showMessage("#saveMessage", "Выберите PNG, JPG или WebP размером до 350 КБ.", "error");
        return;
    }
    try {
        const imageData = await readImage(file);
        const response = await request("/api/admin/avatars", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageData })
        });
        avatars = response.avatars;
        renderAvatarLibrary();
        showMessage("#saveMessage", "Аватар загружен в набор.", "success");
    } catch (error) {
        showMessage("#saveMessage", error.message, "error");
    }
});
$("#categories").addEventListener("click", (event) => {
    const card = event.target.closest(".category-card");
    if (!card) return;
    const category = config.categories.find((item) => item.id === card.dataset.id);
    if (event.target.closest(".remove")) {
        config.categories = config.categories.filter((item) => item.id !== card.dataset.id);
        renderCategories();
        return;
    }
    if (event.target.closest(".add-option")) {
        category.options.push({ value: "Новый вариант", score: 50, chance: 0 });
        renderCategories();
        return;
    }
    const removeOption = event.target.closest(".remove-option");
    if (removeOption) {
        category.options.splice(Number(removeOption.dataset.optionIndex), 1);
        renderCategories();
    }
});
$("#categories").addEventListener("input", (event) => {
    if (event.target.matches(".option-chance-input")) updateDistributionTotals();
});
$("#disasterOptions").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-disaster");
    if (!button) return;
    config.disasters.splice(Number(button.dataset.disasterIndex), 1);
    renderDisasters();
});
$("#avatarLibrary").addEventListener("click", async (event) => {
    const button = event.target.closest(".remove-library-avatar");
    if (!button) return;
    try {
        const response = await request(`/api/admin/avatars/${encodeURIComponent(button.dataset.avatarFile)}`, { method: "DELETE" });
        avatars = response.avatars;
        renderAvatarLibrary();
        showMessage("#saveMessage", "Аватар удалён из набора.", "success");
    } catch (error) {
        showMessage("#saveMessage", error.message, "error");
    }
});
$("#save").addEventListener("click", async () => {
    try {
        config = await request("/api/admin/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(collectConfig())
        });
        renderCategories();
        renderDisasters();
        showMessage("#saveMessage", "Настройки сохранены.", "success");
    } catch (error) {
        showMessage("#saveMessage", error.message, "error");
    }
});
$("#logout").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    config = null;
    $("#editorView").classList.add("hidden");
    $("#loginView").classList.remove("hidden");
    $("#logout").classList.add("hidden");
});

if (token()) {
    loadEditor().catch(() => localStorage.removeItem(TOKEN_KEY));
}
