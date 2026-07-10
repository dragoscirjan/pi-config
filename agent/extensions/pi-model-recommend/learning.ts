import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { clamp, hashString } from "./profiles";
import type { ScoredModel, Intent, RecommendConfig } from "./types";

// ─── Migration System ────────────────────────────────────────────────────────

let routerDb: DatabaseSync | undefined;

const ROUTER_DB_SCHEMA_VERSION = 4;

type RouterMigration = {
	version: number;
	name: string;
	up: (db: DatabaseSync) => void;
};

const ROUTER_MIGRATIONS: RouterMigration[] = [
	{
		version: 1,
		name: "initial-router-schema",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS router_settings (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS router_weights (
					scope TEXT NOT NULL,
					key TEXT NOT NULL,
					weight REAL NOT NULL DEFAULT 0,
					updates INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY(scope, key)
				);
				CREATE TABLE IF NOT EXISTS router_samples (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					ts INTEGER NOT NULL,
					mode TEXT NOT NULL,
					prompt_hash TEXT NOT NULL,
					selected_exact TEXT NOT NULL,
					selected_provider_family TEXT NOT NULL,
					selected_family TEXT NOT NULL,
					candidate_count INTEGER NOT NULL,
					margin REAL NOT NULL DEFAULT 0,
					features_json TEXT NOT NULL
				);
			`);
		},
	},
	{
		version: 2,
		name: "performance-indexes",
		up: (db) => {
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_router_samples_ts ON router_samples(ts);
				CREATE INDEX IF NOT EXISTS idx_router_samples_family ON router_samples(selected_family);
				CREATE INDEX IF NOT EXISTS idx_router_weights_scope_key ON router_weights(scope, key);
			`);
		},
	},
	{
		version: 3,
		name: "taxonomy-tables",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS router_taxonomy_categories (
					name TEXT PRIMARY KEY,
					weight REAL NOT NULL
				);
				CREATE TABLE IF NOT EXISTS router_taxonomy_terms (
					category_name TEXT NOT NULL,
					concept_name TEXT NOT NULL,
					term TEXT NOT NULL,
					PRIMARY KEY(category_name, concept_name, term),
					FOREIGN KEY(category_name) REFERENCES router_taxonomy_categories(name) ON DELETE CASCADE
				);
				CREATE INDEX IF NOT EXISTS idx_router_taxonomy_terms_category ON router_taxonomy_terms(category_name);
			`);
		},
	},
	{
		version: 4,
		name: "benchmarks-and-key-normalization",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS model_benchmarks (
					model TEXT PRIMARY KEY,
					pass_rate_edit REAL,
					pass_rate_refactor REAL,
					updated_at INTEGER
				);
			`);
			// Normalize legacy exact keys from "/" separator to "::" separator
			db.exec(`
				UPDATE router_weights
				SET key = REPLACE(key, '/', '::')
				WHERE scope = 'exact' AND key LIKE '%/%';
			`);
		},
	},
];

// ─── Migration Infrastructure ────────────────────────────────────────────────

export function getRouterDbPath(): string {
	return join(getAgentDir(), "model-recommend.db");
}

function ensureRouterMigrationsTable(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS router_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		);
	`);
}

function getAppliedRouterSchemaVersion(db: DatabaseSync): number {
	const row = db.prepare("SELECT MAX(version) AS v FROM router_migrations").get() as { v?: number } | undefined;
	return Number(row?.v ?? 0);
}

function applyRouterMigrations(db: DatabaseSync): void {
	ensureRouterMigrationsTable(db);
	let current = getAppliedRouterSchemaVersion(db);
	const pending = ROUTER_MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
	if (pending.length === 0) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const migration of pending) {
			migration.up(db);
			db.prepare("INSERT INTO router_migrations(version, name, applied_at) VALUES(?, ?, ?)").run(
				migration.version,
				migration.name,
				Date.now(),
			);
			current = migration.version;
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function normalizeLegacyRouterSchema(db: DatabaseSync): void {
	const hasTable = (name: string): boolean => {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name?: string } | undefined;
		return Boolean(row?.name);
	};

	if (hasTable("router_weights")) {
		const cols = db.prepare("PRAGMA table_info(router_weights)").all() as Array<{ name: string }>;
		const names = new Set(cols.map((c) => String(c.name)));
		if (names.has("type") && !names.has("scope")) {
			try {
				db.exec("ALTER TABLE router_weights RENAME COLUMN type TO scope");
			} catch {
				db.exec("ALTER TABLE router_weights ADD COLUMN scope TEXT");
				db.exec("UPDATE router_weights SET scope = type WHERE scope IS NULL OR scope = ''");
			}
		}
		if (!names.has("updates")) {
			try {
				db.exec("ALTER TABLE router_weights ADD COLUMN updates INTEGER NOT NULL DEFAULT 0");
			} catch {
				// ignore if already added by a concurrent init
			}
		}
	}

	// Early experimental schema used router_kv; migrate values into router_settings.
	if (hasTable("router_kv")) {
		db.exec("CREATE TABLE IF NOT EXISTS router_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		db.exec("INSERT OR REPLACE INTO router_settings(key, value) SELECT key, value FROM router_kv");
	}
}

// ─── Database Singleton ──────────────────────────────────────────────────────

export function getRouterDb(): DatabaseSync {
	if (routerDb) return routerDb;
	const path = getRouterDbPath();
	const db = new DatabaseSync(path);
	normalizeLegacyRouterSchema(db);
	applyRouterMigrations(db);
	routerDb = db;
	return db;
}

export function getRouterSchemaVersion(): number {
	return getAppliedRouterSchemaVersion(getRouterDb());
}

// ─── Settings Helpers ────────────────────────────────────────────────────────

export function dbGetNumber(key: string, fallback = 0): number {
	const row = getRouterDb().prepare("SELECT value FROM router_settings WHERE key = ?").get(key) as { value?: string } | undefined;
	if (!row?.value) return fallback;
	const n = Number(row.value);
	return Number.isFinite(n) ? n : fallback;
}

export function dbSetNumber(key: string, value: number): void {
	getRouterDb().prepare("INSERT OR REPLACE INTO router_settings(key, value) VALUES(?, ?)").run(key, String(value));
}

// ─── Weight Operations ───────────────────────────────────────────────────────

export function readWeight(scope: string, key: string): { weight: number; updates: number } {
	try {
		const row = getRouterDb()
			.prepare("SELECT weight, updates FROM router_weights WHERE scope = ? AND key = ?")
			.get(scope, key) as { weight?: number; updates?: number } | undefined;
		return { weight: Number(row?.weight ?? 0), updates: Number(row?.updates ?? 0) };
	} catch {
		return { weight: 0, updates: 0 };
	}
}

/** Backward-compatible weight read (returns weight only). */
export function getWeight(scope: string, key: string): number {
	return readWeight(scope, key).weight;
}

export function addWeight(scope: string, key: string, delta: number): void {
	const db = getRouterDb();
	const row = db.prepare("SELECT weight, updates FROM router_weights WHERE scope = ? AND key = ?").get(scope, key) as
		| { weight?: number; updates?: number }
		| undefined;
	if (row) {
		db.prepare("UPDATE router_weights SET weight = ?, updates = ? WHERE scope = ? AND key = ?").run(
			Number(row.weight ?? 0) + delta,
			Number(row.updates ?? 0) + 1,
			scope,
			key,
		);
		return;
	}
	db.prepare("INSERT INTO router_weights(scope, key, weight, updates) VALUES(?, ?, ?, 1)").run(scope, key, delta);
}

// ─── Canonical Key Functions ─────────────────────────────────────────────────

export function canonicalFamily(modelId: string): string {
	let v = modelId.toLowerCase().trim();
	v = v.replace(/:[a-z0-9_-]+$/g, "");
	v = v.replace(/\/(?:[^/]+)$/g, (m) => m.replace("/", ""));
	v = v.replace(/[-_](20\d{2}(?:[-_]?\d{2}){0,2}|\d{6,8})$/g, "");
	v = v.replace(/[-_]?v\d+(?:\.\d+)?$/g, "");
	v = v.replace(/\s+/g, "-");
	return v;
}

export function exactKey(model: { provider: string; model: string }): string {
	return `${model.provider.toLowerCase()}::${model.model.toLowerCase().replace(/:[a-z0-9_-]+$/g, "")}`;
}

export function familyKey(model: { model: string }): string {
	return canonicalFamily(model.model);
}

export function providerFamilyKey(model: { provider: string; model: string }): string {
	return `${model.provider.toLowerCase()}::${familyKey(model)}`;
}

// ─── Training ────────────────────────────────────────────────────────────────

export function persistTrainingSample(
	task: string,
	mode: string,
	intent: Intent,
	selected: ScoredModel,
	offered: ScoredModel[],
	margin: number,
): void {
	const ts = Date.now();
	const promptHash = String(hashString(task));
	getRouterDb()
		.prepare(
			"INSERT INTO router_samples(ts, mode, prompt_hash, selected_exact, selected_provider_family, selected_family, candidate_count, margin, features_json) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			ts,
			mode,
			promptHash,
			exactKey(selected),
			providerFamilyKey(selected),
			familyKey(selected),
			offered.length,
			margin,
			JSON.stringify({
				complexity: intent.complexity,
				domains: Array.from(intent.domains),
				languages: Array.from(intent.languages),
				categories: Array.from(intent.matchedTaxonomyCategories),
				needs: intent.capabilityNeeds,
			}),
		);
	dbSetNumber("sample_count", routerSampleCount() + 1);
}

export function trainPairwiseSelection(
	config: RecommendConfig,
	selected: ScoredModel,
	offered: ScoredModel[],
): void {
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

export function getAffinity(m: { provider: string; model: string }): number {
	return (
		readWeight("exact", exactKey(m)).weight * 1.0 +
		readWeight("provider_family", providerFamilyKey(m)).weight * 1.5 +
		readWeight("family", familyKey(m)).weight * 0.8
	);
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

function routerSampleCount(): number {
	const cached = dbGetNumber("sample_count", -1);
	if (cached >= 0) return cached;
	const row = getRouterDb().prepare("SELECT COUNT(*) as c FROM router_samples").get() as { c?: number } | undefined;
	const count = Number(row?.c ?? 0);
	dbSetNumber("sample_count", count);
	return count;
}

export function applyLearnedAdjustments(scored: ScoredModel[], config: RecommendConfig): ScoredModel[] {
	const samples = routerSampleCount();
	const warmup = Math.max(1, Number(config.router.learning.alphaWarmupSamples ?? 200));
	const maxAlpha = clamp(Number(config.router.learning.maxAlpha ?? 0.45), 0, 0.9);
	const alpha = clamp((samples / warmup) * maxAlpha, 0, maxAlpha);
	for (const m of scored) {
		const fam = readWeight("family", familyKey(m));
		const pf = readWeight("provider_family", providerFamilyKey(m));
		const ex = readWeight("exact", exactKey(m));
		const learned = fam.weight * 0.5 + pf.weight * 0.3 + ex.weight * 0.2;
		m.score = clamp(m.score + learned * alpha, 0, 100);
		if (Math.abs(learned) > 0.001) m.breakdown.reasons.push(`learned-bias=${(learned * alpha).toFixed(2)} alpha=${alpha.toFixed(2)}`);
		m.breakdown.final = m.score;
	}
	return scored;
}

export function resetLearningStore(): void {
	const db = getRouterDb();
	db.exec("DELETE FROM router_weights; DELETE FROM router_samples;");
	dbSetNumber("sample_count", 0);
}
