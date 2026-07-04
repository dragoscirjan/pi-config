import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { Taxonomy, RecommendConfig } from "./types";

export const LANGUAGE_HINTS: Record<string, { aliases: string[]; rarity: number }> = {
	javascript: { aliases: ["javascript", "js", "node", "nodejs"], rarity: 0.1 },
	typescript: { aliases: ["typescript", "ts"], rarity: 0.2 },
	python: { aliases: ["python", "py"], rarity: 0.1 },
	java: { aliases: ["java", "spring", "springboot", "jdk"], rarity: 0.2 },
	go: { aliases: ["go", "golang"], rarity: 0.25 },
	rust: { aliases: ["rust"], rarity: 0.45 },
	csharp: { aliases: ["c#", "csharp", ".net", "dotnet"], rarity: 0.25 },
	php: { aliases: ["php", "laravel", "symfony"], rarity: 0.25 },
	elixir: { aliases: ["elixir", "elyxir", "phoenix", "beam"], rarity: 0.7 },
	scala: { aliases: ["scala", "akka"], rarity: 0.7 },
	haskell: { aliases: ["haskell"], rarity: 0.8 },
	gdscript: { aliases: ["godot", "gdscript"], rarity: 0.55 },
};

export const DEFAULT_CONFIG: RecommendConfig = {
	version: "1.0.0",
	lastUpdated: "",
	aliases: {
		elyxir: ["elixir"],
		authn: ["authentication"],
		authz: ["authorization"],
		arround: ["around"],
		jscript: ["javascript"],
		highlevel: ["high level"],
		hld: ["high level design"],
		quick_sort: ["quicksort"],
	},
	skillWeights: {
		algorithms: { intel: 0.4, speed: 0.3, price: 0.05, context: 0.15 },
		system_design: { intel: 0.5, speed: 0.05, price: 0.0, context: 0.45 },
		security_auth: { intel: 0.45, speed: 0.05, price: 0.0, context: 0.4 },
		cloud_aws: { intel: 0.35, speed: 0.05, price: 0.0, context: 0.5 },
		game_dev: { intel: 0.25, speed: 0.2, price: 0.05, context: 0.5 },
		performance: { intel: 0.15, speed: 0.6, price: 0.05, context: 0.2 },
	},
	liveTaxonomy: {
		enabledSources: ["all"],
		maxTermsPerSource: 180,
		requestTimeoutMs: 4500,
		externalCategoryWeight: 0.2,
		sourceWeights: {
			stack_overflow: 1,
			stackexchange_network: 0.9,
			github_topics: 0.95,
			github_trending: 0.9,
			reddit: 0.7,
			hackernews: 0.85,
			lobsters: 0.75,
			npm: 0.8,
			pypi: 0.8,
			crates: 0.8,
			maven: 0.75,
			awesome_lists: 0.7,
			arxiv: 0.8,
			cloud_changelogs: 0.9,
			cncf_landscape: 0.85,
			job_boards: 0.6,
			google_trends: 0.65,
			gdelt: 0.6,
		},
	},
	router: {
		autoMode: "off",
		learnEnabled: true,
		minMarginForAutoPick: 6,
		askOutcomeFeedback: false,
		learning: {
			maxAlpha: 0.45,
			alphaWarmupSamples: 200,
			pairwiseStep: 1,
		},
	},
	defaults: {
		minIntelForComplexCheap: 72,
		cheapWeightCap: 1.9,
		freeModelBonusCap: 1.08,
		tieJitterMax: 0.35,
		intentSpread: 1.35,
		externalSignalInferenceWeight: 0.25,
		capabilityDeltaGuard: 0.12,
		capabilityDeltaPenalty: 0.2,
		capabilityDeltaMinComplexity: 55,
	},
};

export const DEFAULT_TAXONOMY: Taxonomy = {
	version: "2.0.0",
	lastUpdated: "",
	categories: {
		algorithms_data_structures: {
			weight: 1.15,
			concepts: {
				sorting: ["quicksort", "mergesort", "heapsort", "radix sort", "topological sort"],
				graph: ["dijkstra", "a*", "toposort", "mst", "floyd-warshall"],
				trees: ["segment tree", "fenwick", "hld", "heavy light decomposition", "trie", "suffix tree"],
			},
		},
		architecture_design: {
			weight: 1.2,
			concepts: {
				design: ["hld", "high level design", "architecture", "tradeoff", "scalability", "distributed"],
				patterns: ["ddd", "cqrs", "event sourcing", "saga", "clean architecture", "hexagonal"],
			},
		},
		auth_identity_security: {
			weight: 1.2,
			concepts: {
				auth: ["authentication", "authorization", "rbac", "abac", "oauth2", "oidc", "jwt", "mfa"],
				platforms: ["aws cognito", "cognito", "auth0", "keycloak", "iam"],
				appsec: ["xss", "csrf", "ssrf", "sqli", "owasp", "threat model"],
			},
		},
		cloud_infrastructure: {
			weight: 1.05,
			concepts: {
				aws: ["aws", "lambda", "dynamodb", "s3", "cloudfront", "eventbridge", "eks", "rds"],
				devops: ["kubernetes", "docker", "terraform", "pulumi", "github actions", "ci/cd"],
			},
		},
		languages_frameworks: {
			weight: 1,
			concepts: {
				languages: ["javascript", "typescript", "python", "java", "go", "rust", "elixir", "scala", "haskell", "c#", "php"],
				frameworks: ["react", "vue", "angular", "fastapi", "spring", "phoenix", "laravel"],
			},
		},
		game_development: {
			weight: 1.1,
			concepts: {
				engines: ["godot", "gdscript", "unity", "unreal"],
				design: ["card game", "turn based", "state machine", "game loop", "multiplayer"],
			},
		},
	},
};

export class TaxonomyManager {
	private taxonomyPath = join(getAgentDir(), "model-recommend-taxonomy.json");
	private configPath = join(getAgentDir(), "model-recommend-config.json");

	public getTaxonomy(): Taxonomy {
		if (existsSync(this.taxonomyPath)) {
			try { return JSON.parse(readFileSync(this.taxonomyPath, "utf-8")); }
			catch { return DEFAULT_TAXONOMY; }
		}
		return DEFAULT_TAXONOMY;
	}

	public getConfig(): RecommendConfig {
		if (existsSync(this.configPath)) {
			try { return JSON.parse(readFileSync(this.configPath, "utf-8")); }
			catch { return DEFAULT_CONFIG; }
		}
		return DEFAULT_CONFIG;
	}

	public saveTaxonomy(taxonomy: Taxonomy) {
		taxonomy.lastUpdated = new Date().toISOString();
		writeFileSync(this.taxonomyPath, JSON.stringify(taxonomy, null, 2));
	}

	public saveConfig(config: RecommendConfig) {
		config.lastUpdated = new Date().toISOString();
		writeFileSync(this.configPath, JSON.stringify(config, null, 2));
	}
}
