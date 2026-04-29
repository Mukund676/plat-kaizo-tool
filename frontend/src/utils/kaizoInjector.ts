/**
 * kaizoInjector.ts
 *
 * Reads kaizo_data.json and programmatically overrides the Gen 4 (DPP)
 * SPECIES and MOVES objects within @smogon/calc with Platinum Kaizo stat
 * buffs / nerfs so that all damage calculations reflect the ROM hack.
 *
 * Call `injectKaizoData()` once at application startup before any calc.
 */

import type { TypeName, MoveCategory } from '@smogon/calc';
// Access internal mutable arrays via require to allow mutation
// eslint-disable-next-line @typescript-eslint/no-require-imports
const speciesModule = require('@smogon/calc/dist/data/species');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const movesModule = require('@smogon/calc/dist/data/moves');

import kaizoRaw from '../../data/kaizo_data.json';

// Gen indices in the SPECIES / MOVES arrays (0-based, index 0 is empty)
// DPP = Gen 4 → index 4
const GEN4_IDX = 4;

interface PokemonEntry {
  id: number;
  hp: number;
  attack: number;
  defense: number;
  sp_atk: number;
  sp_def: number;
  speed: number;
  type1: string;
  type2: string | null;
  ability1: string | null;
  ability2: string | null;
}

interface MoveEntry {
  id: number;
  category: string;
  power: number;
  type: string;
  accuracy: number;
  pp: number;
}

interface KaizoData {
  pokemon: Record<string, PokemonEntry>;
  moves: Record<string, MoveEntry>;
}

const kaizoData = kaizoRaw as KaizoData;

/**
 * Normalise a Pokémon name so it matches @smogon/calc's key format.
 * e.g. "BULBASAUR" → "Bulbasaur", "MR. MIME" → "Mr. Mime"
 */
function toCalcName(name: string): string {
  return name
    .toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

let injected = false;

export function injectKaizoData(): void {
  if (injected) return;
  injected = true;

  const SPECIES: Record<string, unknown>[] = speciesModule.SPECIES;
  const MOVES: Record<string, unknown>[] = movesModule.MOVES;

  const gen4Species = SPECIES[GEN4_IDX] as Record<
    string,
    { bs?: Record<string, number>; types?: [TypeName] | [TypeName, TypeName]; abilities?: Record<string, string> }
  >;

  const gen4Moves = MOVES[GEN4_IDX] as Record<
    string,
    { bp?: number; type?: TypeName; category?: MoveCategory }
  >;

  // --- Inject Pokémon stat/type overrides ---
  for (const [rawName, data] of Object.entries(kaizoData.pokemon)) {
    const calcName = toCalcName(rawName);

    if (!gen4Species[calcName]) {
      gen4Species[calcName] = {};
    }

    const entry = gen4Species[calcName] as {
      bs?: Record<string, number>;
      types?: [TypeName] | [TypeName, TypeName];
      abilities?: Record<string, string>;
    };

    // Override base stats
    entry.bs = {
      hp: data.hp,
      at: data.attack,
      df: data.defense,
      sa: data.sp_atk,
      sd: data.sp_def,
      sp: data.speed,
    };

    // Override types
    const t1 = data.type1 as TypeName;
    if (data.type2 && data.type2 !== data.type1) {
      entry.types = [t1, data.type2 as TypeName];
    } else {
      entry.types = [t1];
    }

    // Override abilities
    if (data.ability1) {
      entry.abilities = { 0: data.ability1 };
    }
  }

  // --- Inject Move power/type/category overrides ---
  for (const [moveName, data] of Object.entries(kaizoData.moves)) {
    if (!gen4Moves[moveName]) {
      gen4Moves[moveName] = {};
    }

    const entry = gen4Moves[moveName];

    if (data.power > 0) {
      entry.bp = data.power;
    }
    if (data.type) {
      entry.type = data.type as TypeName;
    }
    if (data.category) {
      entry.category = data.category as MoveCategory;
    }
  }

  console.log(
    `[kaizoInjector] Injected ${Object.keys(kaizoData.pokemon).length} Pokémon` +
      ` and ${Object.keys(kaizoData.moves).length} moves into @smogon/calc Gen 4 data.`
  );
}
