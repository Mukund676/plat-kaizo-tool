/**
 * kaizoInjector.ts
 *
 * Reads kaizo_data.json and programmatically overrides the Gen 4 (DPP)
 * SPECIES and MOVES objects within @smogon/calc with Platinum Kaizo stat
 * buffs / nerfs so that all damage calculations reflect the ROM hack.
 *
 * Call `injectKaizoData()` once at application startup before any calc.
 */

import { SPECIES, MOVES } from '@smogon/calc';
import kaizoRaw from '../../../data/kaizo_data.json';

// Gen 4 index inside the SPECIES / MOVES arrays
const GEN4_IDX = 4;

type TypeName = string;
type MoveCategory = 'Physical' | 'Special' | 'Status';

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

  const gen4Species = (SPECIES as unknown as Array<Record<string, {
    bs?: Record<string, number>;
    types?: [TypeName] | [TypeName, TypeName];
    abilities?: Record<string, string>;
  }>>)[GEN4_IDX];

  const gen4Moves = (MOVES as unknown as Array<Record<string, {
    bp?: number;
    type?: TypeName;
    category?: MoveCategory;
  }>>)[GEN4_IDX];

  // --- Inject Pokémon stat/type overrides ---
  for (const [rawName, data] of Object.entries(kaizoData.pokemon)) {
    const calcName = toCalcName(rawName);

    if (!gen4Species[calcName]) {
      gen4Species[calcName] = {};
    }

    const entry = gen4Species[calcName];

    entry.bs = {
      hp: data.hp,
      at: data.attack,
      df: data.defense,
      sa: data.sp_atk,
      sd: data.sp_def,
      sp: data.speed,
    };

    const t1 = data.type1;
    if (data.type2 && data.type2 !== data.type1) {
      entry.types = [t1, data.type2];
    } else {
      entry.types = [t1];
    }

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
      entry.type = data.type;
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

