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
let myPlayerId = "";
let currentCode = "";
let serverTimeOffset = 0;
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
let toastQueue = [];
let toastActive = false;
let countdownTimer;
let audioContext;
let soundsEnabled = localStorage.getItem("bunker-sounds") !== "off";
let lastTurnSoundKey = "";
let pendingRevealAnimation = null;
let renderedRevealAnimation = null;
let mySpecialCard = null;
let myWeaponStatus = { hasWeapon: false, revealed: false, used: false, canEvict: false };
let specialTargetMode = false;
let lastAppliedRoomTheme = "";
let disasterExpanded = false;
let testModeAvailable = false;
let testServerState = null;
let testPanelOpen = false;
const canUsePlayerTable = () => window.matchMedia("(min-width: 721px)").matches;
let playersView = canUsePlayerTable() && localStorage.getItem("bunker-players-view") === "table" ? "table" : "cards";
const THEME_STORAGE_KEY = "bunker-color-theme";
const COLOR_THEMES = [
    { id: "amber", label: "Янтарь", icon: "☀", color: "#f1a84e" },
    { id: "radiation", label: "Радиация", icon: "☢", color: "#7ee58d" },
    { id: "frost", label: "Ночной лёд", icon: "✦", color: "#8abaff" }
];

function applyColorTheme(themeId) {
    const theme = COLOR_THEMES.find((item) => item.id === themeId) || COLOR_THEMES[0];
    document.documentElement.dataset.theme = theme.id === "amber" ? "" : theme.id;
    localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    $("#themeIcon").textContent = theme.icon;
    $("#themeToggle").setAttribute("aria-label", "Тема: " + theme.label + ". Открыть выбор темы.");
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

function show(screen) {
    ["#menu", "#lobby", "#game"].forEach((id) => $(id).classList.toggle("hidden", id !== screen));
    document.body.classList.toggle("in-menu", screen === "#menu");
    document.body.classList.toggle("in-lobby", screen === "#lobby");
    document.body.classList.toggle("in-game", screen === "#game");
    const themeControl = $("#themeControl");
    if (screen === "#game") {
        $(".game-actions").prepend(themeControl);
    } else if (themeControl.parentElement !== document.body) {
        document.body.insertBefore(themeControl, $(".app-shell"));
    }
    closeThemeMenu();
}

function showNextToast() {
    if (toastActive || !toastQueue.length) return;
    toastActive = true;
    const item = toastQueue.shift();
    const element = $("#toast");
    $("#toastMessage").textContent = item.message;
    element.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(closeToast, item.duration);
}

function closeToast() {
    clearTimeout(toastTimer);
    const element = $("#toast");
    element.classList.remove("visible");
    setTimeout(() => {
        toastActive = false;
        showNextToast();
    }, 230);
}

function toast(message, options = {}) {
    const normalized = String(message || "").trim();
    if (!normalized) return;
    const duration = Math.max(1800, Number(options.duration) || (options.critical ? 6000 : options.important ? 4500 : 2800));
    toastQueue.push({ message: normalized, duration });
    if (toastQueue.length > 5) toastQueue = toastQueue.slice(-5);
    showNextToast();
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
    return room?.hostId === ownPlayerId();
}

function ownPlayerId() {
    return myPlayerId || socket.id;
}

function activePlayers() {
    return room?.players.filter((player) => !player.left && !player.eliminated) || [];
}

function traitName(trait) {
    return room?.categoryNames?.[trait] || TRAIT_NAMES[trait] || trait;
}

function updateActionTimer() {
    const lobbyExpiry = $("#lobbyExpiry");
    if (lobbyExpiry) {
        const lobbySeconds = Math.max(0, Math.ceil(((Number(room?.lobbyCloseDeadline) || 0) - (Date.now() + serverTimeOffset)) / 1000));
        lobbyExpiry.textContent = room?.lobbyCloseDeadline
            ? `Если никто не войдёт, лобби закроется через ${String(Math.floor(lobbySeconds / 60)).padStart(2, "0")}:${String(lobbySeconds % 60).padStart(2, "0")}`
            : "";
        lobbyExpiry.classList.toggle("hidden", !room?.lobbyCloseDeadline || room?.phase !== "lobby");
    }
    const rematchTimer = $("#rematchTimer");
    if (rematchTimer) {
        const rematchSeconds = Math.max(0, Math.ceil(((Number(room?.rematchDeadline) || 0) - (Date.now() + serverTimeOffset)) / 1000));
        rematchTimer.textContent = room?.rematchResolved
            ? "Приём ответов завершён"
            : `На решение: ${String(Math.floor(rematchSeconds / 60)).padStart(2, "0")}:${String(rematchSeconds % 60).padStart(2, "0")}`;
        rematchTimer.classList.toggle("urgent", rematchSeconds > 0 && rematchSeconds <= 10);
    }
    const isFinalTimer = room?.phase === "finished";
    const timer = isFinalTimer ? $("#resultsActionTimer") : $("#actionTimer");
    const controls = isFinalTimer ? $("#resultsTimerControls") : $("#timerControls");
    const extendButton = isFinalTimer ? $("#resultsExtendRoomTimer") : $("#extendRoomTimer");
    if (!timer || !controls || !extendButton) return;
    const deadline = room?.phase === "finished"
        ? room.roomCloseDeadline
        : room?.phase === "voting"
            ? room.voteDeadline
            : room?.phase === "reveal"
                ? room.turnDeadline
                : null;
    if (!deadline) {
        controls.classList.add("hidden");
        extendButton.classList.add("hidden");
        return;
    }
    const seconds = Math.max(0, Math.ceil((deadline - (Date.now() + serverTimeOffset)) / 1000));
    const kind = room.phase === "finished" ? "Комната закроется через" : room.phase === "voting" ? "До конца голосования" : "Время хода";
    timer.textContent = `${kind}: ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    timer.classList.toggle("warning", seconds > 10 && seconds <= 20);
    timer.classList.toggle("urgent", seconds > 0 && seconds <= 10);
    timer.classList.toggle("expired", seconds === 0);
    controls.classList.remove("hidden");
    extendButton.classList.toggle("hidden", room.phase !== "finished");
}

function renderIntegratedTestAdmin() {
    const canControl = Boolean(room?.isTestRoom && isHost());
    document.body.classList.toggle("test-admin-open", canControl && testPanelOpen);
    $("#testPanelToggle").classList.toggle("hidden", !canControl);
    if (!canControl) {
        testPanelOpen = false;
        $("#testPanel").classList.add("hidden");
        $("#testPanelToggle").setAttribute("aria-expanded", "false");
        return;
    }
    $("#testPanel").classList.toggle("hidden", !testPanelOpen);
    $("#testPanelToggle").setAttribute("aria-expanded", String(testPanelOpen));
    $("#testAdminSummary").textContent = `${room.code} · ${room.phase} · раунд ${room.round || 0}/${room.revealRounds || 0}${testServerState?.testPaused ? " · ПАУЗА" : ""}`;
    $("#testLobbyControls").classList.toggle("hidden", room.phase !== "lobby");
    $("#testGameControls").classList.toggle("hidden", room.phase === "lobby");
    $("#testPauseButton").textContent = testServerState?.testPaused ? "Продолжить" : "Пауза";
    $("#testPhase").value = ["story", "reveal", "voting", "finished"].includes(room.phase) ? room.phase : "story";
    $("#testRound").value = Math.max(1, Number(room.round) || 1);
    $("#testRound").max = Math.max(1, Number(room.revealRounds) || 1);
    if (!testServerState) {
        $("#testAdminPlayers").innerHTML = '<p class="hint">Состояние игроков загружается…</p>';
        return;
    }
    const traits = testServerState.traitOrder || room.categoryOrder || [];
    const names = testServerState.categoryNames || room.categoryNames || {};
    const healthTrait = traits.find((trait) => trait === "health" || /здоров/i.test(names[trait] || ""));
    const specialCards = testServerState.testSpecialCards || [];
    const specialTraits = testServerState.testSpecialTraits || [];
    $("#testAdminPlayers").innerHTML = room.players.map((player, index) => {
        const values = testServerState.cards?.[player.id] || {};
        const revealed = player.revealed || {};
        const isCurrent = room.turnPlayerId === player.id;
        const assignedSpecial = testServerState.playerSpecialCards?.[player.id] || null;
        const avatar = player.avatarUrl ? `<img src="${escaped(player.avatarUrl)}" alt="">` : escaped((player.nickname || "?").charAt(0).toUpperCase());
        const cards = traits.map((trait) => {
            const isOpen = Object.prototype.hasOwnProperty.call(revealed, trait);
            return `<div class="test-admin-card ${isOpen ? "is-open" : ""}"><div><span>${escaped(names[trait] || trait)}</span><strong title="${escaped(values[trait] ?? "—")}">${escaped(values[trait] ?? "—")}</strong></div><button type="button" data-test-reveal data-player="${escaped(player.id)}" data-trait="${escaped(trait)}" data-revealed="${isOpen ? "false" : "true"}">${isOpen ? "Скрыть" : "Открыть"}</button></div>`;
        }).join("");
        const specialOptions = specialCards.map((card) => `<option value="${escaped(card.effect)}" ${card.effect === assignedSpecial?.effect ? "selected" : ""} ${card.available ? "" : "disabled"}>${escaped(card.name)}${card.available ? "" : ` — ${escaped(card.unavailableReason || "недоступна")}`}</option>`).join("");
        const swapTraitOptions = specialTraits.filter((trait) => trait.canSwap).map((trait) => `<option value="${escaped(trait.id)}" ${trait.id === assignedSpecial?.trait ? "selected" : ""}>${escaped(trait.name)}</option>`).join("");
        const rerollTraitOptions = specialTraits.filter((trait) => trait.canReroll).map((trait) => `<option value="${escaped(trait.id)}" ${trait.id === assignedSpecial?.trait ? "selected" : ""}>${escaped(trait.name)}</option>`).join("");
        const specialControl = room.phase === "lobby" ? "" : `<div class="test-admin-special"><div><span>Специальная карта</span><strong>${escaped(assignedSpecial?.name || "не назначена")}</strong></div><select data-test-special-select aria-label="Спецкарта для ${escaped(player.nickname)}"><option value="">Выберите карту</option>${specialOptions}</select><select class="hidden" data-test-special-trait="swap_random_trait" aria-label="Характеристика для обмена"><option value="">Что обменять?</option>${swapTraitOptions}</select><select class="hidden" data-test-special-trait="reroll_own_trait" aria-label="Характеристика для переролла"><option value="">Что перероллить?</option>${rerollTraitOptions}</select><button type="button" data-test-give-special data-player="${escaped(player.id)}" ${player.eliminated ? "disabled" : ""}>Выдать</button></div>`;
        return `<article class="test-admin-player ${player.eliminated ? "is-out" : ""} ${isCurrent ? "is-current" : ""}"><div class="test-admin-player-head"><div class="test-admin-avatar">${avatar}</div><div><small>№${index + 1}${player.isBot ? " · БОТ" : ""}</small><strong>${escaped(player.nickname)}</strong><em>${player.eliminated ? "исключён" : isCurrent ? "текущий ход" : "в игре"}</em></div><div class="test-admin-player-actions"><button type="button" data-test-turn data-player="${escaped(player.id)}">Дать ход</button>${healthTrait ? `<button type="button" data-test-health="improve" data-player="${escaped(player.id)}">Здоровье +</button><button type="button" data-test-health="worsen" data-player="${escaped(player.id)}">Здоровье −</button>` : ""}<button type="button" class="${player.eliminated ? "" : "test-danger"}" data-test-eliminate data-player="${escaped(player.id)}" data-eliminated="${player.eliminated ? "false" : "true"}">${player.eliminated ? "Вернуть" : "Исключить"}</button></div></div>${specialControl}<div class="test-admin-cards">${cards || '<span class="hint">Карты появятся после запуска.</span>'}</div></article>`;
    }).join("");
    $("#testAdminPlayers").querySelectorAll(".test-admin-player").forEach(updateTestSpecialTraitPicker);
    $("#testAdminState").textContent = JSON.stringify(testServerState, null, 2);
}

function updateTestSpecialTraitPicker(playerCard) {
    const effect = playerCard?.querySelector("[data-test-special-select]")?.value || "";
    playerCard?.querySelectorAll("[data-test-special-trait]").forEach((select) => {
        select.classList.toggle("hidden", select.dataset.testSpecialTrait !== effect);
    });
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
    return {
        nickname: nickname(),
        visualTheme: localStorage.getItem(THEME_STORAGE_KEY) || "amber"
    };
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
    $("#closeLobby").classList.toggle("hidden", !isHost());
    $("#startHint").textContent = playerTotal === 1 && isHost()
        ? room.isTestRoom ? "Добавьте тестовых игроков и управляйте ими через тест-панель." : "Для обычного старта нужно минимум 3 игрока."
        : playerTotal < 3
        ? "Для обычного старта нужно минимум 3 игрока."
        : isHost() ? "После старта половина игроков сможет остаться в бункере." : "";
}

function cardMarkup(trait, value, revealed, canChoose, isRevealing = false, isFinishReveal = false) {
    const status = canChoose ? "раскрыть" : isFinishReveal ? "раскрыта в финале" : revealed ? "раскрыта" : "не раскрыта";
    const content = `<span>${escaped(traitName(trait))}</span><strong>${escaped(value)}</strong><em>${status}</em>`;
    const classes = `my-card ${revealed ? "is-revealed" : ""} ${isFinishReveal ? "is-finish-reveal" : ""} ${canChoose ? "is-choice" : ""} ${isRevealing ? "is-revealing" : ""}`;
    return canChoose
        ? `<button type="button" class="${classes}" data-reveal-trait="${trait}">${content}</button>`
        : `<article class="${classes}">${content}</article>`;
}

function playerTableMarkup(cardOrder, me, isVoting, hasVoted, isFinished, specialTargetAction, canChooseTrait, canRevealProfession, playerSubset = room.players) {
    const players = playerSubset;
    const professionBaggageFor = (player) => player.professionItem || "";
    const hasProfessionBaggageItems = players.some((player) => professionBaggageFor(player));
    const abilityTextFor = (player) => Array.isArray(player.abilities) && player.abilities.length ? [...new Set(player.abilities.filter(Boolean))].join(", ") : player.usedSpecialCard?.name || "";
    const hasUsedSpecialCards = players.some((player) => abilityTextFor(player));
    const playerStatus = (player) => player.left ? "вышел" : player.eliminated ? "исключён" : isFinished ? "победитель" : "в игре";
    const playerState = (player) => player.left ? "left-player" : player.eliminated ? "eliminated" : isFinished ? "survivor" : "active-player";
    const showVotes = isVoting || players.some((player) => (room.voteMarkers?.[player.id] || []).length);
    const traitCell = (player, trait) => {
        const isRevealed = Object.prototype.hasOwnProperty.call(player.revealed || {}, trait);
        const isMe = player.id === ownPlayerId();
        const hasOwnValue = isMe && Object.prototype.hasOwnProperty.call(myCards, trait);
        const isFinishReveal = isFinished && !player.left && !player.eliminated && Array.isArray(player.finishRevealedTraits) && player.finishRevealedTraits.includes(trait);
        const baseValue = hasOwnValue ? myCards[trait] : isRevealed ? player.revealed[trait] : "скрыто";
        const value = baseValue;
        const canRevealHere = isMe && !isRevealed && (canChooseTrait || (canRevealProfession && trait === room.currentTrait));
        const visibilityClass = isFinishReveal ? "is-finish-reveal-value" : isRevealed ? "is-revealed-value" : hasOwnValue ? "is-private-value" : "is-hidden-value";
        return `<td class="${visibilityClass} ${playerState(player)}"><div class="table-cell-content ${canRevealHere ? "has-reveal-control" : ""}"><span class="table-cell-value" title="${escaped(value)}">${escaped(value)}</span>${canRevealHere ? `<button class="table-reveal-button" type="button" data-reveal-trait="${trait}" title="Раскрыть: ${escaped(traitName(trait))}" aria-label="Раскрыть: ${escaped(traitName(trait))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.8"></circle></svg></button>` : ""}</div></td>`;
    };
    const voteCell = (player) => {
        const voters = (room.voteMarkers?.[player.id] || [])
            .map((voterId) => players.find((candidate) => candidate.id === voterId))
            .filter(Boolean);
        const visibleVoters = voters.slice(0, 3);
        const voteWord = voters.length === 1 ? "голос" : voters.length >= 2 && voters.length <= 4 ? "голоса" : "голосов";
        return `<td class="table-vote-cell ${playerState(player)}">${visibleVoters.map((voter) => `<span class="vote-avatar" title="${escaped(voter.nickname)}">${avatarMarkup(voter)}</span>`).join("")}${voters.length > visibleVoters.length ? `<span class="vote-more">+${voters.length - visibleVoters.length}</span>` : ""}<span class="table-vote-count ${voters.length ? "" : "is-empty"}">${voters.length} ${voteWord}</span></td>`;
    };
    const actionCell = (player) => {
        const isVoteCandidate = !Array.isArray(room.voteCandidateIds) || room.voteCandidateIds.includes(player.id);
        const canVote = isVoting && isVoteCandidate && !hasVoted && !me?.eliminated && !player.left && !player.eliminated && player.id !== ownPlayerId();
        const specialAllowsSelf = ["improve_health", "worsen_health"].includes(mySpecialCard?.effect);
        const canSelectSpecialTarget = specialTargetMode && !player.left && !player.eliminated && (specialAllowsSelf || player.id !== ownPlayerId());
        const action = canSelectSpecialTarget
            ? `<button class="special-target-button" data-special-target="${player.id}">${escaped(specialTargetAction)}</button>`
            : canVote ? `<button class="vote-button" data-vote="${player.id}">Исключить</button>` : "—";
        return `<td class="table-action-cell ${playerState(player)}">${action}</td>`;
    };
    const columns = [
        ...cardOrder.map((trait) => `<th scope="col"><span class="table-header-value" title="${escaped(traitName(trait))}">${escaped(traitName(trait))}</span></th>`),
        hasProfessionBaggageItems ? '<th scope="col"><span class="table-header-value" title="Багаж от профессии">Багаж от профессии</span></th>' : "",
        hasUsedSpecialCards ? '<th scope="col"><span class="table-header-value" title="Спецкарта">Спецкарта</span></th>' : "",
        showVotes ? '<th scope="col"><span class="table-header-value">Голоса против</span></th>' : "",
        (isVoting || specialTargetMode) ? '<th scope="col"><span class="table-header-value">Действие</span></th>' : ""
    ].join("");
    const rows = players.map((player) => {
        const playerNumber = room.players.indexOf(player) + 1;
        const identity = `<th scope="row" class="table-player-cell ${playerState(player)}"><span class="table-player">${avatarMarkup(player)}<span><strong title="${escaped(player.nickname)}">${escaped(player.nickname)}${player.id === ownPlayerId() ? " (вы)" : ""}</strong><small>№ ${playerNumber} · ${playerStatus(player)}</small></span></span></th>`;
        const extras = [
            hasProfessionBaggageItems ? `<td class="table-extra ${professionBaggageFor(player) ? "is-revealed-value" : "is-hidden-value"} ${playerState(player)}"><span class="table-cell-value" title="${escaped(professionBaggageFor(player) || "—")}">${professionBaggageFor(player) ? escaped(professionBaggageFor(player)) : "—"}</span></td>` : "",
            hasUsedSpecialCards ? `<td class="table-extra ${abilityTextFor(player) ? "is-revealed-value" : "is-hidden-value"} ${playerState(player)}"><span class="table-cell-value" title="${escaped(abilityTextFor(player) || "Нет")}">${escaped(abilityTextFor(player) || "Нет")}</span></td>` : "",
            showVotes ? voteCell(player) : "",
            (isVoting || specialTargetMode) ? actionCell(player) : ""
        ].join("");
        return `<tr class="${playerState(player)}">${identity}${cardOrder.map((trait) => traitCell(player, trait)).join("")}${extras}</tr>`;
    }).join("");
    return `<div class="players-table-scroll"><table class="players-table players-table-transposed"><thead><tr><th><span class="table-header-value">Игрок</span></th>${columns}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function updateGame() {
    if (!room) return;
    const me = room.players.find((player) => player.id === ownPlayerId());
    const active = activePlayers();
    const trait = room.currentTrait;
    const isStory = room.phase === "story";
    const isVoting = room.phase === "voting";
    const isFinished = room.phase === "finished";
    const winners = room.players.filter((player) => !player.left && !player.eliminated);
    const utilityBreakdown = Array.isArray(room.utilityBreakdown) ? room.utilityBreakdown : [];
    const utilityRows = utilityBreakdown.map((entry) => {
        const player = room.players.find((candidate) => candidate.id === entry.playerId);
        if (!player) return "";
        const professionReasons = Array.isArray(entry.professionReasons) ? entry.professionReasons.join("; ") : "";
        const professionBonus = Number(entry.professionBonus) || 0;
        const itemReasons = Array.isArray(entry.professionItemReasons) ? entry.professionItemReasons.join("; ") : "";
        const itemBonus = Number(entry.professionItemBonus) || 0;
        const professionLine = professionBonus
            ? '<li><b>Бонус профессии: +' + professionBonus + '%</b><span>' + escaped(professionReasons) + '</span></li>'
            : '<li class="utility-neutral"><b>Бонус профессии: +0%</b><span>для этого бункера нет особого бонуса.</span></li>';
        const additionalLine = itemBonus
            ? '<li><b>Дополнительно: +' + itemBonus + '%</b><span>' + escaped(entry.professionItem || "профессиональный багаж") + ' — ' + escaped(itemReasons) + '</span></li>'
            : '<li class="utility-neutral"><b>Дополнительно</b><span>нет бонуса от профессионального багажа.</span></li>';
        const contributionItems = professionLine + additionalLine;
        return '<article class="utility-player">' + avatarMarkup(player) + '<div class="utility-copy"><div class="utility-player-heading"><strong>' + escaped(player.nickname) + '</strong><b>' + entry.utility + '%</b></div><small>Итоговая полезность</small><ul class="utility-contributions">' + contributionItems + '</ul></div></article>';
    }).join("");
    const myRevealed = me?.revealed || {};
    const hasRevealedThisRound = Boolean(room.revealedThisRound?.[ownPlayerId()]);
    const isChoiceRound = room.phase === "reveal" && !trait;
    const turnPlayer = room.players.find((player) => player.id === room.turnPlayerId);
    const isMyTurn = room.turnPlayerId === ownPlayerId();
    const hasVoted = room.votedPlayerIds?.includes(ownPlayerId());
    const professionTrait = (room.categoryOrder?.length ? room.categoryOrder : Object.keys(myCards)).find((name) => name === "profession" || /професси/i.test(`${name} ${traitName(name)}`)) || "profession";
    const professionRevealed = Boolean(me && Object.prototype.hasOwnProperty.call(me.revealed || {}, professionTrait));
    const canUseSpecialCard = Boolean(mySpecialCard && !mySpecialCard.used && professionRevealed && me && !me.eliminated && room.phase === "reveal" && isMyTurn);
    const canUseWeapon = Boolean(myWeaponStatus?.hasWeapon && myWeaponStatus?.revealed && !myWeaponStatus?.used && myWeaponStatus?.canEvict && me && !me.eliminated && room.phase === "reveal" && isMyTurn);
    const specialNeedsTarget = ["swap_random_trait", "take_backpack", "improve_health", "worsen_health"].includes(mySpecialCard?.effect);
    const specialTraitLabel = !mySpecialCard ? "" : mySpecialCard.effect === "take_backpack" ? "Забрать предмет из рюкзака"
        : mySpecialCard.effect === "swap_adjacent_profession" ? (mySpecialCard.direction === "left" ? "Обменяться профессией с соседом слева" : mySpecialCard.direction === "right" ? "Обменяться профессией с соседом справа" : "Обменяться профессией со случайным соседом")
        : mySpecialCard.effect === "increase_capacity" ? "Добавить 1 место в бункере"
            : mySpecialCard.effect === "decrease_capacity" ? "Убрать 1 место в бункере"
                : mySpecialCard.effect === "random_capacity" ? "Случайно: +1 или −1 место"
                    : mySpecialCard.effect === "reroll_own_trait" ? `Переролл: ${traitName(mySpecialCard.trait)}`
                        : mySpecialCard.effect === "improve_health" ? "Улучшить здоровье выбранного игрока"
                            : mySpecialCard.effect === "worsen_health" ? "Ухудшить здоровье выбранного игрока"
                        : `Обмен: ${traitName(mySpecialCard.trait)}`;
    const specialTargetAction = !mySpecialCard ? "" : mySpecialCard.effect === "take_backpack" ? "Забрать предмет"
        : mySpecialCard.effect === "improve_health" ? "Улучшить здоровье"
            : mySpecialCard.effect === "worsen_health" ? "Ухудшить здоровье"
                : `Обменяться: ${traitName(mySpecialCard.trait)}`;
    if (!canUseSpecialCard) specialTargetMode = false;

    const survivalChanceValue = isFinished && typeof room.bunkerSurvivalChance === "number" ? room.bunkerSurvivalChance : null;
    const strongestPlayer = utilityBreakdown.length ? [...utilityBreakdown].sort((first, second) => second.utility - first.utility)[0] : null;
    const weakestPlayer = utilityBreakdown.length ? [...utilityBreakdown].sort((first, second) => first.utility - second.utility)[0] : null;
    const playerNameById = (id) => room.players.find((player) => player.id === id)?.nickname || "—";
    const finalConditions = [
        room.disasterDuration ? `<span><b>Срок:</b> ${escaped(room.disasterDuration)}</span>` : "",
        `<span><b>Вместимость:</b> ${room.capacity}</span>`,
        ...(room.bunkerTraits || []).filter((item) => /water|вод|food|(?:^|\s)ед[аы](?:\s|$)|питан/i.test(`${item.id} ${item.name}`)).map((item) => `<span><b>${escaped(item.name)}:</b> ${escaped(item.value)}</span>`)
    ].filter(Boolean).join("");
    const rematchHumans = room.players.filter((player) => !player.left && !player.isBot);
    const rematchReadyPlayers = rematchHumans.filter((player) => room.rematchReadyIds?.includes(player.id));
    const rematchDeclinedPlayers = rematchHumans.filter((player) => room.rematchDeclinedIds?.includes(player.id));
    const ownRematchReady = room.rematchReadyIds?.includes(ownPlayerId());
    const ownRematchDeclined = room.rematchDeclinedIds?.includes(ownPlayerId());
    const rematchOpen = isFinished && !room.rematchResolved && Number(room.rematchDeadline) > Date.now() + serverTimeOffset;
    const rematchMarkup = isFinished ? `
        <div class="continue-game-block ${rematchOpen ? "" : "is-closed"}">
            <div class="rematch-copy"><span>ЕЩЁ ОДНУ ПАРТИЮ?</span><strong>${rematchOpen ? "Решает каждый игрок" : "Приём ответов завершён"}</strong><p>${rematchOpen ? "В новую игру попадут только согласившиеся. Если ответят все — начнём раньше." : "Текущую комнату ещё можно просматривать до закрытия."}</p></div>
            ${rematchOpen ? `<div id="rematchTimer" class="rematch-timer"></div>` : ""}
            <div class="rematch-ready"><span>ГОТОВЫ ${rematchReadyPlayers.length} ИЗ ${rematchHumans.length}</span><div>${rematchReadyPlayers.map((player) => `<span title="${escaped(player.nickname)}">${avatarMarkup(player)}</span>`).join("") || "<small>Пока никто</small>"}</div></div>
            ${rematchOpen ? `<div class="rematch-actions"><button class="button ${ownRematchReady ? "rematch-selected" : "primary"}" type="button" data-request-rematch>${ownRematchReady ? "✓ Вы играете снова" : "Играть снова"}</button><button class="button ${ownRematchDeclined ? "rematch-declined" : "secondary"}" type="button" data-decline-rematch>${ownRematchDeclined ? "✓ Не участвую" : "Не играю дальше"}</button></div>` : ""}
            ${rematchDeclinedPlayers.length ? `<small class="rematch-declined-list">Не участвуют: ${rematchDeclinedPlayers.map((player) => escaped(player.nickname)).join(", ")}</small>` : ""}
        </div>` : "";

    $("#gameCode").textContent = room.code;
    $("#phaseTitle").textContent = isFinished ? "Игра завершена" : isStory ? "История катастрофы" : isVoting ? "Голосование" : "Раскрытие карт";
    $("#resultsBanner").classList.toggle("hidden", !isFinished);
    $("#resultsBanner").innerHTML = isFinished ? `
        <div class="result-summary">
            <span class="result-emblem" aria-hidden="true">✦</span>
            <div class="result-copy"><span class="result-kicker">ИГРА ЗАВЕРШЕНА</span><h3>${winners.length ? "В бункер попали не все…" : "В бункер никто не попал"}</h3><p>${winners.length ? "Поздравьте тех, кому удалось попасть внутрь." : "В этот раз бункер не спас никого."}</p></div>
        </div>
        <div id="resultsTimerControls" class="timer-controls result-timer-controls"><div id="resultsActionTimer" class="action-timer" aria-live="polite"></div><button id="resultsExtendRoomTimer" class="extend-room-timer" type="button" title="Продлить просмотр на 30 секунд">+30</button></div>
        ${winners.length ? `<div class="winner-section"><span class="winner-label">В БУНКЕРЕ ОСТАЛИСЬ</span><div class="winner-list">${winners.map((player) => `<span class="winner-chip">${avatarMarkup(player)}<strong>${escaped(player.nickname)}</strong></span>`).join("")}</div></div>` : ""}
        <div class="final-survival"><span>ШАНС ВЫЖИВАНИЯ</span><strong>${survivalChanceValue === null ? "—" : survivalChanceValue + "%"}</strong><div class="final-conditions">${finalConditions}</div>${strongestPlayer ? `<p><b>Сильная сторона:</b> ${escaped(playerNameById(strongestPlayer.playerId))} — ${strongestPlayer.utility}% полезности.</p>` : ""}${weakestPlayer && weakestPlayer !== strongestPlayer ? `<p><b>Слабая сторона:</b> ${escaped(playerNameById(weakestPlayer.playerId))} — ${weakestPlayer.utility}% полезности.</p>` : ""}</div>
        ${utilityRows ? `<div class="utility-breakdown"><span class="utility-kicker">КТО ЧЕМ ПОЛЕЗЕН В БУНКЕРЕ</span><div class="utility-list">${utilityRows}</div></div>` : ""}
        ${rematchMarkup}
    ` : "";
    const bunkerChance = isFinished && typeof room.bunkerSurvivalChance === "number"
        ? `<span class="bunker-chance">Выживаемость по полезности: <strong>${room.bunkerSurvivalChance}%</strong></span>`
        : "";
    const occupiedSlots = Number(room.bunkerOccupiedSlots) || 0;
    const occupiedSlotsLabel = occupiedSlots
        ? ` · жителями занято: ${occupiedSlots}`
        : "";
    const capacityLabel = `Мест для игроков: ${room.capacity}${occupiedSlotsLabel}`;
    const disasterText = escaped(room.disaster || "");
    const shelterDuration = room.disasterDuration
        ? '<span class="shelter-duration">В бункере: <strong>' + escaped(room.disasterDuration) + '</strong></span>'
        : "";
    const disasterContent = isStory
        ? `<span class="eyebrow">КАТАСТРОФА</span><p class="story-text">${disasterText}</p><div class="disaster-meta"><span class="capacity">${capacityLabel}</span>${shelterDuration}${isHost() ? '<button class="button primary story-ready" type="button" data-acknowledge-story>Все прочитали историю — начать раунд</button>' : '<span class="story-wait">Ждём, пока ведущий начнёт раунд.</span>'}</div>`
        : `<div class="disaster-accordion ${disasterExpanded ? "is-open" : ""}"><button class="disaster-accordion-toggle" type="button" aria-expanded="${disasterExpanded}" aria-controls="disasterStory"><span class="eyebrow">КАТАСТРОФА · ${disasterExpanded ? "СКРЫТЬ" : "ОТКРЫТЬ"} ИСТОРИЮ</span><span class="accordion-icon" aria-hidden="true">⌄</span></button><div id="disasterStory" class="disaster-accordion-content"${disasterExpanded ? "" : " hidden"}><p>${disasterText}</p></div></div><div class="disaster-meta"><span class="capacity">${capacityLabel}</span>${shelterDuration}${bunkerChance}</div>`;
    $("#disasterCard").classList.toggle("story-mode", isStory);
    $("#disasterCard").classList.toggle("is-collapsible", !isStory);
    $("#disasterCard").innerHTML = disasterContent;
    const bunkerTraits = Array.isArray(room.bunkerTraits) ? room.bunkerTraits : [];
    $("#bunkerTraitsPanel").classList.toggle("hidden", !bunkerTraits.length);
    $("#bunkerTraits").innerHTML = bunkerTraits.map((trait) => [
        '<article class="bunker-trait-card">',
        '<span>' + escaped(trait.name) + '</span>',
        '<strong>' + escaped(trait.value) + '</strong>',
        trait.occupiedSlots ? '<small>занято мест: ' + escaped(trait.occupiedSlots) + '</small>' : '',
        trait.evictedResidents ? '<small>выгнано жителей: ' + escaped(trait.evictedResidents) + '</small>' : '',
        '</article>'
    ].join("")).join("");
    $("#survivorCount").textContent = `${active.length} в игре`;
    const categoryCount = room.categoryOrder?.length || Object.keys(myCards).length;
    const revealRoundCount = room.revealRounds || categoryCount;
    const tableViewAvailable = canUsePlayerTable();
    if (!tableViewAvailable && playersView === "table") {
        playersView = "cards";
        localStorage.setItem("bunker-players-view", playersView);
    }
    $("#playerViewToggle").hidden = !tableViewAvailable;
    $("#playerViewToggle").textContent = playersView === "table" ? "▤ Карточки" : "▦ Таблица";
    $("#playerViewToggle").setAttribute("aria-pressed", String(playersView === "table"));
    $(".round-panel").classList.toggle("hidden", isStory || isFinished);
    $(".round-panel").classList.toggle("is-finished", isFinished);
    $("#roundLabel").textContent = isFinished ? "ИГРА ЗАВЕРШЕНА" : isStory ? "ИСТОРИЯ КАТАСТРОФЫ" : isVoting ? "ГОЛОСОВАНИЕ" : `РАУНД ${room.round} ИЗ ${revealRoundCount}`;
    $("#roundTitle").textContent = isFinished ? "В бункер попали не все…" : isStory ? "Прочитайте историю" : isVoting ? (room.eliminationsThisVote > 1 ? `Кого не берём? Выбывают ${room.eliminationsThisVote}` : "Кого не берём в бункер?") : trait ? `Первый ход: ${traitName(trait)}` : "Выберите карту для раскрытия";
    $("#roundDescription").textContent = isFinished ? "Поздравьте тех, кому удалось попасть внутрь." : isStory ? "Игра начнётся, когда ведущий подтвердит, что все успели прочитать историю." : isVoting ? (Array.isArray(room.voteCandidateIds) ? "Дополнительное голосование между спорными кандидатами. Голос нельзя изменить." : "Выберите одного игрока. Голос нельзя изменить.") : trait ? "В первом раунде все обязаны раскрыть эту категорию." : "Теперь каждый сам выбирает одну ещё скрытую карту.";

    const canRevealProfession = room.phase === "reveal" && trait && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    const canChooseTrait = isChoiceRound && me && !me.eliminated && isMyTurn && !hasRevealedThisRound;
    const canSkipVote = isVoting && room.voteCanBeSkipped !== false && me && !me.eliminated && !hasVoted;
    $(".round-panel").classList.toggle("has-round-action", canSkipVote);
    const revealAnimation = pendingRevealAnimation !== renderedRevealAnimation ? pendingRevealAnimation : null;
    const isNewReveal = (playerId, traitId) => Boolean(
        revealAnimation && revealAnimation.playerId === playerId && revealAnimation.trait === traitId
    );
    $("#skipVoteButton").classList.toggle("hidden", !canSkipVote);
    $("#actionHint").textContent = isFinished ? "Игра завершена." : isStory ? (isHost() ? "Подтвердите начало, когда все прочитали историю." : "Ждём подтверждения ведущего.") : me?.eliminated ? "Вы исключены, но можете наблюдать за игрой." : specialTargetMode ? `Выберите игрока: ${specialTargetAction.toLocaleLowerCase("ru")}.` : isVoting && hasVoted ? "Ваш голос принят. Ждём остальных." : isVoting ? "Голосуйте до окончания таймера." : hasRevealedThisRound ? "Карта раскрыта. Ждём остальных." : isMyTurn && canChooseTrait ? "Ваш ход: нажмите на любую ещё нераскрытую карточку." : isMyTurn ? "Ваш ход: раскройте профессию." : turnPlayer ? `Сейчас ходит ${turnPlayer.nickname}.` : "";

    const cardOrder = room.categoryOrder?.length ? room.categoryOrder : Object.keys(myCards);
    const personalCards = cardOrder.filter((name) => name in myCards).map((name) => {
        const value = myCards[name];
        const canRevealThisCard = !myRevealed[name] && (canChooseTrait || (canRevealProfession && name === room.currentTrait));
        return cardMarkup(
            name,
            value,
            Boolean(myRevealed[name]),
            canRevealThisCard,
            isNewReveal(ownPlayerId(), name),
            isFinished && Array.isArray(me?.finishRevealedTraits) && me.finishRevealedTraits.includes(name)
        );
    }).join("");
    const professionBaggage = me?.professionItem
        ? '<article class="my-card is-revealed profession-item-card"><span>Багаж от профессии</span><strong>' + escaped(me.professionItem) + '</strong><em>получен</em></article>'
        : "";
    const weaponActionCard = myWeaponStatus?.hasWeapon && myWeaponStatus?.revealed
        ? '<' + (canUseWeapon ? 'button type="button" data-use-bunker-weapon' : 'article') + ' class="my-card weapon-action-card ' + (myWeaponStatus?.used ? 'is-used' : '') + (canUseWeapon ? ' is-choice' : '') + '"><span>Предмет в багаже</span><strong>Оружие</strong><small>Выгнать жителя и освободить 1 место</small><em>' + (myWeaponStatus?.used ? 'житель выгнан' : !myWeaponStatus?.canEvict ? 'жителей нет' : canUseWeapon ? 'нажмите, чтобы применить' : 'доступно в ваш ход') + '</em></' + (canUseWeapon ? 'button' : 'article') + '>'
        : '';
    const specialCardInHand = mySpecialCard
        ? '<' + (canUseSpecialCard ? 'button type="button" data-use-special' : 'article') + ' class="my-card special-card-hand ' + (mySpecialCard.used ? 'is-used' : '') + (canUseSpecialCard ? ' is-choice' : '') + '"><span>Специальная карта</span><strong>' + escaped(mySpecialCard.name) + '</strong><small>' + escaped(specialTraitLabel) + '</small><em>' + (mySpecialCard.used ? 'использована' : !professionRevealed ? 'сначала раскройте профессию' : specialTargetMode ? 'выберите игрока' : canUseSpecialCard ? 'нажмите, чтобы применить' : 'доступна в ваш ход') + '</em></' + (canUseSpecialCard ? 'button' : 'article') + '>'
        : "";
    $("#myCards").innerHTML = personalCards + professionBaggage + weaponActionCard + specialCardInHand;
    const playerCardMarkup = (player) => {
        const playerIndex = room.players.indexOf(player);
        const playerCards = cardOrder.map((name) => {
            const isRevealed = Object.prototype.hasOwnProperty.call(player.revealed || {}, name);
            const isMe = player.id === ownPlayerId();
            const hasOwnValue = isMe && Object.prototype.hasOwnProperty.call(myCards, name);
            const isFinishReveal = isFinished && !player.left && !player.eliminated && Array.isArray(player.finishRevealedTraits) && player.finishRevealedTraits.includes(name);
            const baseValue = hasOwnValue ? myCards[name] : isRevealed ? player.revealed[name] : "скрыто";
            const value = baseValue;
            const canRevealHere = isMe && !isRevealed && (canChooseTrait || (canRevealProfession && name === room.currentTrait));
            const visibilityClass = isFinishReveal ? "is-finish-reveal-card" : isRevealed ? "" : hasOwnValue ? "is-private-card" : "is-hidden-card";
            const revealControl = canRevealHere
                ? `<button class="card-reveal-eye" type="button" data-reveal-trait="${name}" title="Раскрыть: ${escaped(traitName(name))}" aria-label="Раскрыть: ${escaped(traitName(name))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.8"></circle></svg></button>`
                : "";
            return `<div class="public-card ${visibilityClass} ${canRevealHere ? "has-reveal-control" : ""} ${isNewReveal(player.id, name) ? "is-revealing" : ""}"><b>${escaped(traitName(name))}:</b> <span class="public-card-value">${escaped(value)}</span>${revealControl}</div>`;
        }).join("")
            + (player.professionItem ? `<span class="public-card profession-item"><b>Багаж:</b> ${escaped(player.professionItem)}</span>` : "")
            + (Array.isArray(player.abilities) && player.abilities.length ? `<span class="public-card special-card-used"><b>Спецкарты и способности:</b> ${escaped([...new Set(player.abilities.filter(Boolean))].join(", "))}</span>` : player.usedSpecialCard ? `<span class="public-card special-card-used"><b>Спецкарта:</b> ${escaped(player.usedSpecialCard.name)}</span>` : "");
        const isVoteCandidate = !Array.isArray(room.voteCandidateIds) || room.voteCandidateIds.includes(player.id);
        const canVote = isVoting && isVoteCandidate && !hasVoted && !me?.eliminated && !player.left && !player.eliminated && player.id !== ownPlayerId();
        const specialAllowsSelf = ["improve_health", "worsen_health"].includes(mySpecialCard?.effect);
        const canSelectSpecialTarget = specialTargetMode && !player.left && !player.eliminated && (specialAllowsSelf || player.id !== ownPlayerId());
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
        return `<article class="game-player ${playerState}${voters.length ? " has-votes" : ""}${playerActions ? " has-actions" : ""}">
            <div class="player-name"><span class="player-number" aria-label="Номер участника">№ ${playerIndex + 1}</span>${avatarMarkup(player)}<div><strong>${escaped(player.nickname)}${player.id === ownPlayerId() ? " (вы)" : ""}</strong><small>${playerStatus}</small></div>${voteMarkerMarkup}</div>
            <div class="public-cards">${playerCards || '<span class="muted">карты ещё не раскрыты</span>'}</div>
            ${playerActions ? `<div class="player-actions">${playerActions}</div>` : ""}
            ${player.id === room.hostId ? '<span class="host-star" aria-label="Ведущий" title="Ведущий">★</span>' : ""}
        </article>`;
    };
    const activePlayerList = room.players.filter((player) => !player.left && !player.eliminated);
    const inactivePlayerList = room.players.filter((player) => player.left || player.eliminated);
    const playerCardsMarkup = `<div class="player-group-grid">${activePlayerList.map(playerCardMarkup).join("")}</div>${inactivePlayerList.length ? `<section class="eliminated-players-section"><div class="eliminated-section-title"><span>ВЫБЫВШИЕ</span><small>${inactivePlayerList.length}</small></div><div class="player-group-grid">${inactivePlayerList.map(playerCardMarkup).join("")}</div></section>` : ""}`;
    const playerTablesMarkup = `${playerTableMarkup(cardOrder, me, isVoting, hasVoted, isFinished, specialTargetAction, canChooseTrait, canRevealProfession, activePlayerList)}${inactivePlayerList.length ? `<section class="eliminated-players-section table-eliminated-section"><div class="eliminated-section-title"><span>ВЫБЫВШИЕ ИГРОКИ</span><small>${inactivePlayerList.length}</small></div>${playerTableMarkup(cardOrder, me, false, true, isFinished, "", false, false, inactivePlayerList)}</section>` : ""}`;
    $("#gamePlayers").classList.toggle("players-table-view", tableViewAvailable && playersView === "table");
    $("#gamePlayers").innerHTML = tableViewAvailable && playersView === "table"
        ? playerTablesMarkup
        : playerCardsMarkup;
    const logEntries = Array.isArray(room.actionLog) ? room.actionLog : [];
    $("#actionLog").innerHTML = logEntries.length
        ? logEntries.slice().reverse().map((entry) => `<li class="action-log-entry ${escaped(entry.type || "system")}"><time>${new Date(entry.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time><span>${escaped(entry.text)}</span></li>`).join("")
        : '<li class="action-log-empty">События игры появятся здесь.</li>';
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
    renderIntegratedTestAdmin();
}

function enterRoom({ code, playerToken, playerId }) {
    currentCode = code;
    myPlayerId = playerId || socket.id;
    if (playerToken) {
        savedSession = { code, token: playerToken };
        localStorage.setItem(SESSION_KEY, JSON.stringify(savedSession));
    }
    $("#roomTitle").textContent = code;
    $("#returnRoom").classList.add("hidden");
}

function clearSavedSession() {
    savedSession = null;
    localStorage.removeItem(SESSION_KEY);
    $("#returnRoom").classList.add("hidden");
}

function tryResumeSession(force = false) {
    if (!savedSession || !socket.connected || !force && resumedSocketId === socket.id) return;
    resumedSocketId = socket.id;
    socket.emit("resumeRoom", { roomCode: savedSession.code, playerToken: savedSession.token });
}

$("#createRoom").addEventListener("click", () => socket.emit("createRoom", playerPayload()));
$("#createTestRoom").addEventListener("click", () => socket.emit("test:createRoom", { nickname: nickname(), adminToken: localStorage.getItem("bunker-admin-token") || "" }));
$("#joinRoom").addEventListener("click", () => socket.emit("joinRoom", { roomCode: $("#roomCode").value, ...playerPayload() }));
$("#nickname").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#createRoom").click(); });
$("#roomCode").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("#startGame").addEventListener("click", () => socket.emit("startGame"));
$("#closeLobby").addEventListener("click", () => {
    if (window.confirm("Закрыть лобби для всех участников?")) socket.emit("closeLobby");
});
$("#testPanelToggle").addEventListener("click", () => {
    testPanelOpen = !testPanelOpen;
    renderIntegratedTestAdmin();
});
$("#testPanelClose").addEventListener("click", () => {
    testPanelOpen = false;
    renderIntegratedTestAdmin();
});
$("#testPanel").addEventListener("click", (event) => {
    const reveal = event.target.closest("[data-test-reveal]");
    if (reveal) return socket.emit("test:setReveal", { targetId: reveal.dataset.player, trait: reveal.dataset.trait, revealed: reveal.dataset.revealed === "true" });
    const health = event.target.closest("[data-test-health]");
    if (health) return socket.emit("test:applyHealth", { targetId: health.dataset.player, direction: health.dataset.testHealth, amount: 1 });
    const turn = event.target.closest("[data-test-turn]");
    if (turn) return socket.emit("test:setTurn", { targetId: turn.dataset.player });
    const eliminate = event.target.closest("[data-test-eliminate]");
    if (eliminate) return socket.emit("test:setEliminated", { targetId: eliminate.dataset.player, eliminated: eliminate.dataset.eliminated === "true" });
    const giveSpecial = event.target.closest("[data-test-give-special]");
    if (giveSpecial) {
        const playerCard = giveSpecial.closest(".test-admin-player");
        const effect = playerCard?.querySelector("[data-test-special-select]")?.value;
        if (!effect) return toast("Сначала выберите специальную карту.");
        const traitSelect = [...(playerCard?.querySelectorAll("[data-test-special-trait]") || [])].find((select) => select.dataset.testSpecialTrait === effect);
        if (traitSelect && !traitSelect.value) return toast("Выберите характеристику для этой карты.");
        return socket.emit("test:giveSpecialCard", { targetId: giveSpecial.dataset.player, effect, trait: traitSelect?.value || null });
    }
    const action = event.target.closest("[data-test-action]")?.dataset.testAction;
    if (!action) return;
    if (action === "players") socket.emit("test:setPlayers", { count: Number($("#testPlayerCount").value) });
    if (action === "start") socket.emit("test:start");
    if (action === "pause") socket.emit("test:togglePause");
    if (action === "advance") socket.emit("test:advance");
    if (action === "previous") socket.emit("test:previous");
    if (action === "phase") socket.emit("test:setPhase", { phase: $("#testPhase").value });
    if (action === "round") socket.emit("test:setRound", { round: Number($("#testRound").value) });
    if (action === "vote") socket.emit("test:openVoting");
    if (action === "tie") socket.emit("test:forceTie");
    if (action === "finish") socket.emit("test:finish");
});
$("#testPanel").addEventListener("change", (event) => {
    if (event.target.matches("[data-test-special-select]")) updateTestSpecialTraitPicker(event.target.closest(".test-admin-player"));
});
$("#playerViewToggle").addEventListener("click", () => {
    playersView = playersView === "table" ? "cards" : "table";
    localStorage.setItem("bunker-players-view", playersView);
    if (room?.phase !== "lobby") updateGame();
});
const playerTableMedia = window.matchMedia("(min-width: 721px)");
const refreshPlayersViewForViewport = () => {
    if (!playerTableMedia.matches) {
        playersView = "cards";
        localStorage.setItem("bunker-players-view", playersView);
    }
    if (room?.phase !== "lobby") updateGame();
};
if (playerTableMedia.addEventListener) playerTableMedia.addEventListener("change", refreshPlayersViewForViewport);
else playerTableMedia.addListener(refreshPlayersViewForViewport);
$("#skipVoteButton").addEventListener("click", () => socket.emit("skipVote"));
$("#extendRoomTimer").addEventListener("click", () => socket.emit("extendRoomClose"));
$("#toastClose").addEventListener("click", closeToast);
$("#returnRoom").addEventListener("click", () => tryResumeSession(true));
$("#soundToggle").addEventListener("click", () => {
    soundsEnabled = !soundsEnabled;
    localStorage.setItem("bunker-sounds", soundsEnabled ? "on" : "off");
    updateSoundToggle();
    if (soundsEnabled) playSound("accepted");
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
    const revealCard = event.target.closest("[data-reveal-trait]");
    if (revealCard) {
        socket.emit("revealTrait", revealCard.dataset.revealTrait);
        playSound("reveal");
        return;
    }
    const button = event.target.closest("[data-vote]");
    if (button) socket.emit("castVote", button.dataset.vote);
});
$("#myCards").addEventListener("click", (event) => {
    if (event.target.closest("[data-use-bunker-weapon]")) {
        socket.emit("useBunkerWeapon");
        playSound("accepted");
        return;
    }
    if (event.target.closest("[data-use-special]")) {
        if (["swap_random_trait", "take_backpack", "improve_health", "worsen_health"].includes(mySpecialCard?.effect)) {
            specialTargetMode = !specialTargetMode;
            updateGame();
        } else {
            socket.emit("useSpecialCard");
            playSound("accepted");
        }
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
    const toggle = event.target.closest(".disaster-accordion-toggle");
    const cardToggle = !toggle && event.currentTarget.classList.contains("is-collapsible") && !event.target.closest("button, a, input, select, textarea");
    if (toggle || cardToggle) {
        disasterExpanded = !disasterExpanded;
        const accordionToggle = event.currentTarget.querySelector(".disaster-accordion-toggle");
        accordionToggle?.setAttribute("aria-expanded", String(disasterExpanded));
        const label = accordionToggle?.querySelector(".eyebrow");
        if (label) label.textContent = `КАТАСТРОФА · ${disasterExpanded ? "СКРЫТЬ" : "ОТКРЫТЬ"} ИСТОРИЮ`;
        event.currentTarget.querySelector(".disaster-accordion")?.classList.toggle("is-open", disasterExpanded);
        $("#disasterStory")?.classList.toggle("hidden", !disasterExpanded);
    }
});
$("#resultsBanner").addEventListener("click", (event) => {
    if (event.target.closest("#resultsExtendRoomTimer")) socket.emit("extendRoomClose");
    if (event.target.closest("[data-request-rematch]")) socket.emit("requestRematch");
    if (event.target.closest("[data-decline-rematch]")) socket.emit("declineRematch");
});

socket.on("roomEntered", enterRoom);
socket.on("roomState", (state) => {
    const turnKey = `${state.code}:${state.round}:${state.turnPlayerId || ""}:${state.turnDeadline || ""}`;
    const isMyTurn = state.phase === "reveal" && state.turnPlayerId === ownPlayerId();
    const justFinished = state.phase === "finished" && (!room || room.code !== state.code || room.phase !== "finished");
    const enteringTestRoom = Boolean(state.isTestRoom && (!room || room.code !== state.code));
    if (Number.isFinite(Number(state.serverNow))) serverTimeOffset = Number(state.serverNow) - Date.now();
    if (state.visualTheme && state.visualTheme !== lastAppliedRoomTheme && (!room || room.code !== state.code)) {
        applyColorTheme(state.visualTheme);
        lastAppliedRoomTheme = state.visualTheme;
    }
    room = state;
    if (enteringTestRoom) testPanelOpen = true;
    renderRoom();
    if (state.isTestRoom && state.hostId === ownPlayerId()) socket.emit("test:state");
    if (justFinished) {
        requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    }
    if (isMyTurn && turnKey !== lastTurnSoundKey) playSound("turn");
    lastTurnSoundKey = turnKey;
});
socket.on("leftRoom", () => {
    room = null;
    testServerState = null;
    testPanelOpen = false;
    myCards = {};
    myPlayerId = "";
    mySpecialCard = null;
    myWeaponStatus = { hasWeapon: false, used: false, canEvict: false };
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
    testServerState = null;
    testPanelOpen = false;
    myCards = {};
    myPlayerId = "";
    mySpecialCard = null;
    myWeaponStatus = { hasWeapon: false, used: false, canEvict: false };
    specialTargetMode = false;
    currentCode = "";
    clearSavedSession();
    $("#roomCode").value = "";
    show("#menu");
    toast("Комната закрыта. Спасибо за игру!");
});
socket.on("lobbyClosed", ({ reason } = {}) => {
    room = null;
    testServerState = null;
    testPanelOpen = false;
    myCards = {};
    myPlayerId = "";
    currentCode = "";
    clearSavedSession();
    $("#roomCode").value = "";
    show("#menu");
    toast(reason || "Лобби закрыто.");
});
socket.on("yourCards", (cards) => { myCards = cards; if (room?.phase !== "lobby") updateGame(); });
socket.on("test:ready", () => {
    testPanelOpen = true;
    renderIntegratedTestAdmin();
});
socket.on("test:state", (state) => {
    testServerState = state;
    renderIntegratedTestAdmin();
});
socket.on("test:healthApplied", ({ value } = {}) => toast(`Тест: здоровье изменено — ${value}.`));
socket.on("test:specialApplied", ({ value } = {}) => toast(value ? `Тест: ${value}.` : "Тестовая спецкарта применена."));
socket.on("test:specialGiven", ({ nickname: name, name: cardName } = {}) => toast(`${name} получает спецкарту «${cardName}».`));
socket.on("yourSpecialCard", (card) => {
    mySpecialCard = card || null;
    if (room?.phase !== "lobby") updateGame();
});
socket.on("yourWeaponStatus", (status) => {
    myWeaponStatus = {
        hasWeapon: Boolean(status?.hasWeapon),
        revealed: Boolean(status?.revealed),
        used: Boolean(status?.used),
        canEvict: Boolean(status?.canEvict)
    };
    if (room?.phase !== "lobby") updateGame();
});
socket.on("gameStarted", () => { toast("Катастрофа выбрана. Прочитайте историю перед началом."); playSound("story"); });
socket.on("roundStarted", ({ initial } = {}) => { toast(initial ? "История прочитана. Первый раунд начинается." : "Новый раунд: выберите карту, которую хотите раскрыть.", { duration: 2200 }); playSound("round"); });
socket.on("cardRevealed", ({ playerId, trait }) => {
    pendingRevealAnimation = { playerId, trait };
    if (room?.phase !== "lobby") updateGame();
    if (playerId !== ownPlayerId()) playSound("reveal");
});
socket.on("professionItemReceived", ({ playerId, nickname: name, item }) => {
    toast(playerId === ownPlayerId() ? "В багаж добавлено: " + item + "." : name + " получает в багаж: " + item + ".");
    playSound("accepted");
});
socket.on("residentEvicted", ({ nickname: name, capacity }) => {
    toast(name + " выгоняет жителя из бункера. Мест для игроков: " + capacity + ".");
    playSound("accepted");
});
socket.on("specialCardUsed", ({ nickname: name, targetNickname, cardName, trait, action, item, capacity, direction, amount, value, alreadyHealthy }) => {
    const message = action === "take_backpack"
        ? name + " применяет «" + cardName + "» и забирает «" + item + "» у " + targetNickname + " в багаж."
        : action === "swap_adjacent_profession"
            ? name + " применяет «" + cardName + "» и меняется профессией с соседом " + (direction === "left" ? "слева" : direction === "right" ? "справа" : "случайно") + ": " + targetNickname + "."
        : action === "increase_capacity"
            ? name + " применяет «" + cardName + "»: мест в бункере стало " + capacity + "."
        : action === "decrease_capacity" || action === "random_capacity"
                ? name + " применяет «" + cardName + "»: мест в бункере стало " + capacity + "."
                : action === "reroll_own_trait"
                    ? name + " применяет «" + cardName + "» и переролливает «" + traitName(trait) + "»."
                    : action === "improve_health"
                        ? alreadyHealthy
                            ? targetNickname + " уже полностью здоров. Карта «" + cardName + "» использована."
                            : "Здоровье " + targetNickname + " улучшено на " + amount + " стадии. Теперь: " + value + "."
                        : action === "worsen_health"
                            ? "Здоровье " + targetNickname + " ухудшено на " + amount + " стадии. Теперь: " + value + "."
                    : name + " применяет «" + cardName + "»: обмен «" + traitName(trait) + "» с " + targetNickname + ".";
    toast(message);
    playSound("accepted");
});
socket.on("votingStarted", ({ eliminations = 1, runoff = false } = {}) => { toast(runoff ? "Начинается дополнительное голосование." : eliminations > 1 ? `Все раскрылись. В этом раунде выбывают ${eliminations} игрока.` : "Все раскрылись. Пора голосовать.", { important: eliminations > 1 || runoff }); playSound("vote"); });
socket.on("voteAccepted", () => { toast("Ваш голос принят."); playSound("accepted"); });
socket.on("playerEliminated", ({ nickname: name }) => { toast(`${name} не попадает в бункер.`); playSound("out"); });
socket.on("playersEliminated", ({ nicknames = [] } = {}) => { if (nicknames.length) toast(`Из бункера исключены: ${nicknames.join(", ")}.`, { important: true }); });
socket.on("turnAutoRevealed", ({ nickname: name, trait }) => {
    toast(`${name} не выбрал карту — автоматически раскрыта «${traitName(trait)}».`);
});
socket.on("turnSkipped", ({ nickname: name }) => { toast(`${name} не успел раскрыть карту — ход пропущен.`); playSound("skip"); });
socket.on("voteTied", ({ nextRound, runoff, slots, candidates = [] } = {}) => { toast(runoff ? `Ничья за ${slots > 1 ? slots + " места" : "место"}. Переголосование: ${candidates.join(", ")}.` : nextRound ? "Голоса разделились. Открываем следующую карту." : "Ничья: никто не исключен.", { important: Boolean(runoff) }); playSound("tie"); });
socket.on("voteSkipped", () => { toast("Решение команды: никого не исключаем. Начинается следующий раунд."); playSound("tie"); });
socket.on("revealLimitReached", () => { toast("Лимит раскрытий достигнут: оставшиеся карты останутся тайной."); playSound("vote"); });
socket.on("gameFinished", ({ survivors }) => { toast(`Выжили: ${survivors.join(", ")}.`); playSound("finish"); });
socket.on("rematchUpdated", ({ nickname: name, ready }) => { toast(ready ? `${name} готов сыграть снова.` : `${name} не участвует в следующей игре.`, { duration: 2200 }); });
socket.on("rematchClosed", ({ reason }) => { toast(reason || "Минута на решение закончилась.", { important: true }); });
socket.on("rematchLobby", () => { toast("Готовые игроки вернулись в лобби. Можно дождаться остальных или добавить ботов.", { important: true }); });
socket.on("rematchExcluded", () => {
    room = null;
    myCards = {};
    myPlayerId = "";
    mySpecialCard = null;
    myWeaponStatus = { hasWeapon: false, used: false, canEvict: false };
    specialTargetMode = false;
    currentCode = "";
    clearSavedSession();
    $("#roomCode").value = "";
    show("#menu");
    toast("Вы не участвуете в следующей партии.");
});
socket.on("gameRestarted", ({ playerCount } = {}) => { toast(`Новая партия начинается${playerCount ? `: ${playerCount} игроков` : ""}.`, { important: true }); playSound("start"); });
socket.on("errorMessage", (message) => toast(message, { critical: true }));
socket.on("disconnect", () => toast("Соединение с сервером потеряно."));
socket.on("connect", tryResumeSession);

clearInterval(countdownTimer);
countdownTimer = setInterval(updateActionTimer, 250);
updateSoundToggle();
applyColorTheme(localStorage.getItem(THEME_STORAGE_KEY) || "amber");
fetch("/api/admin/test-access", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${localStorage.getItem("bunker-admin-token") || ""}` }
})
    .then((response) => response.ok ? response.json() : {})
    .then((options) => {
        testModeAvailable = Boolean(options.testMode);
        $("#createTestRoom").classList.toggle("hidden", !testModeAvailable);
    })
    .catch(() => {});
$("#returnRoom").classList.toggle("hidden", !savedSession);
document.addEventListener("pointerdown", unlockSound, { once: true });
document.addEventListener("keydown", unlockSound, { once: true });
if (socket.connected) tryResumeSession();
