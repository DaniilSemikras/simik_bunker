"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_FRAME_ID, isPlayerFrame, pickCaseFrame } = require("./player-frames");

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

async function supabaseError(response, operation) {
    const payload = await response.json().catch(() => null);
    const detail = String(payload?.message || payload?.details || payload?.hint || "").trim().slice(0, 240);
    return new Error(`${operation} вернул ${response.status}${detail ? `: ${detail}` : ""}.`);
}

class PlayerProfileStore {
    constructor({ filePath, supabaseUrl = "", supabaseKey = "", requireRemote = false, logger = console }) {
        this.filePath = filePath;
        this.supabaseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
        this.supabaseKey = String(supabaseKey || "");
        this.logger = logger;
        this.requireRemote = Boolean(requireRemote);
        this.profiles = Object.create(null);
        this.persistQueue = Promise.resolve();
        this.remoteConnected = false;
        this.lastRemoteError = "";
    }

    get usesSupabase() {
        return Boolean(this.supabaseUrl && this.supabaseKey);
    }

    headers(extra = {}) {
        const headers = { apikey: this.supabaseKey, ...extra };
        if (String(this.supabaseKey || "").split(".").length === 3) {
            headers.authorization = `Bearer ${this.supabaseKey}`;
        }
        return headers;
    }

    normalizeProfile(profile = {}, user = {}) {
        const userId = String(user.id || profile.userId || "");
        const ownedFrames = [...new Set([DEFAULT_FRAME_ID, ...(Array.isArray(profile.ownedFrames) ? profile.ownedFrames : [])])]
            .filter(isPlayerFrame);
        const selectedFrame = ownedFrames.includes(profile.selectedFrame) ? profile.selectedFrame : DEFAULT_FRAME_ID;
        const metadata = user.user_metadata || {};
        const completedGameIds = [...new Set(Array.isArray(profile.completedGameIds) ? profile.completedGameIds.map(String) : [])].slice(-250);
        const completedGames = Math.max(completedGameIds.length, Number(profile.completedGames) || 0);
        const casesOpened = Math.max(Number(profile.casesOpened) || 0, profile.freeCaseOpened ? 1 : 0);
        const caseBalance = Math.max(0, Number.isFinite(Number(profile.caseBalance))
            ? Math.floor(Number(profile.caseBalance))
            : (profile.freeCaseOpened ? 0 : 1));
        return {
            userId,
            email: String(user.email || profile.email || ""),
            displayName: String(metadata.full_name || metadata.name || profile.displayName || "Игрок").slice(0, 80),
            pictureUrl: String(metadata.avatar_url || metadata.picture || profile.pictureUrl || "").slice(0, 600),
            ownedFrames,
            selectedFrame,
            freeCaseOpened: casesOpened > 0,
            caseBalance,
            casesOpened,
            completedGames,
            completedGameIds,
            createdAt: profile.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    loadLocal() {
        try {
            if (!fs.existsSync(this.filePath)) return {};
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            this.logger.warn("Не удалось прочитать локальные профили игроков.", error.message);
            return {};
        }
    }

    saveLocal() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, `${JSON.stringify(this.profiles, null, 2)}\n`, "utf8");
    }

    async readRemote() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_config?select=config&id=eq.3`, { headers: this.headers() });
        if (!response.ok) throw await supabaseError(response, "Supabase profiles");
        const rows = await response.json();
        const profiles = rows[0]?.config?.profiles;
        return profiles && typeof profiles === "object" && !Array.isArray(profiles) ? profiles : {};
    }

    async writeRemote() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_config?on_conflict=id`, {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
            body: JSON.stringify({
                id: 3,
                config: { version: 1, profiles: this.profiles },
                updated_at: new Date().toISOString()
            })
        });
        if (!response.ok) throw await supabaseError(response, "Supabase profiles");
    }

    async writeRemoteWithRetry(attempts = 3) {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await this.writeRemote();
                this.remoteConnected = true;
                this.lastRemoteError = "";
                return;
            } catch (error) {
                lastError = error;
                this.remoteConnected = false;
                this.lastRemoteError = error.message;
                if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 180));
            }
        }
        throw lastError;
    }

    async initialize() {
        const local = this.loadLocal();
        let remote = {};
        if (this.usesSupabase) {
            try {
                remote = await this.readRemote();
                this.remoteConnected = true;
                this.lastRemoteError = "";
            } catch (error) {
                this.remoteConnected = false;
                this.lastRemoteError = error.message;
                this.logger.warn("Профили Supabase недоступны, используется локальная копия.", error.message);
            }
        }
        this.profiles = Object.assign(Object.create(null), local, remote);
        this.saveLocal();
        return Object.keys(this.profiles).length;
    }

    get(userId) {
        const profile = this.profiles[String(userId || "")];
        return profile ? clone(profile) : null;
    }

    list() {
        return Object.values(this.profiles).map(clone).sort((first, second) =>
            String(second.updatedAt || "").localeCompare(String(first.updatedAt || "")));
    }

    status() {
        return {
            backend: this.usesSupabase ? "supabase" : "local",
            connected: this.usesSupabase && this.remoteConnected,
            persistent: this.usesSupabase && this.remoteConnected,
            required: this.requireRemote,
            error: this.lastRemoteError || null
        };
    }

    async persist() {
        this.saveLocal();
        if (!this.usesSupabase) {
            if (this.requireRemote) throw new Error("Постоянное хранилище профилей не подключено.");
            return;
        }
        const operation = this.persistQueue.catch(() => {}).then(() => this.writeRemoteWithRetry());
        this.persistQueue = operation;
        try {
            await operation;
        } catch (error) {
            this.logger.error("Профиль не удалось сохранить в Supabase.", error.message);
            throw new Error("Не удалось сохранить рамки и прогресс в постоянной базе. Попробуйте ещё раз.");
        }
    }

    async ensure(user) {
        if (!user?.id) throw new Error("У аккаунта отсутствует ID.");
        const previous = this.profiles[user.id] || {};
        const profile = this.normalizeProfile(previous, user);
        this.profiles[user.id] = profile;
        await this.persist();
        return clone(profile);
    }

    async openCase(userId, randomValue = Math.random()) {
        const id = String(userId || "");
        const profile = this.profiles[id];
        if (!profile) throw new Error("Профиль не найден.");
        if ((Number(profile.caseBalance) || 0) < 1) return { opened: false, profile: clone(profile), frame: null };
        const frame = pickCaseFrame(randomValue);
        profile.caseBalance = Math.max(0, (Number(profile.caseBalance) || 0) - 1);
        profile.casesOpened = (Number(profile.casesOpened) || 0) + 1;
        profile.freeCaseOpened = true;
        profile.ownedFrames = [...new Set([...(profile.ownedFrames || []), frame.id])];
        profile.selectedFrame = frame.id;
        profile.updatedAt = new Date().toISOString();
        await this.persist();
        return { opened: true, profile: clone(profile), frame: clone(frame) };
    }

    async openFreeCase(userId, randomValue = Math.random()) {
        return this.openCase(userId, randomValue);
    }

    async recordCompletedGames(userIds, gameId) {
        const uniqueIds = [...new Set((userIds || []).map(String).filter(Boolean))];
        const normalizedGameId = String(gameId || "");
        const rewards = [];
        let changed = false;
        for (const userId of uniqueIds) {
            const profile = this.profiles[userId];
            if (!profile || !normalizedGameId || (profile.completedGameIds || []).includes(normalizedGameId)) continue;
            profile.completedGameIds = [...(profile.completedGameIds || []), normalizedGameId].slice(-250);
            profile.completedGames = (Number(profile.completedGames) || 0) + 1;
            const caseEarned = profile.completedGames % 5 === 0;
            if (caseEarned) profile.caseBalance = (Number(profile.caseBalance) || 0) + 1;
            profile.updatedAt = new Date().toISOString();
            rewards.push({ userId, caseEarned, completedGames: profile.completedGames, caseBalance: profile.caseBalance });
            changed = true;
        }
        if (changed) await this.persist();
        return rewards;
    }

    async adminUpdate(userId, { caseDelta = 0, frameId = "", owned } = {}) {
        const profile = this.profiles[String(userId || "")];
        if (!profile) throw new Error("Профиль не найден.");
        const delta = Math.max(-100, Math.min(100, Math.trunc(Number(caseDelta) || 0)));
        if (delta) profile.caseBalance = Math.max(0, (Number(profile.caseBalance) || 0) + delta);
        if (frameId) {
            if (!isPlayerFrame(frameId)) throw new Error("Неизвестная рамка.");
            const frames = new Set(profile.ownedFrames || [DEFAULT_FRAME_ID]);
            if (owned === false && frameId !== DEFAULT_FRAME_ID) frames.delete(frameId);
            else frames.add(frameId);
            profile.ownedFrames = [...frames];
            if (!frames.has(profile.selectedFrame)) profile.selectedFrame = DEFAULT_FRAME_ID;
        }
        profile.updatedAt = new Date().toISOString();
        await this.persist();
        return clone(profile);
    }

    async selectFrame(userId, frameId) {
        const profile = this.profiles[String(userId || "")];
        if (!profile) throw new Error("Профиль не найден.");
        if (!isPlayerFrame(frameId) || !profile.ownedFrames.includes(frameId)) throw new Error("Эта рамка ещё не получена.");
        profile.selectedFrame = frameId;
        profile.updatedAt = new Date().toISOString();
        await this.persist();
        return clone(profile);
    }
}

module.exports = { PlayerProfileStore };
