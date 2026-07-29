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
let myWeaponStatus = { hasWeapon: false, used: false, canEvict: false };
let specialTargetMode = false;
let playersView = localStorage.getItem("bunker-players-view") === "table" ? "table" : "cards";

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

function waterFillPercentage(trait) {
    const traitHint = `${trait?.id || ""} ${trait?.name || ""}`.toLocaleLowerCase("ru");
    if (!/water|вод/.test(traitHint)) return null;
    const value = String(trait?.value || "").toLocaleLowerCase("ru");
    if (/нет|отсутств|пуст/.test(value)) return 0;
    const percentValue = Number((value.match(/(\d{1,3})\s*%/) || [])[1]);
    if (Number.isFinite(percentValue)) return Math.max(0, Math.min(100, percentValue));
    const directFill = Number(trait?.fillPercent);
    if (Number.isFinite(directFill)) return Math.max(0, Math.min(100, Math.round(directFill)));
    const hasTwoYears = /(?:2|два|две)\s*(?:год|лет)/.test(value);
    const hasYear = /год|лет/.test(value);
    const hasMonths = /месяц/.test(value);
    const hasDays = /дн(?:я|ей|ь)?/.test(value);
    const number = Number((value.match(/\d+(?:[.,]\d+)?/) || [])[0]?.replace(",", ".")) || 1;
    const months = hasTwoYears ? 24 : hasYear ? number * 12 : hasMonths ? number : hasDays ? number / 30 : 3;
    return Math.max(0, Math.min(100, Math.round((months / 24) * 100)));
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

function cardMarkup(trait, value, revealed, canChoose, isRevealing = false, isFinishReveal = false) {
    const status = canChoose ? "раскрыть" : isFinishReveal ? "раскрыта в финале" : revealed ? "раскрыта" : "не раскрыта";
    const content = `<span>${escaped(traitName(trait))}</span><strong>${escaped(value)}</strong><em>${status}</em>`;
    const classes = `my-card ${revealed ? "is-revealed" : ""} ${isFinishReveal ? "is-finish-reveal" : ""} ${canChoose ? "is-choice" : ""} ${isRevealing ? "is-revealing" : ""}`;
    return canChoose
        ? `<button type="button" class="${classes}" data-reveal-trait="${trait}">${content}</button>`
        : `<article class="${classes}">${content}</article>`;
}

function playerTableMarkup(cardOrder, me, isVoting, hasVoted, isFinished, specialTargetAction, canChooseTrait, canRevealProfession) {
    const players = room.players;
    const baggageFor = (player) => [player.professionItem, ...(Array.isArray(player.extraBaggage) ? player.extraBaggage : [])].filter(Boolean);
    const baggageText = (player) => baggageFor(player).join(" · ");
    const hasBaggageItems = players.some((player) => baggageFor(player).length);
    const hasUsedSpecialCards = players.some((player) => player.usedSpecialCard);
    const playerStatus = (player) => player.left ? "вышел" : player.eliminated ? "исключён" : isFinished ? "победитель" : "в игре";
    const playerState = (player) => player.left ? "left-player" : player.eliminated ? "eliminated" : isFinished ? "survivor" : "active-player";
    const traitRow = (label, cells, extraClass = "") => `<tr class="${extraClass}"><th scope="row"><span class="table-header-value" title="${escaped(label)}">${escaped(label)}</span></th>${cells}</tr>`;
    const traitRows = cardOrder.map((trait) => traitRow(
        traitName(trait),
        players.map((player) => {
            const isRevealed = Object.prototype.hasOwnProperty.call(player.revealed || {}, trait);
            const isMe = player.id === ownPlayerId();
            const hasOwnValue = isMe && Object.prototype.hasOwnProperty.call(myCards, trait);
            const isFinishReveal = isFinished && !player.left && !player.eliminated && Array.isArray(player.finishRevealedTraits) && player.finishRevealedTraits.includes(trait);
            const value = hasOwnValue ? myCards[trait] : isRevealed ? player.revealed[trait] : "скрыто";
            const canRevealHere = isMe && !isRevealed && (canChooseTrait || (canRevealProfession && trait === room.currentTrait));
            const visibilityClass = isFinishReveal ? "is-finish-reveal-value" : isRevealed ? "is-revealed-value" : hasOwnValue ? "is-private-value" : "is-hidden-value";
            return `<td class="${visibilityClass} ${playerState(player)}"><div class="table-cell-content ${canRevealHere ? "has-reveal-control" : ""}"><span class="table-cell-value" title="${escaped(value)}">${escaped(value)}</span>${canRevealHere ? `<button class="table-reveal-button" type="button" data-reveal-trait="${trait}" title="Раскрыть: ${escaped(traitName(trait))}" aria-label="Раскрыть: ${escaped(traitName(trait))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.8"></circle></svg></button>` : ""}</div></td>`;
        }).join("")
    )).join("");
    const extraRows = [
        hasBaggageItems ? traitRow("Багаж", players.map((player) => `<td class="table-extra ${baggageFor(player).length ? "is-revealed-value" : ""} ${playerState(player)}"><span class="table-cell-value" title="${escaped(baggageText(player) || "—")}">${baggageText(player) ? escaped(baggageText(player)) : "—"}</span></td>`).join("")) : "",
        hasUsedSpecialCards ? traitRow("Спецкарта", players.map((player) => `<td class="table-extra ${player.usedSpecialCard ? "is-revealed-value" : ""} ${playerState(player)}"><span class="table-cell-value" title="${escaped(player.usedSpecialCard?.name || "—")}">${player.usedSpecialCard ? escaped(player.usedSpecialCard.name) : "—"}</span></td>`).join("")) : ""
    ].join("");
    const showVotes = isVoting || players.some((player) => (room.voteMarkers?.[player.id] || []).length);
    const voteRow = showVotes ? traitRow("Голоса против", players.map((player) => {
        const voters = (room.voteMarkers?.[player.id] || [])
            .map((voterId) => players.find((candidate) => candidate.id === voterId))
            .filter(Boolean);
        const visibleVoters = voters.slice(0, 3);
        const voteWord = voters.length === 1 ? "голос" : voters.length >= 2 && voters.length <= 4 ? "голоса" : "голосов";
        return `<td class="table-vote-cell ${playerState(player)}">${visibleVoters.map((voter) => `<span class="vote-avatar" title="${escaped(voter.nickname)}">${avatarMarkup(voter)}</span>`).join("")}${voters.length > visibleVoters.length ? `<span class="vote-more">+${voters.length - visibleVoters.length}</span>` : ""}<span class="table-vote-count ${voters.length ? "" : "is-empty"}">${voters.length} ${voteWord}</span></td>`;
    }).join(""), "table-vote-row") : "";
    const actionRow = (isVoting || specialTargetMode) ? traitRow("Действие", players.map((player) => {
        const canVote = isVoting && !hasVoted && !me?.eliminated && !player.left && !player.eliminated && player.id !== ownPlayerId();
        const canSelectSpecialTarget = specialTargetMode && !player.left && !player.eliminated && player.id !== ownPlayerId();
        const action = canSelectSpecialTarget
            ? `<button class="special-target-button" data-special-target="${player.id}">${escaped(specialTargetAction)}</button>`
            : canVote ? `<button class="vote-button" data-vote="${player.id}">Исключить</button>` : "—";
        return `<td class="table-action-cell ${playerState(player)}">${action}</td>`;
    }).join(""), "table-action-row") : "";
    const playerHeaders = players.map((player) => `<th scope="col" class="${playerState(player)}"><span class="table-player-head">${avatarMarkup(player)}<strong title="${escaped(player.nickname)}">${escaped(player.nickname)}${player.id === ownPlayerId() ? " (вы)" : ""}</strong><small>${playerStatus(player)}</small></span></th>`).join("");
    return `<div class="players-table-scroll"><table class="players-table"><thead><tr><th><span class="table-header-value" title="Характеристика">Характеристика</span></th>${playerHeaders}</tr></thead><tbody>${traitRows}${extraRows}${voteRow}${actionRow}</tbody></table></div>`;
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
        return '<span class="utility-player">' + avatarMarkup(player) + '<span><strong>' + escaped(player.nickname) + '</strong><small>' + entry.revealedCards + ' карт</small></span><b>' + entry.utility + '%</b></span>';
    }).join("");
    const myRevealed = me?.revealed || {};
    const hasRevealedThisRound = Boolean(room.revealedThisRound?.[ownPlayerId()]);
    const isChoiceRound = room.phase === "reveal" && !trait;
    const turnPlayer = room.players.find((player) => player.id === room.turnPlayerId);
    const isMyTurn = room.turnPlayerId === ownPlayerId();
    const hasVoted = room.votedPlayerIds?.includes(ownPlayerId());
    const canUseSpecialCard = Boolean(mySpecialCard && !mySpecialCard.used && me && !me.eliminated && room.phase === "reveal" && isMyTurn);
    const canUseWeapon = Boolean(myWeaponStatus?.hasWeapon && !myWeaponStatus?.used && myWeaponStatus?.canEvict && me && !me.eliminated && room.phase === "reveal" && isMyTurn);
    const specialNeedsTarget = ["swap_random_trait", "take_backpack"].includes(mySpecialCard?.effect);
    const specialTraitLabel = !mySpecialCard ? "" : mySpecialCard.effect === "take_backpack" ? "Забрать предмет из рюкзака"
        : mySpecialCard.effect === "increase_capacity" ? "Добавить 1 место в бункере"
            : mySpecialCard.effect === "decrease_capacity" ? "Убрать 1 место в бункере"
                : mySpecialCard.effect === "random_capacity" ? "Случайно: +1 или −1 место"
                    : mySpecialCard.effect === "reroll_own_trait" ? `Переролл: ${traitName(mySpecialCard.trait)}`
                        : `Обмен: ${traitName(mySpecialCard.trait)}`;
    const specialTargetAction = !mySpecialCard ? "" : mySpecialCard.effect === "take_backpack" ? "Забрать предмет" : `Обменяться: ${traitName(mySpecialCard.trait)}`;
    if (!canUseSpecialCard) specialTargetMode = false;

    $("#gameCode").textContent = room.code;
    $("#phaseTitle").textContent = isFinished ? "Игра завершена" : isStory ? "История катастрофы" : isVoting ? "Голосование" : "Раскрытие карт";
    $("#resultsBanner").classList.toggle("hidden", !isFinished);
    $("#resultsBanner").innerHTML = isFinished ? `
        <div class="result-copy"><span class="result-kicker">ПОБЕДИТЕЛИ БУНКЕРА</span><h3>${winners.length ? "В бункере остались" : "Выживших не осталось"}</h3></div>
        <div class="winner-list">${winners.map((player) => `<span class="winner-chip">${avatarMarkup(player)}<strong>${escaped(player.nickname)}</strong></span>`).join("")}</div>
        ${utilityRows ? `<div class="utility-breakdown"><span class="utility-kicker">ПОЛЕЗНОСТЬ ВЫЖИВШИХ</span><div class="utility-list">${utilityRows}</div></div>` : ""}
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
        : `<details class="disaster-accordion"><summary><span class="eyebrow">КАТАСТРОФА · ОТКРЫТЬ ИСТОРИЮ</span><span class="accordion-icon" aria-hidden="true">⌄</span></summary><p>${disasterText}</p></details><div class="disaster-meta"><span class="capacity">${capacityLabel}</span>${shelterDuration}${bunkerChance}</div>`;
    $("#disasterCard").classList.toggle("story-mode", isStory);
    $("#disasterCard").innerHTML = disasterContent;
    const bunkerTraits = Array.isArray(room.bunkerTraits) ? room.bunkerTraits : [];
    $("#bunkerTraitsPanel").classList.toggle("hidden", !bunkerTraits.length);
    $("#bunkerTraits").innerHTML = bunkerTraits.map((trait) => {
        const waterLevel = waterFillPercentage(trait);
        return [
        '<article class="bunker-trait-card' + (waterLevel === null ? '' : ' is-water-reserve') + '"' + (waterLevel === null ? '' : ' style="--water-fill:' + waterLevel + '%"') + '>',
        '<span>' + escaped(trait.name) + '</span>',
        '<strong>' + escaped(trait.value) + '</strong>',
        trait.occupiedSlots ? '<small>занято мест: ' + escaped(trait.occupiedSlots) + '</small>' : '',
        trait.evictedResidents ? '<small>выгнано жителей: ' + escaped(trait.evictedResidents) + '</small>' : '',
        '</article>'
        ].join("");
    }).join("");
    $("#survivorCount").textContent = `${active.length} в игре`;
    const categoryCount = room.categoryOrder?.length || Object.keys(myCards).length;
    const revealRoundCount = room.revealRounds || categoryCount;
    $("#playerViewToggle").textContent = playersView === "table" ? "▤ Карточки" : "▦ Таблица";
    $("#playerViewToggle").setAttribute("aria-pressed", String(playersView === "table"));
    $(".round-panel").classList.toggle("hidden", isStory);
    $(".round-panel").classList.toggle("is-finished", isFinished);
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
        isNewReveal(ownPlayerId(), name),
        isFinished && Array.isArray(me?.finishRevealedTraits) && me.finishRevealedTraits.includes(name)
    )).join("");
    const professionBaggage = me?.professionItem
        ? '<article class="my-card is-revealed profession-item-card"><span>Багаж от профессии</span><strong>' + escaped(me.professionItem) + '</strong><em>получен</em></article>'
        : "";
    const extraBaggageCards = (Array.isArray(me?.extraBaggage) ? me.extraBaggage : []).map((item) => (
        '<article class="my-card is-revealed profession-item-card"><span>Багаж</span><strong>' + escaped(item) + '</strong><em>добавлен</em></article>'
    )).join("");
    const weaponActionCard = myWeaponStatus?.hasWeapon
        ? '<' + (canUseWeapon ? 'button type="button" data-use-bunker-weapon' : 'article') + ' class="my-card weapon-action-card ' + (myWeaponStatus?.used ? 'is-used' : '') + (canUseWeapon ? ' is-choice' : '') + '"><span>Предмет в багаже</span><strong>Оружие</strong><small>Выгнать жителя и освободить 1 место</small><em>' + (myWeaponStatus?.used ? 'житель выгнан' : !myWeaponStatus?.canEvict ? 'жителей нет' : canUseWeapon ? 'нажмите, чтобы применить' : 'доступно в ваш ход') + '</em></' + (canUseWeapon ? 'button' : 'article') + '>'
        : '';
    const specialCardInHand = mySpecialCard
        ? '<' + (canUseSpecialCard ? 'button type="button" data-use-special' : 'article') + ' class="my-card special-card-hand ' + (mySpecialCard.used ? 'is-used' : '') + (canUseSpecialCard ? ' is-choice' : '') + '"><span>Специальная карта</span><strong>' + escaped(mySpecialCard.name) + '</strong><small>' + escaped(specialTraitLabel) + '</small><em>' + (mySpecialCard.used ? 'использована' : specialTargetMode ? 'выберите игрока' : canUseSpecialCard ? 'нажмите, чтобы применить' : 'доступна в ваш ход') + '</em></' + (canUseSpecialCard ? 'button' : 'article') + '>'
        : "";
    $("#myCards").innerHTML = personalCards + professionBaggage + extraBaggageCards + weaponActionCard + specialCardInHand;
    const playerCardsMarkup = room.players.map((player) => {
        const playerCards = cardOrder.map((name) => {
            const isRevealed = Object.prototype.hasOwnProperty.call(player.revealed || {}, name);
            const isMe = player.id === ownPlayerId();
            const hasOwnValue = isMe && Object.prototype.hasOwnProperty.call(myCards, name);
            const isFinishReveal = isFinished && !player.left && !player.eliminated && Array.isArray(player.finishRevealedTraits) && player.finishRevealedTraits.includes(name);
            const value = hasOwnValue ? myCards[name] : isRevealed ? player.revealed[name] : "скрыто";
            const canRevealHere = isMe && !isRevealed && (canChooseTrait || (canRevealProfession && name === room.currentTrait));
            const visibilityClass = isFinishReveal ? "is-finish-reveal-card" : isRevealed ? "" : hasOwnValue ? "is-private-card" : "is-hidden-card";
            const revealControl = canRevealHere
                ? `<button class="card-reveal-eye" type="button" data-reveal-trait="${name}" title="Раскрыть: ${escaped(traitName(name))}" aria-label="Раскрыть: ${escaped(traitName(name))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.8"></circle></svg></button>`
                : "";
            return `<div class="public-card ${visibilityClass} ${canRevealHere ? "has-reveal-control" : ""} ${isNewReveal(player.id, name) ? "is-revealing" : ""}"><b>${escaped(traitName(name))}:</b> <span class="public-card-value">${escaped(value)}</span>${revealControl}</div>`;
        }).join("")
            + (player.professionItem ? `<span class="public-card profession-item"><b>Багаж:</b> ${escaped(player.professionItem)}</span>` : "")
            + (Array.isArray(player.extraBaggage) ? player.extraBaggage.map((item) => `<span class="public-card profession-item"><b>Багаж:</b> ${escaped(item)}</span>`).join("") : "")
            + (player.usedSpecialCard ? `<span class="public-card special-card-used"><b>Спецкарта:</b> ${escaped(player.usedSpecialCard.name)}</span>` : "");
        const canVote = isVoting && !hasVoted && !me?.eliminated && !player.left && !player.eliminated && player.id !== ownPlayerId();
        const canSelectSpecialTarget = specialTargetMode && !player.left && !player.eliminated && player.id !== ownPlayerId();
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
            <div class="player-name">${avatarMarkup(player)}<div><strong>${escaped(player.nickname)}${player.id === ownPlayerId() ? " (вы)" : ""}</strong><small>${playerStatus}</small></div>${voteMarkerMarkup}</div>
            <div class="public-cards">${playerCards || '<span class="muted">карты ещё не раскрыты</span>'}</div>
            ${playerActions ? `<div class="player-actions">${playerActions}</div>` : ""}
            ${player.id === room.hostId ? '<span class="host-star" aria-label="Ведущий" title="Ведущий">★</span>' : ""}
        </article>`;
    }).join("");
    $("#gamePlayers").classList.toggle("players-table-view", playersView === "table");
    $("#gamePlayers").innerHTML = playersView === "table"
        ? playerTableMarkup(cardOrder, me, isVoting, hasVoted, isFinished, specialTargetAction, canChooseTrait, canRevealProfession)
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
}

function enterRoom({ code, playerToken, playerId }) {
    currentCode = code;
    myPlayerId = playerId || socket.id;
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
$("#playerViewToggle").addEventListener("click", () => {
    playersView = playersView === "table" ? "cards" : "table";
    localStorage.setItem("bunker-players-view", playersView);
    if (room?.phase !== "lobby") updateGame();
});
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
        if (["swap_random_trait", "take_backpack"].includes(mySpecialCard?.effect)) {
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
});

socket.on("roomEntered", enterRoom);
socket.on("roomState", (state) => {
    const turnKey = `${state.code}:${state.round}:${state.turnPlayerId || ""}:${state.turnDeadline || ""}`;
    const isMyTurn = state.phase === "reveal" && state.turnPlayerId === ownPlayerId();
    const justFinished = state.phase === "finished" && (!room || room.code !== state.code || room.phase !== "finished");
    room = state;
    renderRoom();
    if (justFinished) {
        requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    }
    if (isMyTurn && turnKey !== lastTurnSoundKey) playSound("turn");
    lastTurnSoundKey = turnKey;
});
socket.on("leftRoom", () => {
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
});
socket.on("resumeFailed", () => {
    clearSavedSession();
    currentCode = "";
    show("#menu");
});
socket.on("roomExpired", () => {
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
    toast("Комната закрыта. Спасибо за игру!");
});
socket.on("yourCards", (cards) => { myCards = cards; if (room?.phase !== "lobby") updateGame(); });
socket.on("yourSpecialCard", (card) => {
    mySpecialCard = card || null;
    if (room?.phase !== "lobby") updateGame();
});
socket.on("yourWeaponStatus", (status) => {
    myWeaponStatus = {
        hasWeapon: Boolean(status?.hasWeapon),
        used: Boolean(status?.used),
        canEvict: Boolean(status?.canEvict)
    };
    if (room?.phase !== "lobby") updateGame();
});
socket.on("gameStarted", () => { toast("Катастрофа выбрана. Прочитайте историю перед началом."); playSound("story"); });
socket.on("roundStarted", ({ initial } = {}) => { toast(initial ? "История прочитана. Первый раунд начинается." : "Новый раунд: выберите карту, которую хотите раскрыть."); playSound("round"); });
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
socket.on("specialCardUsed", ({ nickname: name, targetNickname, cardName, trait, action, item, capacity }) => {
    const message = action === "take_backpack"
        ? name + " применяет «" + cardName + "» и забирает «" + item + "» у " + targetNickname + " в багаж."
        : action === "increase_capacity"
            ? name + " применяет «" + cardName + "»: мест в бункере стало " + capacity + "."
        : action === "decrease_capacity" || action === "random_capacity"
                ? name + " применяет «" + cardName + "»: мест в бункере стало " + capacity + "."
                : action === "reroll_own_trait"
                    ? name + " применяет «" + cardName + "» и переролливает «" + traitName(trait) + "»."
                    : name + " применяет «" + cardName + "»: обмен «" + traitName(trait) + "» с " + targetNickname + ".";
    toast(message);
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
