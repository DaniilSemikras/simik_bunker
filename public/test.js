const socket = io();
const $ = (selector) => document.querySelector(selector);
let room = null;
let serverState = null;
let ownId = "";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function notify(message) {
    $("#notice").textContent = message;
    $("#notice").classList.add("visible");
    setTimeout(() => $("#notice").classList.remove("visible"), 2600);
}

function render() {
    if (!room) return;
    const phaseNames = { lobby: "Лобби", story: "История", reveal: "Раскрытие", voting: "Голосование", finished: "Финал" };
    $("#summary").innerHTML = `<strong>${escapeHtml(room.code)}</strong><span>${escapeHtml(phaseNames[room.phase] || room.phase)}</span><span>Раунд ${room.round || 0}/${room.revealRounds || 0}</span><span>Мест: ${room.capacity || 0}</span>${serverState?.testPaused ? '<b class="paused-badge">ПАУЗА</b>' : ""}`;
    $("#capacity").value = room.capacity || 1;
    $("#phaseSelect").value = ["story", "reveal", "voting", "finished"].includes(room.phase) ? room.phase : "story";
    $("#roundNumber").value = Math.max(1, Number(room.round) || 1);
    $("#roundNumber").max = Math.max(1, Number(room.revealRounds) || 1);
    $("#pauseButton").textContent = serverState?.testPaused ? "Продолжить игру" : "Поставить на паузу";
    $("#pauseButton").classList.toggle("is-paused", Boolean(serverState?.testPaused));

    const categories = serverState?.traitOrder || room.categoryOrder || [];
    const categoryNames = serverState?.categoryNames || room.categoryNames || {};
    const healthTrait = categories.find((trait) => trait === "health" || /здоров/i.test(categoryNames[trait] || ""));
    $("#players").innerHTML = (room.players || []).map((player, index) => {
        const cards = serverState?.cards?.[player.id] || {};
        const revealed = room.players.find((candidate) => candidate.id === player.id)?.revealed || {};
        const special = serverState?.playerSpecialCards?.[player.id];
        const isCurrentTurn = room.turnPlayerId === player.id;
        const rows = categories.map((trait) => {
            const isOpen = Object.prototype.hasOwnProperty.call(revealed, trait);
            return `<div class="controller-card ${isOpen ? "is-open" : "is-closed"}">
                <div><span>${escapeHtml(categoryNames[trait] || trait)}</span><strong>${escapeHtml(cards[trait] ?? "—")}</strong></div>
                <button type="button" data-control-reveal data-player="${escapeHtml(player.id)}" data-trait="${escapeHtml(trait)}" data-revealed="${isOpen ? "false" : "true"}" title="${isOpen ? "Снова скрыть" : "Раскрыть для всех"}">${isOpen ? "Скрыть" : "Открыть"}</button>
            </div>`;
        }).join("");
        const avatar = player.avatarUrl ? `<img src="${escapeHtml(player.avatarUrl)}" alt="">` : `<span>${escapeHtml(player.nickname.charAt(0).toUpperCase())}</span>`;
        return `<article class="player-controller ${player.eliminated ? "out" : ""} ${isCurrentTurn ? "current-turn" : ""}">
            <header><div class="controller-avatar">${avatar}</div><div><small>ИГРОК №${index + 1}${player.isBot ? " · БОТ" : ""}</small><h3>${escapeHtml(player.nickname)}${player.id === ownId ? " (панель)" : ""}</h3><p>${player.eliminated ? "Исключён" : isCurrentTurn ? "Сейчас его ход" : "В игре"}</p></div></header>
            <div class="controller-cards">${rows || '<p class="empty-cards">Карточки появятся после запуска игры.</p>'}</div>
            ${special ? `<div class="controller-special"><span>Спецкарта</span><strong>${escapeHtml(special.name)}</strong><small>${special.used ? "использована" : "на руках"}</small></div>` : ""}
            <footer><button type="button" data-control-turn data-player="${escapeHtml(player.id)}">Передать ход</button>${healthTrait ? `<button type="button" data-control-health="improve" data-player="${escapeHtml(player.id)}">Здоровье +</button><button type="button" data-control-health="worsen" data-player="${escapeHtml(player.id)}">Здоровье −</button>` : ""}<button type="button" class="${player.eliminated ? "restore" : "danger-action"}" data-control-eliminate data-player="${escapeHtml(player.id)}" data-eliminated="${player.eliminated ? "false" : "true"}">${player.eliminated ? "Вернуть" : "Исключить"}</button></footer>
        </article>`;
    }).join("") || '<p class="empty-cards">Сначала создайте тестовую комнату.</p>';
    const selectedPlayer = $("#targetPlayer").value;
    $("#targetPlayer").innerHTML = (room.players || []).map((player) => `<option value="${player.id}">${player.nickname}</option>`).join("");
    if ([...$("#targetPlayer").options].some((option) => option.value === selectedPlayer)) $("#targetPlayer").value = selectedPlayer;
    const selectedTrait = $("#targetTrait").value;
    $("#targetTrait").innerHTML = (room.categoryOrder || []).map((trait) => `<option value="${trait}">${room.categoryNames?.[trait] || trait}</option>`).join("");
    if ([...$("#targetTrait").options].some((option) => option.value === selectedTrait)) $("#targetTrait").value = selectedTrait;
}

document.addEventListener("click", (event) => {
    const revealControl = event.target.closest("[data-control-reveal]");
    if (revealControl) return socket.emit("test:setReveal", { targetId: revealControl.dataset.player, trait: revealControl.dataset.trait, revealed: revealControl.dataset.revealed === "true" });
    const healthControl = event.target.closest("[data-control-health]");
    if (healthControl) return socket.emit("test:applyHealth", { targetId: healthControl.dataset.player, direction: healthControl.dataset.controlHealth, amount: 1 });
    const turnControl = event.target.closest("[data-control-turn]");
    if (turnControl) return socket.emit("test:setTurn", { targetId: turnControl.dataset.player });
    const eliminationControl = event.target.closest("[data-control-eliminate]");
    if (eliminationControl) return socket.emit("test:setEliminated", { targetId: eliminationControl.dataset.player, eliminated: eliminationControl.dataset.eliminated === "true" });
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "create") socket.emit("test:createRoom", { nickname: "Тестировщик" });
    if (action === "players") socket.emit("test:setPlayers", { count: Number($("#playerCount").value) });
    if (action === "bots") socket.emit("test:addBots", { count: Number($("#botCount").value) });
    if (action === "start") socket.emit("test:start");
    if (action === "pause") socket.emit("test:togglePause");
    if (action === "phase") socket.emit("test:setPhase", { phase: $("#phaseSelect").value });
    if (action === "round") socket.emit("test:setRound", { round: Number($("#roundNumber").value) });
    if (action === "advance") socket.emit("test:advance");
    if (action === "previous") socket.emit("test:previous");
    if (action === "vote") socket.emit("test:openVoting");
    if (action === "tie") socket.emit("test:forceTie");
    if (action === "notify") socket.emit("test:notify");
    if (action === "rematch") socket.emit("requestRematch");
    if (action === "decline-rematch") socket.emit("declineRematch");
    if (action === "reveal-auto") socket.emit("test:reveal", { targetId: $("#targetPlayer").value });
    if (action === "reveal-manual") socket.emit("test:reveal", { targetId: $("#targetPlayer").value, trait: $("#targetTrait").value });
    if (action === "finish") socket.emit("test:finish");
    if (action === "reset") socket.emit("test:reset");
    if (action === "health") socket.emit("test:applyHealth", { targetId: (room?.players || []).find((player) => player.id !== ownId && !player.eliminated)?.id || ownId, direction: $("#healthDirection").value, amount: Number($("#healthAmount").value) });
    if (action === "special") socket.emit("test:giveSpecialCard", { effect: $("#specialEffect").value });
    if (action === "use-special") socket.emit("test:useSpecialCard", { effect: $("#specialEffect").value, targetId: $("#targetPlayer").value });
    if (action === "capacity") socket.emit("test:setCapacity", { capacity: Number($("#capacity").value) });
    if (action === "eliminate") socket.emit("test:eliminate", { targetId: (room?.players || []).find((player) => player.isBot && !player.eliminated)?.id });
    if (action === "state") socket.emit("test:state");
});

socket.on("roomEntered", ({ playerId }) => { ownId = playerId; });
socket.on("roomState", (state) => { room = state; render(); socket.emit("test:state"); });
socket.on("test:state", (state) => { serverState = state; $("#state").textContent = JSON.stringify(state, null, 2); render(); });
socket.on("test:healthApplied", ({ value, amount }) => notify(`Изменено на ${amount}: ${value}`));
socket.on("test:notification", ({ message }) => notify(message));
socket.on("test:specialApplied", ({ amount, value }) => notify(`Спецкарта применена${amount ? ` на ${amount} стадии` : ""}${value ? `: ${value}` : ""}.`));
socket.on("errorMessage", notify);
socket.on("connect", () => notify("Тестовый сервер подключён."));
