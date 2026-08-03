"use strict";

const fs = require("fs");
const path = require("path");

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class GameHistoryStore {
    constructor({ filePath, supabaseUrl = "", supabaseKey = "", logger = console }) {
        this.filePath = filePath;
        this.supabaseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
        this.supabaseKey = String(supabaseKey || "");
        this.logger = logger;
        this.records = [];
        this.remoteBackend = null;
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

    loadLocal() {
        try {
            if (!fs.existsSync(this.filePath)) return [];
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            this.logger.warn("Не удалось прочитать локальную историю игр.", error.message);
            return [];
        }
    }

    saveLocal() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, `${JSON.stringify(this.records, null, 2)}\n`, "utf8");
    }

    async readHistoryTable() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_game_history?select=payload&order=finished_at.desc`, {
            headers: this.headers()
        });
        if (!response.ok) throw new Error(`Supabase history вернул ${response.status}.`);
        const rows = await response.json();
        return rows.map((row) => row?.payload).filter(Boolean);
    }

    async readConfigFallback() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_config?select=config&id=eq.2`, {
            headers: this.headers()
        });
        if (!response.ok) throw new Error(`Supabase config fallback вернул ${response.status}.`);
        const rows = await response.json();
        const stored = rows[0]?.config;
        if (Array.isArray(stored)) return stored;
        return Array.isArray(stored?.games) ? stored.games : [];
    }

    async writeConfigFallback() {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_config?on_conflict=id`, {
            method: "POST",
            headers: this.headers({
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates,return=minimal"
            }),
            body: JSON.stringify({
                id: 2,
                config: { version: 1, games: this.records },
                updated_at: new Date().toISOString()
            })
        });
        if (!response.ok) throw new Error(`Supabase config fallback вернул ${response.status}.`);
    }

    async readRemote() {
        try {
            const records = await this.readHistoryTable();
            this.remoteBackend = "history-table";
            return records;
        } catch (historyError) {
            const records = await this.readConfigFallback();
            this.remoteBackend = "config-row";
            this.logger.warn("Таблица истории недоступна, архив хранится в bunker_config.", historyError.message);
            return records;
        }
    }

    async appendToHistoryTable(gameId, record, snapshot) {
        const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_game_history?on_conflict=id`, {
            method: "POST",
            headers: this.headers({
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates,return=minimal"
            }),
            body: JSON.stringify({
                id: gameId,
                room_code: String(record.roomCode || ""),
                finished_at: new Date(Number(record.finishedAt) || Date.now()).toISOString(),
                payload: snapshot
            })
        });
        if (!response.ok) throw new Error(`Supabase history вернул ${response.status}.`);
    }

    async persistRemoteAppend(gameId, record, snapshot) {
        try {
            await this.appendToHistoryTable(gameId, record, snapshot);
            this.remoteBackend = "history-table";
        } catch (historyError) {
            await this.writeConfigFallback();
            this.remoteBackend = "config-row";
            this.logger.warn("Таблица истории недоступна, архив сохранён в bunker_config.", historyError.message);
        }
    }

    async initialize() {
        const local = this.loadLocal();
        let remote = [];
        if (this.usesSupabase) {
            try {
                remote = await this.readRemote();
            } catch (error) {
                this.logger.warn("История игр Supabase недоступна, используется локальный fallback.", error.message);
            }
        }
        const merged = new Map();
        [...local, ...remote].forEach((record) => {
            if (record?.gameId) merged.set(String(record.gameId), record);
        });
        this.records = [...merged.values()].sort((first, second) => Number(second.finishedAt || 0) - Number(first.finishedAt || 0));
        this.saveLocal();
        return this.list();
    }

    list({ roomCode = "", player = "" } = {}) {
        const codeNeedle = String(roomCode || "").trim().toLocaleLowerCase("ru");
        const playerNeedle = String(player || "").trim().toLocaleLowerCase("ru");
        return clone(this.records.filter((record) => {
            if (codeNeedle && !String(record.roomCode || "").toLocaleLowerCase("ru").includes(codeNeedle)) return false;
            if (playerNeedle && !(record.participants || []).some((participant) => String(participant.nickname || participant).toLocaleLowerCase("ru").includes(playerNeedle))) return false;
            return true;
        }));
    }

    get(gameId) {
        const record = this.records.find((candidate) => String(candidate.gameId) === String(gameId));
        return record ? clone(record) : null;
    }

    maxNumericId() {
        return this.records.reduce((maximum, record) => Math.max(maximum, Number.parseInt(record.gameId, 10) || 0), 0);
    }

    async append(record) {
        if (!record?.gameId) throw new Error("У лога игры отсутствует ID.");
        const gameId = String(record.gameId);
        if (this.records.some((candidate) => String(candidate.gameId) === gameId)) return this.get(gameId);
        const snapshot = clone(record);
        this.records.unshift(snapshot);
        this.saveLocal();
        if (this.usesSupabase) {
            try {
                await this.persistRemoteAppend(gameId, record, snapshot);
            } catch (error) {
                this.logger.warn("Лог игры сохранён локально, но не отправлен в Supabase.", error.message);
            }
        }
        return clone(snapshot);
    }

    async delete(gameId) {
        const id = String(gameId || "");
        const before = this.records.length;
        this.records = this.records.filter((record) => String(record.gameId) !== id);
        if (this.records.length === before) return false;
        this.saveLocal();
        if (this.usesSupabase) {
            try {
                if (this.remoteBackend === "config-row") {
                    await this.writeConfigFallback();
                } else {
                    const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_game_history?id=eq.${encodeURIComponent(id)}`, {
                        method: "DELETE",
                        headers: this.headers()
                    });
                    if (!response.ok) throw new Error(`Supabase history вернул ${response.status}.`);
                }
            } catch (error) {
                this.logger.warn("Локальный лог удалён, но Supabase удалить не удалось.", error.message);
            }
        }
        return true;
    }

    async clear() {
        this.records = [];
        this.saveLocal();
        if (this.usesSupabase) {
            if (this.remoteBackend === "config-row") {
                await this.writeConfigFallback();
                return true;
            }
            const response = await fetch(`${this.supabaseUrl}/rest/v1/bunker_game_history?id=not.is.null`, {
                method: "DELETE",
                headers: this.headers()
            });
            if (!response.ok) throw new Error(`Supabase history вернул ${response.status}.`);
        }
        return true;
    }
}

module.exports = { GameHistoryStore };
