import type { ModelDefinition, ModelCapabilities, ModelDefaults, KimiServerModelInfo } from './types';
import { applyServerModels } from './models-client';
import { MODELS } from './models';

// ═══════════════════════════════════════════════════════════════════════
// ModelRegistry — owns the effective model registry
//
// Replaces the module-level `let effectiveModels` mutable global with a
// class that can be instantiated, passed around, and tested in isolation.
// Created once in activate() and shared via dependency injection.
// ═══════════════════════════════════════════════════════════════════════

export class ModelRegistry {
	private models: ModelDefinition[];

	constructor(baseModels?: readonly ModelDefinition[]) {
		this.models = baseModels ? [...baseModels] : [...MODELS];
	}

	// ── Server catalog ──────────────────────────────────────────────

	/**
	 * Layers the server-resolved catalog on top of the hard-coded registry.
	 * Pass `undefined` to restore the hard-coded defaults.
	 */
	applyServerCatalog(serverModels: readonly KimiServerModelInfo[] | undefined): void {
		this.models =
			serverModels && serverModels.length > 0
				? applyServerModels(MODELS, serverModels)
				: [...MODELS];
	}

	// ── Queries ─────────────────────────────────────────────────────

	getAll(): readonly ModelDefinition[] {
		return this.models;
	}

	findById(id: string): ModelDefinition | undefined {
		return this.models.find((m) => m.id === id);
	}

	getCapabilities(id: string): ModelCapabilities | undefined {
		return this.findById(id)?.capabilities;
	}

	getDefaults(id: string): ModelDefaults | undefined {
		return this.findById(id)?.defaults;
	}

	getMaxOutputTokens(id: string): number {
		return this.findById(id)?.maxOutputTokens ?? 32768;
	}
}
