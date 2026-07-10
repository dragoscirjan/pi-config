import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { clamp } from "./profiles";
import type { ScoredModel, Intent, RecommendConfig } from "./types";

let routerDb: DatabaseSync | undefined;

export function getRouterDb(): DatabaseSync {
    if (routerDb) return routerDb;
    const path = join(getAgentDir(), "model-recommend.db");
    const db = new DatabaseSync(path);
    
    // Explicitly create tables if they don't exist
    db.exec(`
        CREATE TABLE IF NOT EXISTS router_weights (
            type TEXT,
            key TEXT,
            weight REAL,
            PRIMARY KEY (type, key)
        );
        CREATE TABLE IF NOT EXISTS router_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER,
            mode TEXT,
            prompt_hash TEXT,
            selected_exact TEXT,
            selected_provider_family TEXT,
            selected_family TEXT,
            candidate_count INTEGER,
            margin REAL,
            features_json TEXT
        );
        CREATE TABLE IF NOT EXISTS router_kv (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
    routerDb = db;
    return db;
}

function exactKey(m: ScoredModel): string { return `${m.provider}/${m.model}`.toLowerCase(); }
function familyKey(m: string | ScoredModel): string {
    const id = typeof m === "string" ? m : m.model;
    return id.toLowerCase().replace(/-(mini|small|large|pro|turbo|preview|latest|instruct|vision|0\d\d\d)$/, "");
}
function providerFamilyKey(m: ScoredModel): string { return `${m.provider}:${familyKey(m)}`.toLowerCase(); }

export function getWeight(type: string, key: string): number {
    try {
        const db = getRouterDb();
        const row = db.prepare("SELECT weight FROM router_weights WHERE type = ? AND key = ?").get(type, key) as { weight: number } | undefined;
        return row?.weight ?? 0;
    } catch (e) {
        // Fallback for missing table during init or other errors
        return 0;
    }
}

export function addWeight(type: string, key: string, delta: number) {
    const current = getWeight(type, key);
    getRouterDb().prepare("INSERT OR REPLACE INTO router_weights (type, key, weight) VALUES (?, ?, ?)")
        .run(type, key, clamp(current + delta, -50, 50));
}

export function persistTrainingSample(task: string, mode: string, intent: Intent, selected: ScoredModel, offered: ScoredModel[], margin: number): void {
    const ts = Date.now();
    getRouterDb().prepare(`
        INSERT INTO router_samples(ts, mode, prompt_hash, selected_exact, selected_provider_family, selected_family, candidate_count, margin, features_json)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        ts, mode, task, exactKey(selected), providerFamilyKey(selected), familyKey(selected),
        offered.length, margin, JSON.stringify(intent)
    );
}

export function trainPairwiseSelection(config: RecommendConfig, selected: ScoredModel, offered: ScoredModel[]): void {
	const step = clamp(Number(config.router.learning.pairwiseStep ?? 1), 0.05, 5);
	const negatives = offered.filter((m) => exactKey(m) !== exactKey(selected));
	if (negatives.length === 0) return;
	const negStep = step / negatives.length;
	addWeight("family", familyKey(selected), step * 0.5);
	addWeight("provider_family", providerFamilyKey(selected), step * 0.3);
	addWeight("exact", exactKey(selected), step * 0.2);
	for (const n of negatives) {
		addWeight("family", familyKey(n), -negStep * 0.5);
		addWeight("provider_family", providerFamilyKey(n), -negStep * 0.3);
		addWeight("exact", exactKey(n), -negStep * 0.2);
	}
}

export function getAffinity(m: ScoredModel): number {
    return getWeight("exact", exactKey(m)) * 1.0 + 
           getWeight("provider_family", providerFamilyKey(m)) * 1.5 + 
           getWeight("family", familyKey(m)) * 0.8;
}

export function getLearningStats() {
    try {
        const samples = getRouterDb().prepare("SELECT COUNT(*) as count FROM router_samples").get() as { count: number };
        const weights = getRouterDb().prepare("SELECT COUNT(*) as count FROM router_weights").get() as { count: number };
        return { samples: samples.count, weights: weights.count };
    } catch {
        return { samples: 0, weights: 0 };
    }
}
