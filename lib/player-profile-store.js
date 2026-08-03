"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_FRAME_ID, isPlayerFrame, pickCaseFrame } = require("./player-frames");

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class PlayerProfileStore {
    constructor({ filePath, supabaseUrl = "", supabaseKey = "", logger = console }) {
        this.filePath = filePath;
        this.supabaseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
        this.supabaseKey = String(supabaseKey || "");
        this.logger = logger;
        this.profiles = Object.create(null);
        this.persistQueue = Promise.resolve();
    }

    get usesSupabase() {
        return Boolean(this.supabaseUrl && this.supabaseKey);
    }

    headers(extra = {}) {
        return { apikey: this.supabaseKey, authorization: `Bearer ${this.supabaseKey}`, ...extra };
    }

    normalizeProfile(profile = {}, user = {}) {
        const userId = String(user.id || profile.userId || "");
        const ownedFrames = [...new Set([DEFAULT_FRAME_ID, ...(Array.isArray(profile.ownedFrames) ? profile.ownedFrames : [])])]
            .filter(isPlayerFrame);
        const selectedFrame = ownedFrames.includes(profile.selectedFrame) ? profile.selectedFrame : DEFAULT_FRAME_ID;
        const metadata = user.user_metadata || {};
        return {
            userId,
            email: String(user.email || profile.email || ""),
            displayName: String(metadata.full_name || metadata.name || profile.displayName || "Игрок").slice(0, 80),
            pictureUrl: String(metadata.avatar_url || metadata.picture || profile.pictureUrl || "").slice(0, 600),
            ownedFrames,
            selectedFrame,
            freeCaseOpened: Boolean(profile.freeCaseOpened),
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
        if (!response.ok) throw new Error(`Supabase profiles вернул ${response.status}.`);
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
        if (!response.ok) throw new Error(`Supabase profiles вернул ${response.status}.`);
    }

    async initialize() {
        const local = this.loadLocal();
        let remote = {};
        if (this.usesSupabase) {
            try {
                remote = await this.readRemote();
            } catch (error) {
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

    async persist() {
        this.saveLocal();
        if (!this.usesSupabase) return;
        this.persistQueue = this.persistQueue.then(() => this.writeRemote()).catch((error) => {
            this.logger.warn("Профили сохранены локально, но не отправлены в Supabase.", error.message);
        });
        await this.persistQueue;
    }

    async ensure(user) {
        if (!user?.id) throw new Error("У аккаунта отсутствует ID.");
        const previous = this.profiles[user.id] || {};
        const profile = this.normalizeProfile(previous, user);
        this.profiles[user.id] = profile;
        await this.persist();
        return clone(profile);
    }

    async openFreeCase(userId, randomValue = Math.random()) {
        const id = String(userId || "");
        const profile = this.profiles[id];
        if (!profile) throw new Error("Профиль не найден.");
        if (profile.freeCaseOpened) return { opened: false, profile: clone(profile), frame: null };
        const frame = pickCaseFrame(randomValue);
        profile.freeCaseOpened = true;
        profile.ownedFrames = [...new Set([...(profile.ownedFrames || []), frame.id])];
        profile.selectedFrame = frame.id;
        profile.updatedAt = new Date().toISOString();
        await this.persist();
        return { opened: true, profile: clone(profile), frame: clone(frame) };
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
