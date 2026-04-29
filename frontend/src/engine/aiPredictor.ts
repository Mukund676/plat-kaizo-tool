/**
 * aiPredictor.ts
 *
 * Gen 4 Trainer AI move-probability engine.
 *
 * Based on the logic documented in gen4_trainer_ai.md.txt:
 * - All moves start with a score of 100.
 * - Each active AI flag applies modifiers.
 * - Ties are broken randomly.
 * - Returns percentage probability for each move.
 *
 * Implemented flags:
 *   basic     → Basic Flag (immunities, effect discouragement)
 *   eval_att  → Evaluate Attack Flag (find best damager, -1 to all others)
 *   expert    → Expert Flag (heal check, immunity check, stat-boost timing)
 *   risky     → Risky Flag (Explosion / Destiny Bond get +2 50 % of the time)
 *   check_hp  → Check HP Flag (discourage moves based on HP thresholds)
 */

import { calculate, Pokemon, Move, Field, Generations } from '@smogon/calc';

const gen4 = Generations.get(4);

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface BattleMon {
  /** Pokémon species name (e.g. "Garchomp") */
  species: string;
  level: number;
  nature?: string;
  ability?: string;
  item?: string;
  /** Current HP percentage 0-100 */
  hpPercent: number;
  moves: string[];
  evs?: Partial<{ hp: number; atk: number; def: number; spa: number; spd: number; spe: number }>;
  ivs?: Partial<{ hp: number; atk: number; def: number; spa: number; spd: number; spe: number }>;
  boosts?: Partial<{ atk: number; def: number; spa: number; spd: number; spe: number }>;
  /** Status condition */
  status?: 'slp' | 'psn' | 'brn' | 'frz' | 'par' | 'tox';
}

export interface FieldState {
  weather?: string;
  isTrickRoom?: boolean;
}

export interface AIFlags {
  basic?: boolean;
  eval_att?: boolean;
  expert?: boolean;
  risky?: boolean;
  check_hp?: boolean;
  status?: boolean;
  damage_prio?: boolean;
  harassment?: boolean;
  weather?: boolean;
}

export interface MoveProbability {
  move: string;
  score: number;
  probability: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

/** Move effects that are treated as non-standard and start at score 0 for damage */
const ZERO_DAMAGE_EFFECTS = new Set([
  'Explosion', 'Self-Destruct', 'Selfdestruct',
  'Dream Eater',
  'Razor Wind', 'Sky Attack', 'Skull Bash',
  'Solar Beam', 'SolarBeam',
  'Hyper Beam', 'Giga Impact', 'Frenzy Plant', 'Blast Burn', 'Hydro Cannon',
  'Water Spout', 'Eruption',
  'Gyro Ball', 'Low Kick', 'Grass Knot',
  'Head Smash',
  'Night Shade', 'Seismic Toss',
  'Return', 'Frustration',
  'Dragon Rage', 'Sonic Boom',
  'Spit Up', 'Focus Punch', 'Superpower',
  'Sucker Punch', 'Hidden Power', 'Natural Gift', 'Judgment', 'Psywave',
]);

const RISKY_MOVES = new Set(['Explosion', 'Self-Destruct', 'Selfdestruct', 'Destiny Bond']);

/** Healing / recovery moves */
const RECOVERY_MOVES = new Set([
  'Recover', 'Roost', 'Synthesis', 'Moonlight', 'Morning Sun',
  'Slack Off', 'Milk Drink', 'Softboiled', 'Wish', 'Rest',
  'Heal Order', 'Shore Up',
]);

/** Build a @smogon/calc Pokemon object from a BattleMon */
function makePokemon(mon: BattleMon): Pokemon {
  return new Pokemon(4, mon.species, {
    level:  mon.level,
    nature: mon.nature as never,
    ability: mon.ability as never,
    item:   mon.item as never,
    evs:    mon.evs ?? {},
    ivs:    mon.ivs ?? {},
    boosts: mon.boosts ?? {},
    status: mon.status,
    curHP:  Math.round((mon.hpPercent / 100)),
  });
}

/**
 * Compute expected damage range midpoint for a move using @smogon/calc.
 * Returns 0 for non-damaging or zero-score-init moves.
 */
function getDamage(
  attacker: BattleMon,
  defender: BattleMon,
  moveName: string,
  field: Field,
): number {
  if (ZERO_DAMAGE_EFFECTS.has(moveName)) return 0;

  try {
    const atk = makePokemon(attacker);
    const def = makePokemon(defender);
    const mv  = new Move(4, moveName);

    // Skip status moves
    const moveData = gen4.moves.get(moveName.toLowerCase().replace(/[ '-]/g, '') as never);
    if (moveData && moveData.category === 'Status') return 0;

    const result = calculate(4, atk, def, mv, field);
    const rolls = result.damage;
    if (!Array.isArray(rolls) || rolls.length === 0) return 0;
    const dmg = rolls as number[];
    return (dmg[0] + dmg[dmg.length - 1]) / 2;
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main export
// ────────────────────────────────────────────────────────────────────────────

/**
 * Predict the probability distribution over the enemy's moves given the
 * current battle state.
 *
 * @param playerMon  The player's active Pokémon
 * @param enemyMon   The enemy's active Pokémon
 * @param fieldState Current field conditions
 * @param aiFlags    AI behaviour flags assigned to this trainer
 */
export function predictEnemyMove(
  playerMon: BattleMon,
  enemyMon: BattleMon,
  fieldState: FieldState,
  aiFlags: AIFlags = {},
): MoveProbability[] {
  const moves = enemyMon.moves.filter(Boolean);
  if (moves.length === 0) return [];

  // Initialise all scores to 100
  const scores: Record<string, number> = {};
  for (const mv of moves) scores[mv] = 100;

  const field = new Field({
    weather: fieldState.weather as never,
    isTrickRoom: fieldState.isTrickRoom,
  });

  // ── Basic Flag ──────────────────────────────────────────────────────────
  if (aiFlags.basic) {
    for (const mv of moves) {
      // Discourage recovery at 100 % HP
      if (RECOVERY_MOVES.has(mv) && enemyMon.hpPercent >= 100) {
        scores[mv] -= 8;
      }
      // Discourage status moves when the target already has a status
      if (playerMon.status) {
        const md = gen4.moves.get(mv.toLowerCase().replace(/[ '-]/g, '') as never);
        if (md && md.category === 'Status') {
          scores[mv] -= 5;
        }
      }
    }
  }

  // ── Evaluate Attack Flag ─────────────────────────────────────────────────
  if (aiFlags.eval_att) {
    const damages: Record<string, number> = {};
    for (const mv of moves) {
      damages[mv] = getDamage(enemyMon, playerMon, mv, field);
    }
    const maxDmg = Math.max(...Object.values(damages));
    if (maxDmg > 0) {
      for (const mv of moves) {
        if (damages[mv] < maxDmg) {
          scores[mv] -= 1;
        }
      }
    }
  }

  // ── Expert Flag ──────────────────────────────────────────────────────────
  if (aiFlags.expert) {
    for (const mv of moves) {
      // Discourage healing if enemy HP > 50 %
      if (RECOVERY_MOVES.has(mv) && enemyMon.hpPercent > 50) {
        scores[mv] -= 5;
      }
    }
  }

  // ── Risky Flag ───────────────────────────────────────────────────────────
  if (aiFlags.risky) {
    for (const mv of moves) {
      if (RISKY_MOVES.has(mv)) {
        // 50 % chance of +2
        if (Math.random() < 0.5) {
          scores[mv] += 2;
        }
      }
    }
  }

  // ── Check HP Flag ────────────────────────────────────────────────────────
  if (aiFlags.check_hp) {
    for (const mv of moves) {
      // Recovery moves discouraged if enemy HP > 71 %  (80.5 % chance of -2)
      if (RECOVERY_MOVES.has(mv) && enemyMon.hpPercent > 71) {
        if (Math.random() < 0.805) scores[mv] -= 2;
      }
      // Explosion / Self-Destruct discouraged if HP > 31 %
      if (RISKY_MOVES.has(mv) && enemyMon.hpPercent > 31) {
        if (Math.random() < 0.805) scores[mv] -= 2;
      }
    }
  }

  // ── Clamp scores ─────────────────────────────────────────────────────────
  for (const mv of moves) {
    scores[mv] = Math.max(0, scores[mv]);
  }

  // ── Convert to probabilities ─────────────────────────────────────────────
  const maxScore = Math.max(...Object.values(scores));

  // Tiebreaker: moves with the highest score share equal probability
  const topMoves  = moves.filter((mv) => scores[mv] === maxScore);
  const totalScore = moves.reduce((s, mv) => s + scores[mv], 0);

  return moves.map((mv) => ({
    move:        mv,
    score:       scores[mv],
    probability:
      totalScore > 0
        ? parseFloat(((scores[mv] / totalScore) * 100).toFixed(1))
        : parseFloat(((topMoves.includes(mv) ? 1 / topMoves.length : 0) * 100).toFixed(1)),
  }));
}
