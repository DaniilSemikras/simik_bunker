const socket = io();
const $ = (selector) => document.querySelector(selector);

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let pointerFrame = 0;
    let pointerX = 50;
    let pointerY = 18;
    document.addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch") return;
        document.documentElement.classList.add("has-pointer-glow");
        pointerX = (event.clientX / window.innerWidth) * 100;
        pointerY = (event.clientY / window.innerHeight) * 100;
        if (pointerFrame) return;
        pointerFrame = requestAnimationFrame(() => {
            document.documentElement.style.setProperty("--cursor-x", `${pointerX}%`);
            document.documentElement.style.setProperty("--cursor-y", `${pointerY}%`);
            pointerFrame = 0;
        });
    }, { passive: true });
}

const TRAIT_NAMES = {
    health: "Здоровье",
    profession: "Профессия",
    gender: "Пол",
    age: "Возраст",
    body: "Телосложение",
    parents: "Родители",
    backpack: "Рюкзак",
    specialAbility: "Спецвозможность"
};

let room = null;
let myCards = {};
let currentCode = "";
const SESSION_KEY = "bunker-player-session";
let savedSession = (() => {
    try {
        const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
        return value?.code && value?.token ? value : null;
    } catch {
        return null;
    }
})();
let resumedSocketId = "";
let toastTimer;
let countdownTimer;
let audioContext;
let soundsEnabled = localStorage.getItem("bunker-sounds") !== "off";
let lastTurnSoundKey = "";

function show(screen) {
    ["#menu", "#lobby", "#game"].forEach((id) => $(id).classList.toggle("hidden", id !== screen));
}

function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("visible"), 4500);
}

function updateSoundToggle() {
    const button = $("#soundToggle");
    button.setAttribute("aria-pressed", String(soundsEnabled));
    button.textContent = soundsEnabled ? "🔊 Звук" : "🔇 Звук";
}

function unlockSound() {
    if (!soundsEnabled || !window.AudioContext && !window.webkitAudioContext) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext ||= new AudioContextClass();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
}

function playSound(type) {
    if (!soundsEnabled) return;
    unlockSound();
    if (!audioContext || audioContext.state !== "running") return;
    const patterns = {
        start: [[392, 0, .12], [523, .13, .17]],
        turn: [[740, 0, .09], [988, .11, .13]],
        reveal: [[660, 0, .11], [880, .12, .16]],
        vote: [[300, 0, .13]],
        accepted: [[540, 0, .1]],
        tie: [[440, 0, .14], [370, .16, .18]],
        skip: [[240, 0, .16]],
        out: [[300, 0, .12], [220, .14, .2]],
        finish: [[523, 0, .12], [659, .13, .12], [784, .26, .2]]
    };
    for (const [frequency, offset, duration] of patterns[type] || []) {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const start = audioContext.currentTime + offset;
        oscillator.type = type === "out" || type === "skip" ? "triangle" : "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(.0001, start);
        gain.gain.exponentialRampToValueAtTime(.08, start + .018);
        gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + .02);
    }
}

function escaped(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function isHost() {
    return room?.hostId === socket.id;
}

function activePlayers() {
    return room?.players.filter((player) => !player.left && !player.eliminated) || [];
}

function traitName(trait) {
    return room?.categoryNames?.[trait] || TRAIT_NAMES[trait] || trait;
}

function updateActionTimer() {
    const timer = $("#actionTimer");
    const deadline = room?.phase === "voting" ? room.voteDeadline : room?.phase === "reveal" ? room.turnDeadline : null;
    if (!deadline) {
        timer.classList.add("hidden");
        return;
    }
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const kind = room.phase === "voting" ? "До конца голосования" : "Время хода";
    timer.textContent = `${kind}: ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    timer.classList.toggle("urgent", seconds <= 10);
    timer.classList.remove("hidden");
}

function nickname() {
    return $("#nickname").value.trim();
}

function fallbackInitial(value = nickname()) {
    return String(value).trim().charAt(0).toUpperCase() || "?";
}

function avatarMarkup(player) {
    if (player.avatarUrl) return `<img class="avatar avatar-image" src="${escaped(player.avatarUrl)}" alt="">`;
    return `<span class="avatar">${escaped(fallbackInitial(player.nickname))}</span>`;
}

function playerPayload() {
    return { nickname: nickname() };
}

function updateLobby() {
    if (!room) return;
    $("#roomTitle").textContent = room.code;
    $("#playerCount").textContent = `${activePlayers().length}/12`;
    $("#hostNote").textContent = isHost() ? "Вы ведущий. Когда все подключатся, запускайте игру." : "Ожидайте, пока ведущий начнёт игру.";
    $("#players").innerHTML = room.players.map((player) => `
        <div class="player-row ${player.left ? "left-player" : ""}">${avatarMarkup(player)}<span>${escaped(player.nickname)}</span>${player.left ? '<span class="host-badge">вышел</span>' : player.id === room.hostId ? '<span class="host-badge">ведущий</span>' : ""}</div>
    `).join("");
    $("#startGame").classList.toggle("hidden", !isHost());
    $("#startHint").textContent = activePlayers().length < 3 ? "Для старта нужно минимум 3 игрока." : isHost() ? "После старта половина игроков сможет остаться в бункере." : "";
}

function cardMarkup(trait, value, revealed, canChoose) {
    const status = canChoose ? "раскрыть" : revealed ? "раскрыта" : "не раскрыта";
    const content = `<span>${escaped(traitName(trait))}</span><strong>${escaped(value)}</strong><em>${status}</em>`;
    const classes = `my-card ${revealed ? "is-revealed" : ""} ${canChoose ? "is-choice" : ""}`;
    return canChoose
        ? `<button type="button" class="${classes}" data-reveal-trait="${trait}">${content}</button>`
        : `<article class="${classes}">${content}</article>`;
}

function updateGame() {
    if (!room) return;
    const me = room.players.find((player) => player.id === socket.id);
    const active = activePlayers();
    const trait = room.currentTrait;
    const isVoting = room.phase === "voting";
    const isFinished = room.phase === "finished";
    const myRevealed = me?.revealed || {};
    const hasRevealedThisRound = Boolean(room.revealedThisRound?.[socket.id]);
    const isChoiceRound = room.phase === "reveal" && !trait;
    const turnPlayer = room.players.find((player) => player.id === room.turnPlayerId);
    const isMyTurn = room.turnPlayerId === socket.id;
    const hasVoted = room.votedPlayerIds?.includes(socket.id);

    $("#gameCode").textContent = room.code;
    $("#phaseTitle").textContent = isFinished ? "Игра завершена" : isVoting ? "Голосование" : "Раскрытие карт";
    const bunkerChance = isFinished && typeof room.bunkerSurvivalChance === "number"
        ? `<span class="bunker-chance">Прогноз выживания бункера: <strong>${room.bunkerSurvivalChance}%</strong></span>`
        : "";
    $("#disasterCard").innerHTML = `<span class="eyebrow">КАТАСТРОФА</span><p>${escaped(room.disaster || "")}</p><div class="disaster-meta"><span class="capacity">Мест в бункере: ${room.capacity}</span>${bunkerChance}</div>`;
    $("#survivorCount").textContent = `${active.length} в игре`;
    const categoryCount = room.categoryOrder?.length || Object.keys(myCards).length;
    const revealRoundCount = room.revealRounds || categoryCount;
    $("#roundLabel").textContent = isFinished ? "ИГРА ЗАВЕРШЕНА" : isVoting ? "ГОЛОСОВАНИЕ" : `РАУНД ${room.round} ИЗ ${revealRoundCount}`;
    $("#roundTitle").textContent = isFinished ? "Бункер определил выживших" : isVoting ? "Кого не берём в бункер?" : trait ? `Первый ход: ${traitName(trait)}` : "Выберите карту для раскрытия";
    $("#roundDescription").textContent = isFinished ? "Поздравьте тех, кому удалось попасть внутрь." : isVoting ? "Выберите одного игрока. Голос нельзя изменить." : trait ? "В первом раунде все обязаны раскрыть эту категорию." : "Теперь каждый сам выбирает одну ещё скрытую карту.";

    const canRevealProfession = room.phase === "reveal" && trait && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    const canChooseTrait = isChoiceRound && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    $("#revealButton").classList.toggle("hidden", !canRevealProfession);
    $("#revealButton").textContent = canRevealProfession ? `Раскрыть: ${traitName(trait)}` : "";
    $("#actionHint").textContent = me?.eliminated ? "Вы исключены, но можете наблюдать за игрой." : isVoting && hasVoted ? "Ваш голос принят. Ждём остальных." : isVoting ? "Голосуйте до окончания таймера." : hasRevealedThisRound ? "Карта раскрыта. Ждём остальных." : isMyTurn && canChooseTrait ? "Ваш ход: нажмите на любую ещё нераскрытую карточку." : isMyTurn ? "Ваш ход: раскройте профессию." : turnPlayer ? `Сейчас ходит ${turnPlayer.nickname}.` : "";

    const cardOrder = room.categoryOrder?.length ? room.categoryOrder : Object.keys(myCards);
    $("#myCards").innerHTML = cardOrder.filter((name) => name in myCards).map((name) => cardMarkup(name, myCards[name], Boolean(myRevealed[name]), canChooseTrait && !myRevealed[name])).join("");
    $("#gamePlayers").innerHTML = room.players.map((player) => {
        const playerCards = Object.entries(player.revealed || {}).map(([name, value]) => `<span class="public-card"><b>${escaped(traitName(name))}:</b> ${escaped(value)}</span>`).join("");
        const canVote = isVoting && !hasVoted && !me?.eliminated && !player.left && !player.eliminated && player.id !== socket.id;
        const playerState = player.left ? "left-player" : player.eliminated ? "eliminated" : isFinished ? "survivor" : "active-player";
        const playerStatus = player.left ? "вышел" : player.eliminated ? "выбыл" : isFinished ? "в бункере" : "в игре";
        return `<article class="game-player ${playerState}">
            <div class="player-name">${avatarMarkup(player)}<div><strong>${escaped(player.nickname)}${player.id === socket.id ? " (вы)" : ""}</strong><small>${playerStatus}</small></div></div>
            <div class="public-cards">${playerCards || '<span class="muted">карты ещё не раскрыты</span>'}</div>
            ${canVote ? `<button class="vote-button" data-vote="${player.id}">Исключить</button>` : ""}
            ${player.id === room.hostId ? '<span class="host-star" aria-label="Ведущий" title="Ведущий">★</span>' : ""}
        </article>`;
    }).join("");
    updateActionTimer();
}

function renderRoom() {
    if (!room) return;
    if (room.phase === "lobby") {
        show("#lobby");
        updateLobby();
    } else {
        show("#game");
        updateGame();
    }
}

function enterRoom({ code, playerToken }) {
    currentCode = code;
    if (playerToken) {
        savedSession = { code, token: playerToken };
        localStorage.setItem(SESSION_KEY, JSON.stringify(savedSession));
    }
    $("#roomTitle").textContent = code;
}

function clearSavedSession() {
    savedSession = null;
    localStorage.removeItem(SESSION_KEY);
}

function tryResumeSession() {
    if (!savedSession || resumedSocketId === socket.id) return;
    resumedSocketId = socket.id;
    socket.emit("resumeRoom", { roomCode: savedSession.code, playerToken: savedSession.token });
}

$("#createRoom").addEventListener("click", () => socket.emit("createRoom", playerPayload()));
$("#joinRoom").addEventListener("click", () => socket.emit("joinRoom", { roomCode: $("#roomCode").value, ...playerPayload() }));
$("#nickname").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#createRoom").click(); });
$("#roomCode").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("#startGame").addEventListener("click", () => socket.emit("startGame"));
$("#revealButton").addEventListener("click", () => {
    socket.emit("revealTrait", room?.currentTrait);
    playSound("reveal");
});
$("#soundToggle").addEventListener("click", () => {
    soundsEnabled = !soundsEnabled;
    localStorage.setItem("bunker-sounds", soundsEnabled ? "on" : "off");
    updateSoundToggle();
    if (soundsEnabled) playSound("accepted");
});
$("#leaveLobby").addEventListener("click", () => socket.emit("leaveRoom"));
$("#leaveGame").addEventListener("click", () => socket.emit("leaveRoom"));
$("#copyCode").addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(currentCode);
        toast("Код комнаты скопирован.");
    } catch {
        toast(`Код комнаты: ${currentCode}`);
    }
});
$("#gamePlayers").addEventListener("click", (event) => {
    const button = event.target.closest("[data-vote]");
    if (button) socket.emit("castVote", button.dataset.vote);
});
$("#myCards").addEventListener("click", (event) => {
    const card = event.target.closest("[data-reveal-trait]");
    if (card) {
        socket.emit("revealTrait", card.dataset.revealTrait);
        playSound("reveal");
    }
});

socket.on("roomEntered", enterRoom);
socket.on("roomState", (state) => {
    const turnKey = `${state.code}:${state.round}:${state.turnPlayerId || ""}:${state.turnDeadline || ""}`;
    const isMyTurn = state.phase === "reveal" && state.turnPlayerId === socket.id;
    room = state;
    renderRoom();
    if (isMyTurn && turnKey !== lastTurnSoundKey) playSound("turn");
    lastTurnSoundKey = turnKey;
});
socket.on("leftRoom", () => {
    room = null;
    myCards = {};
    currentCode = "";
    clearSavedSession();
    $("#roomCode").value = "";
    show("#menu");
});
socket.on("resumeFailed", () => {
    clearSavedSession();
    currentCode = "";
    toast("Комната уже закрыта или сессия устарела.");
    show("#menu");
});
socket.on("yourCards", (cards) => { myCards = cards; if (room?.phase !== "lobby") updateGame(); });
socket.on("gameStarted", () => { toast("Игра началась. Ваша карта — только для ваших глаз."); playSound("start"); });
socket.on("roundStarted", () => { toast("Новый раунд: выберите карту, которую хотите раскрыть."); playSound("start"); });
socket.on("votingStarted", () => { toast("Все раскрылись. Пора голосовать."); playSound("vote"); });
socket.on("voteAccepted", () => { toast("Ваш голос принят."); playSound("accepted"); });
socket.on("playerEliminated", ({ nickname: name }) => { toast(`${name} не попадает в бункер.`); playSound("out"); });
socket.on("turnSkipped", ({ nickname: name }) => { toast(`${name} не успел раскрыть карту — ход пропущен.`); playSound("skip"); });
socket.on("voteTied", () => { toast("Ничья: никто не исключен. Начинается следующий раунд."); playSound("tie"); });
socket.on("revealLimitReached", () => { toast("Лимит раскрытий достигнут: оставшиеся карты останутся тайной."); playSound("vote"); });
socket.on("gameFinished", ({ survivors }) => { toast(`Выжили: ${survivors.join(", ")}.`); playSound("finish"); });
socket.on("errorMessage", toast);
socket.on("disconnect", () => toast("Соединение с сервером потеряно."));
socket.on("connect", tryResumeSession);

clearInterval(countdownTimer);
countdownTimer = setInterval(updateActionTimer, 250);
updateSoundToggle();
document.addEventListener("pointerdown", unlockSound, { once: true });
document.addEventListener("keydown", unlockSound, { once: true });
if (socket.connected) tryResumeSession();
