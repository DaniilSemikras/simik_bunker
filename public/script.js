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
            document.documentElement.style.setProperty("--flashlight-x", `${pointerX}px`);
            document.documentElement.style.setProperty("--flashlight-y", `${pointerY}px`);
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
    specialAbility: "Спецвозможность",
    professionItem: "Багаж от профессии"
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
let pendingRevealAnimation = null;
let renderedRevealAnimation = null;
let mySpecialCard = null;
let specialTargetMode = false;

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
    const deadline = room?.phase === "finished"
        ? room.roomCloseDeadline
        : room?.phase === "voting"
            ? room.voteDeadline
            : room?.phase === "reveal"
                ? room.turnDeadline
                : null;
    if (!deadline) {
        timer.classList.add("hidden");
        return;
    }
    const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const kind = room.phase === "finished" ? "Комната закроется через" : room.phase === "voting" ? "До конца голосования" : "Время хода";
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
    $("#addTestPlayers").classList.toggle("hidden", !isHost() || playerTotal >= 12);
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
    const winners = room.players.filter((player) => !player.left && !player.eliminated);
    const myRevealed = me?.revealed || {};
    const hasRevealedThisRound = Boolean(room.revealedThisRound?.[socket.id]);
    const isChoiceRound = room.phase === "reveal" && !trait;
    const turnPlayer = room.players.find((player) => player.id === room.turnPlayerId);
    const isMyTurn = room.turnPlayerId === socket.id;
    const hasVoted = room.votedPlayerIds?.includes(socket.id);
    const canUseSpecialCard = Boolean(mySpecialCard && !mySpecialCard.used && me && !me.eliminated && ["reveal", "voting"].includes(room.phase));
    const specialTraitLabel = !mySpecialCard ? "" : mySpecialCard.effect === "take_backpack" ? "Забрать: Рюкзак" : `Обмен: ${traitName(mySpecialCard.trait)}`;
    const specialTargetAction = !mySpecialCard ? "" : mySpecialCard.effect === "take_backpack" ? "Забрать рюкзак" : `Обменяться: ${traitName(mySpecialCard.trait)}`;
    if (!canUseSpecialCard) specialTargetMode = false;

    $("#gameCode").textContent = room.code;
    $("#phaseTitle").textContent = isFinished ? "Игра завершена" : isStory ? "История катастрофы" : isVoting ? "Голосование" : "Раскрытие карт";
    $("#resultsBanner").classList.toggle("hidden", !isFinished);
    $("#resultsBanner").innerHTML = isFinished ? `
        <div class="result-copy"><span class="result-kicker">ПОБЕДИТЕЛИ БУНКЕРА</span><h3>${winners.length ? "В бункере остались" : "Выживших не осталось"}</h3></div>
        <div class="winner-list">${winners.map((player) => `<span class="winner-chip">${avatarMarkup(player)}<strong>${escaped(player.nickname)}</strong></span>`).join("")}</div>
    ` : "";
    const bunkerChance = isFinished && typeof room.bunkerSurvivalChance === "number"
        ? `<span class="bunker-chance">Прогноз выживания бункера: <strong>${room.bunkerSurvivalChance}%</strong></span>`
        : "";
    const disasterText = escaped(room.disaster || "");
    const disasterContent = isStory
        ? `<span class="eyebrow">КАТАСТРОФА</span><p class="story-text">${disasterText}</p><div class="disaster-meta"><span class="capacity">Мест в бункере: ${room.capacity}</span>${isHost() ? '<button class="button primary story-ready" type="button" data-acknowledge-story>Все прочитали историю — начать раунд</button>' : '<span class="story-wait">Ждём, пока ведущий начнёт раунд.</span>'}</div>`
        : `<details class="disaster-accordion"><summary><span class="eyebrow">КАТАСТРОФА · ОТКРЫТЬ ИСТОРИЮ</span><span class="accordion-icon" aria-hidden="true">⌄</span></summary><p>${disasterText}</p></details><div class="disaster-meta"><span class="capacity">Мест в бункере: ${room.capacity}</span>${bunkerChance}</div>`;
    $("#disasterCard").classList.toggle("story-mode", isStory);
    $("#disasterCard").innerHTML = disasterContent;
    const bunkerTraits = Array.isArray(room.bunkerTraits) ? room.bunkerTraits : [];
    $("#bunkerTraitsPanel").classList.toggle("hidden", !bunkerTraits.length);
    $("#bunkerTraits").innerHTML = bunkerTraits.map((trait) => [
        '<article class="bunker-trait-card">',
        '<span>' + escaped(trait.name) + '</span>',
        '<strong>' + escaped(trait.value) + '</strong>',
        '</article>'
    ].join("")).join("");
    $("#survivorCount").textContent = `${active.length} в игре`;
    const categoryCount = room.categoryOrder?.length || Object.keys(myCards).length;
    const revealRoundCount = room.revealRounds || categoryCount;
    $(".round-panel").classList.toggle("hidden", isStory);
    $("#roundLabel").textContent = isFinished ? "ИГРА ЗАВЕРШЕНА" : isStory ? "ИСТОРИЯ КАТАСТРОФЫ" : isVoting ? "ГОЛОСОВАНИЕ" : `РАУНД ${room.round} ИЗ ${revealRoundCount}`;
    $("#roundTitle").textContent = isFinished ? "Бункер определил выживших" : isStory ? "Прочитайте историю" : isVoting ? "Кого не берём в бункер?" : trait ? `Первый ход: ${traitName(trait)}` : "Выберите карту для раскрытия";
    $("#roundDescription").textContent = isFinished ? "Поздравьте тех, кому удалось попасть внутрь." : isStory ? "Игра начнётся, когда ведущий подтвердит, что все успели прочитать историю." : isVoting ? "Выберите одного игрока. Голос нельзя изменить." : trait ? "В первом раунде все обязаны раскрыть эту категорию." : "Теперь каждый сам выбирает одну ещё скрытую карту.";

    const canRevealProfession = room.phase === "reveal" && trait && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    const canChooseTrait = isChoiceRound && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    const canSkipVote = isVoting && room.voteCanBeSkipped !== false && me && !me.eliminated && !hasVoted;
    const revealAnimation = pendingRevealAnimation !== renderedRevealAnimation ? pendingRevealAnimation : null;
    const isNewReveal = (playerId, traitId) => Boolean(
        revealAnimation && revealAnimation.playerId === playerId && revealAnimation.trait === traitId
    );
    $("#revealButton").classList.toggle("hidden", !canRevealProfession);
    $("#revealButton").textContent = canRevealProfession ? `Раскрыть: ${traitName(trait)}` : "";
    $("#skipVoteButton").classList.toggle("hidden", !canSkipVote);
    $("#actionHint").textContent = isFinished ? "Игра завершена." : isStory ? (isHost() ? "Подтвердите начало, когда все прочитали историю." : "Ждём подтверждения ведущего.") : me?.eliminated ? "Вы исключены, но можете наблюдать за игрой." : specialTargetMode ? `Выберите игрока: ${specialTargetAction.toLocaleLowerCase("ru")}.` : isVoting && hasVoted ? "Ваш голос принят. Ждём остальных." : isVoting ? "Голосуйте до окончания таймера." : hasRevealedThisRound ? "Карта раскрыта. Ждём остальных." : isMyTurn && canChooseTrait ? "Ваш ход: нажмите на любую ещё нераскрытую карточку." : isMyTurn ? "Ваш ход: раскройте профессию." : turnPlayer ? `Сейчас ходит ${turnPlayer.nickname}.` : "";

    const cardOrder = room.categoryOrder?.length ? room.categoryOrder : Object.keys(myCards);
    const personalCards = cardOrder.filter((name) => name in myCards).map((name) => cardMarkup(
        name,
        myCards[name],
        Boolean(myRevealed[name]),
        canChooseTrait && !myRevealed[name],
        isNewReveal(socket.id, name)
    )).join("");
    const professionBaggage = me?.professionItem
        ? '<article class="my-card is-revealed profession-item-card"><span>Багаж от профессии</span><strong>' + escaped(me.professionItem) + '</strong><em>получен</em></article>'
        : "";
    const specialCardInHand = mySpecialCard
        ? '<' + (canUseSpecialCard ? 'button type="button" data-use-special' : 'article') + ' class="my-card special-card-hand ' + (mySpecialCard.used ? 'is-used' : '') + (canUseSpecialCard ? ' is-choice' : '') + '"><span>Специальная карта</span><strong>' + escaped(mySpecialCard.name) + '</strong><small>' + escaped(specialTraitLabel) + '</small><em>' + (mySpecialCard.used ? 'использована' : specialTargetMode ? 'выберите игрока' : canUseSpecialCard ? 'нажмите, чтобы применить' : 'доступна во время игры') + '</em></' + (canUseSpecialCard ? 'button' : 'article') + '>'
        : "";
    $("#myCards").innerHTML = personalCards + professionBaggage + specialCardInHand;
    $("#gamePlayers").innerHTML = room.players.map((player) => {
        const playerCards = Object.entries(player.revealed || {}).map(([name, value]) => `<span class="public-card ${isNewReveal(player.id, name) ? "is-revealing" : ""}"><b>${escaped(traitName(name))}:</b> ${escaped(value)}</span>`).join("")
            + (player.professionItem ? `<span class="public-card profession-item"><b>Багаж:</b> ${escaped(player.professionItem)}</span>` : "")
            + (player.usedSpecialCard ? `<span class="public-card special-card-used"><b>Спецкарта:</b> ${escaped(player.usedSpecialCard.name)}</span>` : "");
        const canVote = isVoting && !hasVoted && !me?.eliminated && !player.left && !player.eliminated && player.id !== socket.id;
        const canSelectSpecialTarget = specialTargetMode && !player.left && !player.eliminated && player.id !== socket.id;
        const playerActions = [
            canSelectSpecialTarget ? `<button class="special-target-button" data-special-target="${player.id}">${escaped(specialTargetAction)}</button>` : "",
            canVote ? `<button class="vote-button" data-vote="${player.id}">Исключить</button>` : ""
        ].filter(Boolean).join("");
        const voters = (room.voteMarkers?.[player.id] || [])
            .map((voterId) => room.players.find((candidate) => candidate.id === voterId))
            .filter(Boolean);
        const visibleVoters = voters.slice(0, 4);
        const voteMarkerMarkup = visibleVoters.length
            ? '<div class="vote-markers" aria-label="Голоса против игрока">' + visibleVoters.map((voter) => (
                '<span class="vote-avatar" title="' + escaped(voter.nickname) + '">' + avatarMarkup(voter) + '</span>'
            )).join("") + (voters.length > visibleVoters.length ? '<span class="vote-more">+' + (voters.length - visibleVoters.length) + '</span>' : '') + '</div>'
            : "";
        const playerState = player.left ? "left-player" : player.eliminated ? "eliminated" : isFinished ? "survivor" : "active-player";
        const playerStatus = player.left ? "вышел" : player.eliminated ? "исключён" : isFinished ? "победитель" : "в игре";
        return `<article class="game-player ${playerState}${voters.length ? " has-votes" : ""}">
            <div class="player-name">${avatarMarkup(player)}<div><strong>${escaped(player.nickname)}${player.id === socket.id ? " (вы)" : ""}</strong><small>${playerStatus}</small></div></div>
            <div class="public-cards">${voteMarkerMarkup}${playerCards || '<span class="muted">карты ещё не раскрыты</span>'}</div>
            ${playerActions ? `<div class="player-actions">${playerActions}</div>` : ""}
            ${player.id === room.hostId ? '<span class="host-star" aria-label="Ведущий" title="Ведущий">★</span>' : ""}
        </article>`;
    }).join("");
    if (revealAnimation) renderedRevealAnimation = revealAnimation;
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
$("#addTestPlayers").addEventListener("click", () => socket.emit("addTestPlayers"));
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
    const specialTarget = event.target.closest("[data-special-target]");
    if (specialTarget) {
        specialTargetMode = false;
        socket.emit("useSpecialCard", specialTarget.dataset.specialTarget);
        playSound("accepted");
        return;
    }
    const button = event.target.closest("[data-vote]");
    if (button) socket.emit("castVote", button.dataset.vote);
});
$("#myCards").addEventListener("click", (event) => {
    if (event.target.closest("[data-use-special]")) {
        specialTargetMode = !specialTargetMode;
        updateGame();
        return;
    }
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
    mySpecialCard = null;
    specialTargetMode = false;
    currentCode = "";
    clearSavedSession();
    $("#roomCode").value = "";
    show("#menu");
});
socket.on("resumeFailed", () => {
    clearSavedSession();
    currentCode = "";
    show("#menu");
});
socket.on("roomExpired", () => {
    room = null;
    myCards = {};
    mySpecialCard = null;
    specialTargetMode = false;
    currentCode = "";
    clearSavedSession();
    $("#roomCode").value = "";
    show("#menu");
    toast("Комната закрыта. Спасибо за игру!");
});
socket.on("yourCards", (cards) => { myCards = cards; if (room?.phase !== "lobby") updateGame(); });
socket.on("yourSpecialCard", (card) => {
    mySpecialCard = card || null;
    if (room?.phase !== "lobby") updateGame();
});
socket.on("gameStarted", () => { toast("Катастрофа выбрана. Прочитайте историю перед началом."); playSound("story"); });
socket.on("roundStarted", ({ initial } = {}) => { toast(initial ? "История прочитана. Первый раунд начинается." : "Новый раунд: выберите карту, которую хотите раскрыть."); playSound("round"); });
socket.on("cardRevealed", ({ playerId, trait }) => {
    pendingRevealAnimation = { playerId, trait };
    if (room?.phase !== "lobby") updateGame();
    if (playerId !== socket.id) playSound("reveal");
});
socket.on("professionItemReceived", ({ playerId, nickname: name, item }) => {
    toast(playerId === socket.id ? "В багаж добавлено: " + item + "." : name + " получает в багаж: " + item + ".");
    playSound("accepted");
});
socket.on("specialCardUsed", ({ nickname: name, targetNickname, cardName, trait, action }) => {
    toast(action === "take_backpack"
        ? name + " применяет «" + cardName + "» и забирает рюкзак у " + targetNickname + "."
        : name + " применяет «" + cardName + "»: обмен «" + traitName(trait) + "» с " + targetNickname + ".");
    playSound("accepted");
});
socket.on("votingStarted", () => { toast("Все раскрылись. Пора голосовать."); playSound("vote"); });
socket.on("voteAccepted", () => { toast("Ваш голос принят."); playSound("accepted"); });
socket.on("playerEliminated", ({ nickname: name }) => { toast(`${name} не попадает в бункер.`); playSound("out"); });
socket.on("turnAutoRevealed", ({ nickname: name, trait }) => {
    toast(`${name} не выбрал карту — автоматически раскрыта «${traitName(trait)}».`);
});
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
