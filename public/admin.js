const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "bunker-admin-token";
let config = null;

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
                        <button class="remove-option" type="button" data-option-index="${index}" aria-label="Удалить вариант">×</button>
                    </div>
                `).join("")}
            </div>
            <button class="add-option" type="button">+ Добавить вариант</button>
        </article>
    `).join("");
}

function makeCategory() {
    config.categories.push({
        id: `custom_${Date.now()}`,
        name: "Новая категория",
        options: [{ value: "Первый вариант", score: 50 }, { value: "Второй вариант", score: 50 }]
    });
    renderCategories();
}

function collectConfig() {
    const categories = [...document.querySelectorAll(".category-card")].map((card) => ({
        id: card.dataset.id,
        name: card.querySelector(".category-name").value,
        options: [...card.querySelectorAll(".option-row")].map((option) => ({
            value: option.querySelector(".option-value").value,
            score: Number(option.querySelector(".option-score-input").value)
        }))
    }));
    return { categories, disasters: $("#disasterList").value.split("\n") };
}

async function loadEditor() {
    config = await request("/api/admin/config");
    $("#disasterList").value = config.disasters.join("\n");
    renderCategories();
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
        category.options.push({ value: "Новый вариант", score: 50 });
        renderCategories();
        return;
    }
    const removeOption = event.target.closest(".remove-option");
    if (removeOption) {
        category.options.splice(Number(removeOption.dataset.optionIndex), 1);
        renderCategories();
    }
});
$("#save").addEventListener("click", async () => {
    try {
        config = await request("/api/admin/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(collectConfig())
        });
        $("#disasterList").value = config.disasters.join("\n");
        renderCategories();
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
