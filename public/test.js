const socket = io();
const $ = (selector) => document.querySelector(selector);
let room = null;
let ownId = "";

function notify(message) {
    $("#notice").textContent = message;
    $("#notice").classList.add("visible");
    setTimeout(() => $("#notice").classList.remove("visible"), 2600);
}

function render() {
    if (!room) return;
    $("#summary").textContent = `${room.code} · ${room.phase} · раунд ${room.round || 0} · мест ${room.capacity || 0}`;
    $("#capacity").value = room.capacity || 1;
    $("#players").innerHTML = (room.players || []).map((player) => `<article class="${player.eliminated ? "out" : ""}"><strong>${player.nickname}${player.id === ownId ? " (вы)" : ""}</strong><span>${player.eliminated ? "исключён" : player.isBot ? "бот" : "игрок"}</span><small>${Object.entries(player.revealed || {}).map(([key, value]) => `${key}: ${value}`).join(" · ") || "карты скрыты"}</small></article>`).join("");
    const selectedPlayer = $("#targetPlayer").value;
    $("#targetPlayer").innerHTML = (room.players || []).map((player) => `<option value="${player.id}">${player.nickname}</option>`).join("");
    if ([...$("#targetPlayer").options].some((option) => option.value === selectedPlayer)) $("#targetPlayer").value = selectedPlayer;
    const selectedTrait = $("#targetTrait").value;
    $("#targetTrait").innerHTML = (room.categoryOrder || []).map((trait) => `<option value="${trait}">${room.categoryNames?.[trait] || trait}</option>`).join("");
    if ([...$("#targetTrait").options].some((option) => option.value === selectedTrait)) $("#targetTrait").value = selectedTrait;
}

document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    if (action === "create") socket.emit("test:createRoom", { nickname: "Тестировщик" });
    if (action === "players") socket.emit("test:setPlayers", { count: Number($("#playerCount").value) });
    if (action === "bots") socket.emit("test:addBots", { count: Number($("#botCount").value) });
    if (action === "start") socket.emit("test:start");
    if (action === "advance") socket.emit("test:advance");
    if (action === "previous") socket.emit("test:previous");
    if (action === "vote") socket.emit("test:openVoting");
    if (action === "tie") socket.emit("test:forceTie");
    if (action === "notify") socket.emit("test:notify");
    if (action === "reveal") socket.emit("test:reveal", { targetId: $("#targetPlayer").value, trait: $("#targetTrait").value });
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
socket.on("test:state", (state) => { $("#state").textContent = JSON.stringify(state, null, 2); });
socket.on("test:healthApplied", ({ value, amount }) => notify(`Изменено на ${amount}: ${value}`));
socket.on("test:notification", ({ message }) => notify(message));
socket.on("test:specialApplied", ({ amount, value }) => notify(`Спецкарта применена${amount ? ` на ${amount} стадии` : ""}${value ? `: ${value}` : ""}.`));
socket.on("errorMessage", notify);
socket.on("connect", () => notify("Тестовый сервер подключён."));
