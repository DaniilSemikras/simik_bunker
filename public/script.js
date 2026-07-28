const socket = io();
const $ = (selector) => document.querySelector(selector);

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const cursorAura = document.createElement("div");
    cursorAura.className = "cursor-aura";
    document.body.prepend(cursorAura);
    let pointerFrame = 0;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 5;
    const moveAura = (clientX, clientY) => {
        pointerX = clientX;
        pointerY = clientY;
        cursorAura.classList.add("is-visible");
        if (pointerFrame) return;
        pointerFrame = requestAnimationFrame(() => {
            cursorAura.style.transform = `translate3d(${pointerX - 260}px, ${pointerY - 260}px, 0)`;
            const shiftX = (pointerX - window.innerWidth / 2) * -0.018;
            const shiftY = (pointerY - window.innerHeight / 2) * -0.014;
            document.documentElement.style.setProperty("--bunker-x", `${shiftX}px`);
            document.documentElement.style.setProperty("--bunker-y", `${shiftY}px`);
            pointerFrame = 0;
        });
    };
    document.addEventListener("pointermove", (event) => {
        if (event.pointerType !== "touch") moveAura(event.clientX, event.clientY);
    }, { passive: true });
    document.addEventListener("mousemove", (event) => moveAura(event.clientX, event.clientY), { passive: true });
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
    document.body.classList.toggle("in-menu", screen === "#menu");
    document.body.classList.toggle("in-lobby", screen === "#lobby");
    document.body.classList.toggle("in-game", screen === "#game");
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
        story: [[147, 0, .19], [175, .13, .22], [110, .31, .34]],
        round: [[196, 0, .13], [233, .13, .16], [277, .29, .2], [196, .51, .28]],
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
        oscillator.type = ["out", "skip", "story", "round"].includes(type) ? "triangle" : "sine";
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
    const playerTotal = activePlayers().length;
    $("#playerCount").textContent = `${playerTotal}/12`;
    $("#hostNote").textContent = isHost() ? "Вы ведущий. Когда все подключатся, запускайте игру." : "Ожидайте, пока ведущий начнёт игру.";
    $("#players").innerHTML = room.players.map((player) => `
        <div class="player-row ${player.left ? "left-player" : ""}">${avatarMarkup(player)}<span>${escaped(player.nickname)}</span>${player.left ? '<span class="host-badge">вышел</span>' : player.id === room.hostId ? '<span class="host-badge">ведущий</span>' : ""}</div>
    `).join("");
    $("#startGame").classList.toggle("hidden", !isHost());
    $("#startSoloTest").classList.toggle("hidden", !isHost() || playerTotal !== 1);
    $("#startHint").textContent = playerTotal === 1 && isHost()
        ? "В тесте можно раскрыть все карточки — без голосования."
        : playerTotal < 3
        ? "Для обычного старта нужно минимум 3 игрока."
        : isHost() ? "После старта половина игроков сможет остаться в бункере." : "";
}

function cardMarkup(trait, value, revealed, canChoose, isRevealing = false) {
    const status = canChoose ? "раскрыть" : revealed ? "раскрыта" : "не раскрыта";
    const content = `<span>${escaped(traitName(trait))}</span><strong>${escaped(value)}</strong><em>${status}</em>`;
    const classes = `my-card ${revealed ? "is-revealed" : ""} ${canChoose ? "is-choice" : ""} ${isRevealing ? "is-revealing" : ""}`;
    return canChoose
        ? `<button type="button" class="${classes}" data-reveal-trait="${trait}">${content}</button>`
        : `<article class="${classes}">${content}</article>`;
}

function updateGame() {
    if (!room) return;
    const me = room.players.find((player) => player.id === socket.id);
    const active = activePlayers();
    const trait = room.currentTrait;
    const isStory = room.phase === "story";
    const isVoting = room.phase === "voting";
    const isFinished = room.phase === "finished";
    const myRevealed = me?.revealed || {};
    const hasRevealedThisRound = Boolean(room.revealedThisRound?.[socket.id]);
    const isChoiceRound = room.phase === "reveal" && !trait;
    const turnPlayer = room.players.find((player) => player.id === room.turnPlayerId);
    const isMyTurn = room.turnPlayerId === socket.id;
    const hasVoted = room.votedPlayerIds?.includes(socket.id);

    $("#gameCode").textContent = room.code;
    $("#phaseTitle").textContent = isFinished ? "Игра завершена" : isStory ? "История катастрофы" : isVoting ? "Голосование" : "Раскрытие карт";
    const bunkerChance = isFinished && typeof room.bunkerSurvivalChance === "number"
        ? `<span class="bunker-chance">Прогноз выживания бункера: <strong>${room.bunkerSurvivalChance}%</strong></span>`
        : "";
    const disasterText = escaped(room.disaster || "");
    const disasterContent = isStory
        ? `<span class="eyebrow">КАТАСТРОФА</span><p class="story-text">${disasterText}</p><div class="disaster-meta"><span class="capacity">Мест в бункере: ${room.capacity}</span>${isHost() ? '<button class="button primary story-ready" type="button" data-acknowledge-story>Все прочитали историю — начать раунд</button>' : '<span class="story-wait">Ждём, пока ведущий начнёт раунд.</span>'}</div>`
        : `<details class="disaster-accordion"><summary><span class="eyebrow">КАТАСТРОФА · ОТКРЫТЬ ИСТОРИЮ</span><span class="accordion-icon" aria-hidden="true">⌄</span></summary><p>${disasterText}</p></details><div class="disaster-meta"><span class="capacity">Мест в бункере: ${room.capacity}</span>${bunkerChance}</div>`;
    $("#disasterCard").classList.toggle("story-mode", isStory);
    $("#disasterCard").innerHTML = disasterContent;
    $("#survivorCount").textContent = `${active.length} в игре`;
    const categoryCount = room.categoryOrder?.length || Object.keys(myCards).length;
    const revealRoundCount = room.revealRounds || categoryCount;
    $(".round-panel").classList.toggle("hidden", isStory);
    $("#roundLabel").textContent = isFinished ? "ИГРА ЗАВЕРШЕНА" : isStory ? "ИСТОРИЯ КАТАСТРОФЫ" : isVoting ? "ГОЛОСОВАНИЕ" : `РАУНД ${room.round} ИЗ ${revealRoundCount}`;
    $("#roundTitle").textContent = isFinished ? "Бункер определил выживших" : isStory ? "Прочитайте историю" : isVoting ? "Кого не берём в бункер?" : trait ? `Первый ход: ${traitName(trait)}` : "Выберите карту для раскрытия";
    $("#roundDescription").textContent = isFinished ? "Поздравьте тех, кому удалось попасть внутрь." : isStory ? "Игра начнётся, когда ведущий подтвердит, что все успели прочитать историю." : isVoting ? "Выберите одного игрока. Голос нельзя изменить." : trait ? "В первом раунде все обязаны раскрыть эту категорию." : "Теперь каждый сам выбирает одну ещё скрытую карту.";

    const canRevealProfession = room.phase === "reveal" && trait && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    const canChooseTrait = isChoiceRound && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    const canSkipVote = isVoting && me && !me.eliminated && !hasVoted;
    $("#revealButton").classList.toggle("hidden", !canRevealProfession);
    $("#revealButton").textContent = canRevealProfession ? `Раскрыть: ${traitName(trait)}` : "";
    $("#skipVoteButton").classList.toggle("hidden", !canSkipVote);
    $("#actionHint").textContent = isFinished ? "Игра завершена." : isStory ? (isHost() ? "Подтвердите начало, когда все прочитали историю." : "Ждём подтверждения ведущего.") : me?.eliminated ? "Вы исключены, но можете наблюдать за игрой." : isVoting && hasVoted ? "Ваш голос принят. Ждём остальных." : isVoting ? "Голосуйте до окончания таймера." : hasRevealedThisRound ? "Карта раскрыта. Ждём остальных." : isMyTurn && canChooseTrait ? "Ваш ход: нажмите на любую ещё нераскрытую карточку." : isMyTurn ? "Ваш ход: раскройте профессию." : turnPlayer ? `Сейчас ходит ${turnPlayer.nickname}.` : "";

    const cardOrder = room.categoryOrder?.length ? room.categoryOrder : Object.keys(myCards);
    $("#myCards").innerHTML = cardOrder.filter((name) => name in myCards).map((name) => cardMarkup(
        name,
        myCards[name],
        Boolean(myRevealed[name]),
        canChooseTrait && !myRevealed[name],
        room.revealedThisRound?.[socket.id] === name
    )).join("");
    $("#gamePlayers").innerHTML = room.players.map((player) => {
        const playerCards = Object.entries(player.revealed || {}).map(([name, value]) => `<span class="public-card ${room.revealedThisRound?.[player.id] === name ? "is-revealing" : ""}"><b>${escaped(traitName(name))}:</b> ${escaped(value)}</span>`).join("");
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
$("#startSoloTest").addEventListener("click", () => socket.emit("startSoloTest"));
$("#revealButton").addEventListener("click", () => {
    socket.emit("revealTrait", room?.currentTrait);
    playSound("reveal");
});
$("#skipVoteButton").addEventListener("click", () => socket.emit("skipVote"));
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
$("#disasterCard").addEventListener("click", (event) => {
    if (event.target.closest("[data-acknowledge-story]")) socket.emit("acknowledgeStory");
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
socket.on("gameStarted", () => { toast("Катастрофа выбрана. Прочитайте историю перед началом."); playSound("story"); });
socket.on("roundStarted", ({ initial } = {}) => { toast(initial ? "История прочитана. Первый раунд начинается." : "Новый раунд: выберите карту, которую хотите раскрыть."); playSound("round"); });
socket.on("cardRevealed", ({ playerId }) => { if (playerId !== socket.id) playSound("reveal"); });
socket.on("votingStarted", () => { toast("Все раскрылись. Пора голосовать."); playSound("vote"); });
socket.on("voteAccepted", () => { toast("Ваш голос принят."); playSound("accepted"); });
socket.on("playerEliminated", ({ nickname: name }) => { toast(`${name} не попадает в бункер.`); playSound("out"); });
socket.on("turnSkipped", ({ nickname: name }) => { toast(`${name} не успел раскрыть карту — ход пропущен.`); playSound("skip"); });
socket.on("voteTied", ({ nextRound } = {}) => { toast(nextRound ? "Голоса разделились. Открываем следующую карту." : "Ничья: никто не исключен."); playSound("tie"); });
socket.on("voteSkipped", () => { toast("Решение команды: никого не исключаем. Начинается следующий раунд."); playSound("tie"); });
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
