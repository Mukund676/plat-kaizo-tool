/**
 * aiPredictor.ts
 *
 * Gen 4 Trainer AI move-probability engine.
 *
 * Based on comprehensive AI documentation:
 *   - gen4_trainer_ai.md.txt: Detailed flag behaviors, move-specific scoring
 *   - Gen 4 AI Mechanics Guide.txt: Switch AI logic, type matchups, damage calculations
 *
 * Implements all 12 flags:
 *   basic            → Basic Flag (discourage wasted/self-harming moves)
 *   eval_att         → Evaluate Attack Flag (prioritize raw damage)
 *   expert           → Expert Flag (conditional encouragement based on HP/speed/situation)
 *   setup_first_turn → Setup First Turn Flag (prioritize setup on turn 1)
 *   risky            → Risky Flag (50% chance of +2 for risky moves)
 *   damage_prio      → Prioritize Extremes Flag (~61% chance of +2 for zero-damage/status)
 *   baton_pass       → Baton Pass Flag (prioritize setup, Protect, Baton Pass)
 *   tag_strategy     → Tag Strategy Flag (double battle partner awareness)
 *   check_hp         → Check HP Flag (HP-based phase adjustments)
 *   weather          → Weather Flag (set weather on turn 1 if not active)
 *   harassment       → Harassment Flag (50% chance of +2 for disruptive moves)
 *   status           → Prioritize Status Flag (Kaizo extra; encourage status-inflicting)
 *
 * Uses Monte Carlo simulation (10,000 trials) for realistic stochastic move selection
 * with proper tie-breaking via random selection among equally-scored moves.
 */

import { calculate, Pokemon, Move, Field, Generations } from '@smogon/calc';

const gen4 = Generations.get(4);

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface BattleMon {
  species: string;
  level: number;
  nature?: string;
  ability?: string;
  item?: string;
  /** Current HP as a percentage 0-100 */
  hpPercent: number;
  moves: string[];
  evs?: Partial<{ hp: number; atk: number; def: number; spa: number; spd: number; spe: number }>;
  ivs?: Partial<{ hp: number; atk: number; def: number; spa: number; spd: number; spe: number }>;
  boosts?: Partial<{ atk: number; def: number; spa: number; spd: number; spe: number; acc: number; eva: number }>;
  status?: 'slp' | 'psn' | 'brn' | 'frz' | 'par' | 'tox';
  /** Computed Speed stat (used for speed comparisons) */
  speed?: number;
  /** Whether this is the trainer's last remaining Pokémon */
  isLastPokemon?: boolean;
  /** Whether a Safeguard screen is active on this Pokémon's side */
  hasSafeguard?: boolean;
  /** Types of this Pokémon, e.g. ['Fire', 'Flying'] */
  types?: string[];
  /** Last move used by this Pokémon (for Encore/Disable/counter checks) */
  lastUsedMove?: string;
  /** Current confusion status */
  isConfused?: boolean;
}

export interface FieldState {
  weather?: string;          // 'sun' | 'rain' | 'sand' | 'hail'
  isTrickRoom?: boolean;
  /** Turn number (1 = first turn of the battle) */
  turnNumber?: number;
  isDoubleBattle?: boolean;
  hasFog?: boolean;
  hasPartner?: boolean;
  partnerHpPercent?: number;
  partnerAbility?: string;
  partnerTypes?: string[];
  partnerMagnetRise?: boolean;
  partnerStatus?: string;
}

export interface AIFlags {
  basic?: boolean;            // Basic Flag (Prioritize Effectiveness)
  eval_att?: boolean;         // Evaluate Attack Flag
  expert?: boolean;           // Expert Flag
  setup_first_turn?: boolean; // Setup First Turn Flag
  risky?: boolean;            // Risky Flag (Risky Attacks)
  damage_prio?: boolean;      // Prioritize Extremes Flag (Prioritize Damage)
  baton_pass?: boolean;       // Baton Pass Flag
  tag_strategy?: boolean;     // Tag Strategy Flag (Partner)
  check_hp?: boolean;         // Check HP Flag (Prioritize Healing)
  weather?: boolean;          // Weather Flag (Utilize Weather)
  harassment?: boolean;       // Harassment Flag
  status?: boolean;           // Prioritize Status Flag (Kaizo extra)
  double_battle?: boolean;    // informational: is this a double battle
}

export interface MoveProbability {
  move: string;
  score: number;
  probability: number;
  breakdown: string[];
}

export type MoveProbabilityMap = Record<string, number>;

// ────────────────────────────────────────────────────────────────────────────
// Move-category sets (sourced from gen4_trainer_ai.md.txt)
// ────────────────────────────────────────────────────────────────────────────

/** Moves whose damage is never used in scoring (doc: "zero-score init" effects) */
const ZERO_DAMAGE_EFFECTS = new Set([
  'Explosion', 'Self-Destruct', 'Selfdestruct',
  'Dream Eater',
  'Razor Wind', 'Sky Attack', 'Skull Bash', 'Solar Beam', 'SolarBeam',
  'Hyper Beam', 'Giga Impact', 'Frenzy Plant', 'Blast Burn', 'Hydro Cannon',
  'Roar of Time', 'Rock Wrecker',
  'Water Spout', 'Eruption',
  'Gyro Ball', 'Low Kick', 'Grass Knot',
  'Head Smash',
  'Night Shade', 'Seismic Toss',
  'Return', 'Frustration', 'Bide',
  'Dragon Rage', 'Sonic Boom',
  'Spit Up', 'Focus Punch', 'Superpower',
  'Sucker Punch', 'Hidden Power', 'Natural Gift', 'Judgment', 'Psywave',
  'Counter', 'Mirror Coat', 'Metal Burst',
  'Flail', 'Reversal', 'Endeavor', 'Super Fang',
  'Trump Card', 'Crush Grip', 'Wring Out', 'Punishment', 'Magnitude',
  'Present',
]);

/** Nightmare and Dream Eater (Special basic flag effects) */
const NIGHTMARE_MOVES = new Set(['Nightmare']);
const DREAM_EATER_MOVES = new Set(['Dream Eater']);

/** Belly Drum (special > 50% HP requirement) */
const BELLY_DRUM_MOVES = new Set(['Belly Drum']);

/** Stat-reducing moves that may be penalized by Basic Flag */
const STAT_REDUCE_MOVES = new Set([
  'Growl', 'Scary Face', 'Leer', 'Tail Whip', 'String Shot', 'Screech',
  'Metal Sound', 'Fake Tears', 'Captivate', 'Charm', 'Sand Attack',
  'Smokescreen', 'Sweet Scent', 'Feather Dance', 'Close Combat',
]);

/** Stat reset/copy/swap moves (Haze, Psych Up, Heart Swap) */
const STAT_SWAP_MOVES = new Set(['Haze', 'Psych Up', 'Heart Swap']);

/** OHKO moves (Horn Drill, Fissure, Sheer Cold, Guillotine) */
const OHKO_MOVES = new Set(['Horn Drill', 'Fissure', 'Sheer Cold', 'Guillotine']);

/** Moves that force switches (Roar, Whirlwind, Dragon Tail, etc.) */
const FORCE_SWITCH_MOVES = new Set([
  'Roar', 'Whirlwind', 'Dragon Tail', 'Trick Room', 'Teleport',
]);

/** Screen / Protective moves (Reflect, Light Screen, Mist, Safeguard) */
const SCREEN_MOVES = new Set([
  'Reflect', 'Light Screen', 'Mist', 'Safeguard', 'Tailwind',
]);

/** Disable / Encore / Torment / similar "last move" effects */
const DISABLE_MOVES = new Set(['Disable', 'Encore', 'Torment']);

/** Snore / Sleep Talk (require being asleep) */
const SLEEP_DEPENDENT_MOVES = new Set(['Snore', 'Sleep Talk']);

/** Lock On / Mean Look / Foresight / Perish Song / etc. */
const LOCK_MOVES = new Set([
  'Lock On', 'Mean Look', 'Foresight', 'Perish Song', 'Miracle Eye',
  'Heal Block', 'Gastro Acid',
]);

/** Curse (stat or damage-over-time depending on type) */
const CURSE_MOVES = new Set(['Curse']);

/** Hazard-setting moves (Spikes, Toxic Spikes, Stealth Rock) */
const HAZARD_MOVES = new Set(['Spikes', 'Toxic Spikes', 'Stealth Rock']);

/** Future Sight / Doom Desire (delayed attacks) */
const DELAYED_DAMAGE_MOVES = new Set(['Future Sight', 'Doom Desire']);

/** Moves that affect multiple turns or have complex conditions */
const COMPLEX_STATUS_MOVES = new Set([
  'Substitute', 'Ingrain', 'Mud Sport', 'Water Sport', 'Camouflage',
  'Power Trick', 'Lucky Chant', 'Aqua Ring', 'Magnet Rise',
]);

/** Variable-type moves (their behavior varies by conditions) */
const VARIABLE_TYPE_MOVES = new Set([
  'Weather Ball', 'Hidden Power', 'Natural Gift', 'Judgment',
]);

/** Moves with special damage scaling (percentage of HP, target weight, etc.) */
const SPECIAL_SCALING_MOVES = new Set([
  'Water Spout', 'Eruption', 'Gyro Ball', 'Low Kick', 'Grass Knot',
]);

/** Moves with recoil damage */
const RECOIL_MOVES = new Set([
  'Head Smash', 'Brave Bird', 'Double-Edge', 'Flare Blitz', 'Submission',
  'Take Down', 'Volt Tackle', 'Wood Hammer', 'Close Combat', 'Superpower',
]);

/** Self-Destruct / Explosion group */
const SELFDESTRUCT_MOVES = new Set(['Explosion', 'Self-Destruct', 'Selfdestruct']);

/** Moves that are "Risky" for the Risky Flag */
const RISKY_MOVES = new Set([
  'Hypnosis', 'Sleep Powder', 'Spore', 'Lovely Kiss', 'Grass Whistle', 'Sing', 'Dark Void', 'Yawn',
  'Explosion', 'Self-Destruct', 'Selfdestruct',
  'Mirror Move',
  'Horn Drill', 'Fissure', 'Sheer Cold', 'Guillotine',
  'Slash', 'Razor Leaf', 'Karate Chop', 'Cross Chop', 'Crabhammer', 'Slash',
  'Night Slash', 'Psycho Cut', 'Shadow Claw', 'Leaf Blade', 'Cross Poison', 'Stone Edge',
  'Supersonic', 'Confuse Ray', 'Sweet Kiss', 'Flatter', 'Swagger',
  'Metronome',
  'Psywave',
  'Counter', 'Mirror Coat', 'Metal Burst',
  'Destiny Bond',
  'Attract',
  'Present',
  'Ancient Power', 'Silver Wind', 'Ominous Wind',
  'Belly Drum',
  'Focus Punch',
  'Gyro Ball',
  'Acupressure',
  'Payback',
  'Me First',
  'Sucker Punch',
]);

/** Recovery / Healing moves */
const RECOVERY_MOVES = new Set([
  'Recover', 'Roost', 'Synthesis', 'Moonlight', 'Morning Sun',
  'Slack Off', 'Milk Drink', 'Softboiled', 'Wish', 'Rest',
  'Heal Order', 'Shore Up', 'Swallow',
]);

/** Sleep-inducing moves */
const SLEEP_MOVES = new Set([
  'Hypnosis', 'Sleep Powder', 'Spore', 'Lovely Kiss',
  'Grass Whistle', 'Sing', 'Dark Void', 'Yawn',
]);

/** Poison-inducing moves */
const POISON_MOVES = new Set(['Poison Gas', 'Poison Powder', 'Toxic', 'Toxic Spikes']);

/** Paralysis-inducing moves */
const PARALYSIS_MOVES = new Set(['Thunder Wave', 'Stun Spore', 'Glare']);

/** Burn-inducing moves */
const BURN_MOVES = new Set(['Will-O-Wisp']);

/** Confusion-inducing moves */
const CONFUSE_MOVES = new Set(['Supersonic', 'Confuse Ray', 'Sweet Kiss', 'Flatter', 'Swagger']);

/** Leech Seed */
const LEECH_SEED_MOVES = new Set(['Leech Seed']);

/** Stat-boosting setup moves (single attacker stat) */
const ATTACK_BOOST_MOVES = new Set([
  'Howl', 'Meditate', 'Sharpen', 'Swords Dance', 'Nasty Plot', 'Calm Mind',
  'Charge Beam', 'Work Up',
]);

/** Stat-boosting speed moves */
const SPEED_BOOST_MOVES = new Set(['Agility', 'Rock Polish', 'Autotomize']);

/** Dual-stat boost moves */
const DUAL_BOOST_MOVES = new Set(['Dragon Dance', 'Cosmic Power', 'Bulk Up', 'Calm Mind']);

/** Evasion-boosting moves */
const EVASION_BOOST_MOVES = new Set(['Double Team', 'Minimize']);

/** Weather-setting moves */
const WEATHER_MOVES: Record<string, string> = {
  'Rain Dance': 'rain',
  'Sunny Day': 'sun',
  'Sandstorm': 'sand',
  'Hail': 'hail',
};

/** Setup moves for the Setup First Turn flag */
const SETUP_FIRST_TURN_EFFECTS = new Set([
  // Boosting/Reducing status
  'Swords Dance', 'Dragon Dance', 'Calm Mind', 'Bulk Up', 'Cosmic Power',
  'Nasty Plot', 'Meditate', 'Sharpen', 'Howl', 'Agility', 'Rock Polish',
  'Amnesia', 'Barrier', 'Iron Defense', 'Harden', 'Withdraw', 'Defense Curl',
  'Double Team', 'Minimize', 'Acid Armor',
  'Growl', 'Leer', 'Tail Whip', 'String Shot', 'Screech', 'Metal Sound',
  'Fake Tears', 'Captivate', 'Charm', 'Scary Face', 'Sand Attack', 'Smokescreen',
  // Status condition moves
  'Hypnosis', 'Sleep Powder', 'Spore', 'Lovely Kiss', 'Grass Whistle', 'Sing', 'Dark Void', 'Yawn',
  'Toxic', 'Poison Gas', 'Poison Powder',
  'Thunder Wave', 'Stun Spore', 'Glare',
  'Will-O-Wisp',
  'Supersonic', 'Confuse Ray', 'Sweet Kiss', 'Flatter', 'Swagger',
  // Field/utility
  'Reflect', 'Light Screen', 'Safeguard', 'Mist',
  'Leech Seed', 'Substitute',
  'Conversion', 'Torment', 'Ingrain', 'Imprison',
  'Tailwind', 'Lucky Chant', 'Magnet Rise', 'Defog', 'Whirlpool',
  'Camouflage', 'Minimize',
]);

/** Harassment-eligible move effects (from Harassment Flag section of doc) */
const HARASSMENT_MOVES = new Set([
  // Status-inducing
  'Hypnosis', 'Sleep Powder', 'Spore', 'Lovely Kiss', 'Grass Whistle', 'Sing', 'Dark Void', 'Yawn',
  'Toxic', 'Poison Gas', 'Poison Powder', 'Toxic Spikes',
  'Thunder Wave', 'Stun Spore', 'Glare',
  'Will-O-Wisp',
  'Supersonic', 'Confuse Ray', 'Sweet Kiss', 'Flatter',
  'Attract',
  // Stat-lowering (Attack or Defense by 1)
  'Growl', 'Leer', 'Tail Whip',
  // Stat-lowering (Attack, Defense, Speed, SpDef by 2)
  'Screech', 'Scary Face', 'String Shot', 'Fake Tears', 'Metal Sound',
  // Special
  'Leech Seed',
  'Encore',
  'Spite',
  'Spikes',
  'Swagger',
  'Torment',
  'Nature Power',
  'Knock Off',
  'Imprison',
  'Secret Power',
  'Tickle',
  'Camouflage',
  'Embargo',
  'Psycho Shift',
  'Defog',
  'Captivate',
]);

/** Priority +1 moves (for Evaluate Attack flag) */
const PRIORITY_PLUS_ONE_MOVES = new Set([
  'Quick Attack', 'Mach Punch', 'Bullet Punch', 'Ice Shard', 'Aqua Jet',
  'Shadow Sneak', 'Vacuum Wave', 'Feint',
]);

/** Focus Punch / Sucker Punch / Future Sight group (Evaluate Attack penalised) */
const EVAL_PENALIZED_MOVES = new Set(['Focus Punch', 'Sucker Punch', 'Future Sight', 'Doom Desire']);

/** Ability-based immunities: ability → types immune to */
const ABILITY_IMMUNITIES: Record<string, string[]> = {
  'Volt Absorb':   ['Electric'],
  'Motor Drive':   ['Electric'],
  'Water Absorb':  ['Water'],
  'Flash Fire':    ['Fire'],
  'Levitate':      ['Ground'],
};

/** Type-based immunities in Gen 4: attacking type -> defending types immune to it */
const TYPE_IMMUNITIES: Record<string, string[]> = {
  Normal: ['Ghost'],
  Fighting: ['Ghost'],
  Poison: ['Steel'],
  Ground: ['Flying'],
  Ghost: ['Normal'],
  Electric: ['Ground'],
  Psychic: ['Dark'],
};

/** Partial Gen 4 type chart for move-specific Expert-flag checks. */
const TYPE_EFFECTIVENESS: Record<string, Record<string, number>> = {
  Bug: {
    Grass: 2, Psychic: 2, Dark: 2,
    Fire: 0.5, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Ghost: 0.5, Steel: 0.5,
  },
  Dark: {
    Ghost: 2, Psychic: 2,
    Fighting: 0.5, Dark: 0.5, Steel: 0.5,
  },
  Fighting: {
    Normal: 2, Rock: 2, Steel: 2, Ice: 2, Dark: 2,
    Flying: 0.5, Poison: 0.5, Bug: 0.5, Psychic: 0.5, Ghost: 0,
  },
};

/** Sound-based moves (Soundproof ability blocks) */
const SOUND_MOVES = new Set([
  'Hyper Voice', 'Uproar', 'Snore', 'Roar', 'Perish Song',
  'Grasswhistle', 'Grass Whistle', 'Sing', 'Bug Buzz', 'Chatter',
  'Metal Sound', 'Growl', 'Screech', 'Supersonic', 'Heal Bell',
  'Round', 'Boomburst',
]);

/** Abilities that are considered "desirable" by AI skill-swap logic (Expert flag) */
const DESIRABLE_ABILITIES = new Set([
  'Speed Boost', 'Battle Armor', 'Sand Veil', 'Static', 'Flash Fire',
  'Wonder Guard', 'Effect Spore', 'Swift Swim', 'Huge Power', 'Rain Dish',
  'Cute Charm', 'Shed Skin', 'Marvel Scale', 'Pure Power', 'Chlorophyll',
  'Shield Dust', 'Adaptability', 'Magic Guard', 'Mold Breaker', 'Super Luck',
  'Unaware', 'Tinted Lens', 'Filter', 'Solid Rock', 'Reckless',
]);

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

const MONTE_CARLO_ITERATIONS = 10_000;

/** Build a @smogon/calc Pokemon from a BattleMon */
function makePokemon(mon: BattleMon): Pokemon {
  const options = {
    level:  mon.level,
    nature: mon.nature as never,
    ability: mon.ability as never,
    item:   mon.item as never,
    evs:    mon.evs ?? {},
    ivs:    mon.ivs ?? {},
    boosts: mon.boosts ?? {},
    status: mon.status,
  };
  return new Pokemon(4, mon.species, options);
}

/** Get smogon move data (category, type, etc.) */
function getMoveEntry(moveName: string) {
  const key = moveName.toLowerCase().replace(/[\s'-]/g, '') as never;
  return gen4.moves.get(key) ?? null;
}

/** Returns true if this move is a Status-category move */
function isStatusMove(moveName: string): boolean {
  if (ZERO_DAMAGE_EFFECTS.has(moveName)) return false; // damage-zero doesn't mean status
  const md = getMoveEntry(moveName);
  return md ? md.category === 'Status' : false;
}

/**
 * Compute expected damage (low + high)/2.
 * Returns 0 for status moves or moves in ZERO_DAMAGE_EFFECTS.
 */
function getDamage(
  attacker: BattleMon,
  defender: BattleMon,
  moveName: string,
  field: Field,
): number {
  if (ZERO_DAMAGE_EFFECTS.has(moveName)) return 0;
  if (isStatusMove(moveName)) return 0;
  try {
    const atk = makePokemon(attacker);
    const def = makePokemon(defender);
    const mv  = new Move(4, moveName);
    const result = calculate(4, atk, def, mv, field);
    const rolls = result.damage;
    if (!Array.isArray(rolls) || rolls.length === 0) return 0;
    const dmg = rolls as number[];
    return (dmg[0] + dmg[dmg.length - 1]) / 2;
  } catch {
    return 0;
  }
}

/** Get the maximum roll damage for a move (for KO check) */
function getMaxDamage(
  attacker: BattleMon,
  defender: BattleMon,
  moveName: string,
  field: Field,
): number {
  if (ZERO_DAMAGE_EFFECTS.has(moveName)) return 0;
  if (isStatusMove(moveName)) return 0;
  try {
    const atk = makePokemon(attacker);
    const def = makePokemon(defender);
    const mv  = new Move(4, moveName);
    const result = calculate(4, atk, def, mv, field);
    const rolls = result.damage;
    if (!Array.isArray(rolls) || rolls.length === 0) return 0;
    const dmg = rolls as number[];
    return dmg[dmg.length - 1];
  } catch {
    return 0;
  }
}

/** Get the minimum roll damage for a move (for guaranteed KO checks) */
function getMinDamage(
  attacker: BattleMon,
  defender: BattleMon,
  moveName: string,
  field: Field,
): number {
  if (ZERO_DAMAGE_EFFECTS.has(moveName)) return 0;
  if (isStatusMove(moveName)) return 0;
  try {
    const atk = makePokemon(attacker);
    const def = makePokemon(defender);
    const mv = new Move(4, moveName);
    const result = calculate(4, atk, def, mv, field);
    const rolls = result.damage;
    if (!Array.isArray(rolls) || rolls.length === 0) return 0;
    const dmg = rolls as number[];
    return dmg[0];
  } catch {
    return 0;
  }
}

/** Moves we treat as drawback-heavy (recoil and/or self-stat-drop) for KO tie-break penalties. */
const DRAWBACK_MOVES = new Set([
  'Brave Bird', 'Double-Edge', 'Flare Blitz', 'Head Smash', 'Submission', 'Take Down', 'Volt Tackle', 'Wood Hammer',
  'Close Combat', 'Superpower', 'Draco Meteor', 'Leaf Storm', 'Overheat', 'Psycho Boost', 'Hammer Arm',
]);

function getEstimatedMaxHp(mon: BattleMon): number {
  try {
    const built = makePokemon(mon) as unknown as { rawStats?: { hp?: number }; stats?: { hp?: number } };
    const hp = built.rawStats?.hp ?? built.stats?.hp;
    if (typeof hp === 'number' && hp > 0) return hp;
  } catch {
    // fallback below
  }
  return Math.max(1, Math.round(mon.level * 2.5 + 10));
}

function getEstimatedCurrentHp(mon: BattleMon): number {
  const maxHp = getEstimatedMaxHp(mon);
  return Math.max(1, Math.round((Math.max(0, mon.hpPercent) / 100) * maxHp));
}

function getMoveAccuracyMultiplier(moveName: string): number {
  const md = getMoveEntry(moveName) as unknown as { accuracy?: number | true } | null;
  if (!md) return 1;
  const accuracy = md.accuracy;
  if (accuracy === true || accuracy == null) return 1;
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy)) return 1;
  return Math.max(0, Math.min(1, accuracy / 100));
}

function hasMoveDrawback(moveName: string): boolean {
  if (DRAWBACK_MOVES.has(moveName)) return true;
  const md = getMoveEntry(moveName) as unknown as {
    recoil?: unknown;
    hasCrashDamage?: boolean;
    mindBlownRecoil?: boolean;
    struggleRecoil?: boolean;
    self?: { boosts?: Record<string, number> };
  } | null;
  if (!md) return false;
  if (md.recoil || md.hasCrashDamage || md.mindBlownRecoil || md.struggleRecoil) return true;
  const selfBoosts = md.self?.boosts ?? {};
  return Object.values(selfBoosts).some((stageDelta) => typeof stageDelta === 'number' && stageDelta < 0);
}

function isMoveImmune(attacker: BattleMon, defender: BattleMon, moveName: string, field: Field): boolean {
  const md = getMoveEntry(moveName);
  if (!md || md.category === 'Status') return false;
  const moveType = md.type as string | undefined;
  if (hasTypeImmunity(moveType, defender.types)) return true;
  if (hasAbilityImmunity(moveName, moveType, defender.ability, attacker.ability)) return true;
  try {
    const atk = makePokemon(attacker);
    const def = makePokemon(defender);
    const mv = new Move(4, moveName);
    const result = calculate(4, atk, def, mv, field);
    return isNoDamageResult(result.damage);
  } catch {
    return false;
  }
}

function isStatusMoveRedundant(attacker: BattleMon, defender: BattleMon, moveName: string): boolean {
  if (!SLEEP_MOVES.has(moveName) && !POISON_MOVES.has(moveName) && !PARALYSIS_MOVES.has(moveName) && !BURN_MOVES.has(moveName)) {
    return false;
  }
  if (defender.status) return true;
  if (defender.hasSafeguard) return true;

  const defenderAbility = defender.ability ?? '';
  const attackerAbility = attacker.ability ?? '';
  const defenderTypes = defender.types ?? [];

  if (SLEEP_MOVES.has(moveName) && (defenderAbility === 'Insomnia' || defenderAbility === 'Vital Spirit')) return true;
  if (POISON_MOVES.has(moveName)) {
    if (defenderTypes.includes('Steel') || defenderTypes.includes('Poison')) return true;
    if (['Immunity', 'Magic Guard', 'Poison Heal'].includes(defenderAbility)) return true;
  }
  if (PARALYSIS_MOVES.has(moveName)) {
    if (['Limber', 'Magic Guard'].includes(defenderAbility)) return true;
    if (moveName === 'Thunder Wave' && ['Motor Drive', 'Volt Absorb'].includes(defenderAbility) && attackerAbility !== 'Mold Breaker') {
      return true;
    }
  }
  if (BURN_MOVES.has(moveName)) {
    if (defenderTypes.includes('Fire')) return true;
    if (['Water Veil', 'Magic Guard'].includes(defenderAbility)) return true;
  }
  return false;
}

function isSetupRedundant(mon: BattleMon, moveName: string): boolean {
  const boosts = mon.boosts ?? {};
  const hasMaxStage = (key: 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'eva'): boolean => (boosts[key] ?? 0) >= 6;

  if (ATTACK_BOOST_MOVES.has(moveName) && hasMaxStage('atk')) return true;
  if (SPEED_BOOST_MOVES.has(moveName) && hasMaxStage('spe')) return true;
  if (EVASION_BOOST_MOVES.has(moveName) && hasMaxStage('eva')) return true;
  if (DUAL_BOOST_MOVES.has(moveName)) {
    if (moveName === 'Dragon Dance') return hasMaxStage('atk') || hasMaxStage('spe');
    if (moveName === 'Bulk Up') return hasMaxStage('atk') || hasMaxStage('def');
    if (moveName === 'Calm Mind') return hasMaxStage('spa') || hasMaxStage('spd');
    if (moveName === 'Cosmic Power') return hasMaxStage('def') || hasMaxStage('spd');
    return hasMaxStage('atk') || hasMaxStage('spe') || hasMaxStage('def') || hasMaxStage('spa') || hasMaxStage('spd');
  }

  const md = getMoveEntry(moveName) as unknown as { self?: { boosts?: Record<string, number> } } | null;
  const selfBoosts = md?.self?.boosts ?? {};
  for (const [stat, delta] of Object.entries(selfBoosts)) {
    if (typeof delta === 'number' && delta > 0) {
      const stage = (boosts as Record<string, number | undefined>)[stat] ?? 0;
      if (stage >= 6) return true;
    }
  }
  return false;
}

function isStatusOrSetupMove(moveName: string): boolean {
  return isStatusMove(moveName)
    || ATTACK_BOOST_MOVES.has(moveName)
    || SPEED_BOOST_MOVES.has(moveName)
    || DUAL_BOOST_MOVES.has(moveName)
    || EVASION_BOOST_MOVES.has(moveName);
}

function playerCanLikelyKoThisTurn(playerMon: BattleMon, enemyMon: BattleMon, field: Field): boolean {
  const enemyCurrentHp = getEstimatedCurrentHp(enemyMon);
  for (const moveName of playerMon.moves.filter(Boolean)) {
    const maxDamage = getMaxDamage(playerMon, enemyMon, moveName, field);
    if (maxDamage >= enemyCurrentHp) return true;
  }
  return false;
}

/** Check if a defender's ability makes them immune to this move */
function hasAbilityImmunity(
  moveName: string,
  moveType: string | undefined,
  defenderAbility: string | undefined,
  attackerAbility: string | undefined,
): boolean {
  if (!defenderAbility) return false;
  const moldBreaker = attackerAbility === 'Mold Breaker';
  if (moldBreaker) return false;

  // Wonder Guard: only super-effective moves hit
  if (defenderAbility === 'Wonder Guard') {
    // we can't easily compute SE here without running calc — skip for now
    return false;
  }

  // Soundproof
  if (defenderAbility === 'Soundproof' && SOUND_MOVES.has(moveName)) return true;

  if (!moveType) return false;
  const immuneTypes = ABILITY_IMMUNITIES[defenderAbility];
  if (immuneTypes && immuneTypes.includes(moveType)) return true;

  return false;
}

function hasTypeImmunity(moveType: string | undefined, defenderTypes: string[] | undefined): boolean {
  if (!moveType || !defenderTypes || defenderTypes.length === 0) return false;
  const normalizedMoveType = moveType.charAt(0).toUpperCase() + moveType.slice(1).toLowerCase();
  const immuneDefenderTypes = TYPE_IMMUNITIES[normalizedMoveType];
  if (!immuneDefenderTypes) return false;
  return defenderTypes
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .some((t) => immuneDefenderTypes.includes(t));
}

function isNoDamageResult(damage: unknown): boolean {
  if (typeof damage === 'number') return damage <= 0;
  if (Array.isArray(damage)) {
    if (damage.length === 0) return true;
    const nums = damage.filter((v): v is number => typeof v === 'number');
    return nums.length === 0 || Math.max(...nums) <= 0;
  }
  return false;
}

function getTypeEffectivenessMultiplier(moveType: string | undefined, defenderTypes: string[] | undefined): number {
  if (!moveType || !defenderTypes || defenderTypes.length === 0) return 1;
  const typeChart = TYPE_EFFECTIVENESS[
    moveType.charAt(0).toUpperCase() + moveType.slice(1).toLowerCase()
  ];
  if (!typeChart) return 1;
  let mult = 1;
  for (const t of defenderTypes) {
    const key = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    mult *= typeChart[key] ?? 1;
  }
  return mult;
}

function isResistedOrImmuneMove(
  moveName: string,
  attacker: BattleMon,
  defender: BattleMon,
): boolean {
  const md = getMoveEntry(moveName);
  if (!md || md.category === 'Status') return false;
  const moveType = md.type as string | undefined;
  if (hasAbilityImmunity(moveName, moveType, defender.ability, attacker.ability)) return true;
  if (hasTypeImmunity(moveType, defender.types)) return true;
  return getTypeEffectivenessMultiplier(moveType, defender.types) < 1;
}

function hasSuperEffectiveDamagingMove(attackerMoves: string[], defender: BattleMon): boolean {
  for (const moveName of attackerMoves) {
    const md = getMoveEntry(moveName);
    if (!md || md.category === 'Status') continue;
    const moveType = md.type as string | undefined;
    if (hasTypeImmunity(moveType, defender.types)) continue;
    if (getTypeEffectivenessMultiplier(moveType, defender.types) > 1) return true;
  }
  return false;
}

/** Is the enemy faster than the player under normal speed order or Trick Room. */
function enemyIsFaster(enemy: BattleMon, player: BattleMon, isTrickRoom: boolean): boolean {
  const eSpe = enemy.speed ?? 0;
  const pSpe = player.speed ?? 0;
  if (eSpe !== 0 || pSpe !== 0) {
    return isTrickRoom ? eSpe < pSpe : eSpe > pSpe;
  }
  return false; // unknown: treat as tied
}

// ────────────────────────────────────────────────────────────────────────────
// Flag implementations
// ────────────────────────────────────────────────────────────────────────────

/** Basic Flag — discourage wasted / self-harming moves. */
function applyBasicFlag(
  scores: Record<string, number>,
  moves: string[],
  enemyMon: BattleMon,
  playerMon: BattleMon,
  field: Field,
  fieldState: FieldState,
  isTrickRoom: boolean,
): void {
  for (const mv of moves) {
    const md = getMoveEntry(mv);
    const moveType: string | undefined = md?.type as string | undefined;

    if (mv === 'Fake Out' && (fieldState.turnNumber ?? 1) !== 1) {
      scores[mv] -= 10;
    }

    // ── 1. Type immunity ─────────────────────────────────────────────────
    if (md && md.category !== 'Status') {
      try {
        const atk = makePokemon(enemyMon);
        const def = makePokemon(playerMon);
        const smgMove = new Move(4, mv);
        const result = calculate(4, atk, def, smgMove, field);
        // damage array is empty or all-zero for type immune
        if (isNoDamageResult(result.damage)) {
          scores[mv] -= 10;
          continue; // immune — skip other checks for this move
        }
      } catch { /* ignore */ }
    }

    // ── 2. Ability-based immunity ─────────────────────────────────────────
    if (hasAbilityImmunity(mv, moveType, playerMon.ability, enemyMon.ability)) {
      scores[mv] -= 10;
      continue;
    }

    // ── 3. Move-effect scoring ────────────────────────────────────────────

    // Sleep moves
    if (SLEEP_MOVES.has(mv)) {
      if (playerMon.status) { scores[mv] -= 10; continue; }
      if (playerMon.hasSafeguard) { scores[mv] -= 10; continue; }
      if (['Insomnia', 'Vital Spirit'].includes(playerMon.ability ?? '')) {
        scores[mv] -= 10; continue;
      }
    }

    // Poison moves
    if (POISON_MOVES.has(mv)) {
      const pTypes = playerMon.types ?? [];
      if (pTypes.includes('Steel') || pTypes.includes('Poison')) { scores[mv] -= 10; continue; }
      if (['Immunity', 'Magic Guard', 'Poison Heal'].includes(playerMon.ability ?? '')) {
        scores[mv] -= 10; continue;
      }
      if (playerMon.status) { scores[mv] -= 10; continue; }
      if (playerMon.hasSafeguard) { scores[mv] -= 10; continue; }
    }

    // Paralysis moves
    if (PARALYSIS_MOVES.has(mv)) {
      if (playerMon.status) { scores[mv] -= 10; continue; }
      if (playerMon.hasSafeguard) { scores[mv] -= 10; continue; }
      if (['Limber', 'Magic Guard'].includes(playerMon.ability ?? '')) {
        scores[mv] -= 10; continue;
      }
      // Thunder Wave vs Electric immune abilities
      if (mv === 'Thunder Wave' &&
          ['Motor Drive', 'Volt Absorb'].includes(playerMon.ability ?? '') &&
          enemyMon.ability !== 'Mold Breaker') {
        scores[mv] -= 10; continue;
      }
    }

    // Burn moves
    if (BURN_MOVES.has(mv)) {
      const pTypes = playerMon.types ?? [];
      if (pTypes.includes('Fire')) { scores[mv] -= 10; continue; }
      if (['Water Veil', 'Magic Guard'].includes(playerMon.ability ?? '')) {
        scores[mv] -= 10; continue;
      }
      if (playerMon.status) { scores[mv] -= 10; continue; }
      if (playerMon.hasSafeguard) { scores[mv] -= 10; continue; }
    }

    // Confusion moves
    if (CONFUSE_MOVES.has(mv)) {
      if (playerMon.isConfused) { scores[mv] -= 5; continue; }
      if (playerMon.ability === 'Own Tempo' || playerMon.hasSafeguard) { scores[mv] -= 10; continue; }
    }

    // Nightmare: -10 if target not asleep or has Magic Guard
    if (NIGHTMARE_MOVES.has(mv)) {
      if (playerMon.status !== 'slp' || playerMon.ability === 'Magic Guard') {
        scores[mv] -= 10; continue;
      }
    }

    // Dream Eater: -8 if not asleep, -10 if type immune
    if (DREAM_EATER_MOVES.has(mv)) {
      if (playerMon.status !== 'slp') { scores[mv] -= 8; continue; }
      if (hasTypeImmunity(moveType, playerMon.types)) { scores[mv] -= 10; continue; }
    }

    // Belly Drum: -10 if user HP <= 50% (rounded down)
    if (BELLY_DRUM_MOVES.has(mv)) {
      if (enemyMon.hpPercent <= 50) { scores[mv] -= 10; continue; }
    }

    // Recovery moves: -8 if at full HP
    if (RECOVERY_MOVES.has(mv) && enemyMon.hpPercent >= 100) {
      scores[mv] -= 8; continue;
    }

    // Screen/Protective moves (Reflect, Light Screen, Mist, Safeguard): -8 if already active
    if (SCREEN_MOVES.has(mv)) {
      // Note: Full implementation requires field state tracking (hasSafeguard, hasReflect, etc.)
      // Simplified check: assume Safeguard tracks multi-turn effects
      if (playerMon.hasSafeguard && (mv === 'Safeguard' || mv === 'Mist')) {
        scores[mv] -= 8; continue;
      }
    }

    // OHKO moves: -10 if target immune or higher level
    if (OHKO_MOVES.has(mv)) {
      if (hasTypeImmunity(moveType, playerMon.types)) { scores[mv] -= 10; continue; }
      if (playerMon.ability === 'Sturdy' && enemyMon.ability !== 'Mold Breaker') {
        scores[mv] -= 10; continue;
      }
      if (playerMon.level > enemyMon.level) { scores[mv] -= 10; continue; }
    }

    // Moves that force switches: -10 if target has no switch or has Suction Cups
    if (FORCE_SWITCH_MOVES.has(mv)) {
      if (playerMon.isLastPokemon) { scores[mv] -= 10; continue; }
      if (playerMon.ability === 'Suction Cups' && enemyMon.ability !== 'Mold Breaker') {
        scores[mv] -= 10; continue;
      }
    }

    // Leech Seed: -10 if target is Grass-type or has Magic Guard
    if (LEECH_SEED_MOVES.has(mv)) {
      const pTypes = playerMon.types ?? [];
      if (pTypes.includes('Grass') || playerMon.ability === 'Magic Guard') {
        scores[mv] -= 10; continue;
      }
    }

    // Substitute: -10 if user < 26% HP; -8 if already substituted
    if (mv === 'Substitute') {
      if (enemyMon.hpPercent < 26) { scores[mv] -= 10; continue; }
      // Note: tracking Substitute status requires battle state; skipped for now
    }

    // Snore / Sleep Talk: -8 if not asleep
    if (SLEEP_DEPENDENT_MOVES.has(mv)) {
      if (enemyMon.status !== 'slp') { scores[mv] -= 8; continue; }
    }

    // Hazard-setting moves: -10 if target is last Pokémon (no switch aftermath)
    if (HAZARD_MOVES.has(mv)) {
      if (playerMon.isLastPokemon) { scores[mv] -= 10; continue; }
      // Max layer check requires field state; would need to track Spikes/Toxic Spikes/Stealth Rock layers
    }

    // Weather-setting moves: -8 if weather already active
    if (Object.keys(WEATHER_MOVES).includes(mv)) {
      const targetWeather = WEATHER_MOVES[mv];
      if (targetWeather === fieldState.weather) { scores[mv] -= 8; continue; }
    }

    // Future Sight / Doom Desire: -12 if already pending (would require field state tracking)
    // Skipped for now as it requires battle history

    // Baton Pass: -10 if user is last Pokémon
    if (mv === 'Baton Pass') {
      if (enemyMon.isLastPokemon) { scores[mv] -= 10; continue; }
    }

    // Trick / Switcheroo: -10 if target has Sticky Hold or no item
    if (mv === 'Trick' || mv === 'Switcheroo') {
      if (playerMon.ability === 'Sticky Hold' || !playerMon.item) {
        scores[mv] -= 10; continue;
      }
    }

    // Helping Hand: -10 if not a double battle
    if (mv === 'Helping Hand') {
      if (!fieldState.isDoubleBattle) { scores[mv] -= 10; continue; }
    }

    // Self-Destruct / Explosion: -10 if Damp (unless Mold Breaker)
    if (SELFDESTRUCT_MOVES.has(mv)) {
      if (playerMon.ability === 'Damp' && enemyMon.ability !== 'Mold Breaker') {
        scores[mv] -= 10; continue;
      }
      // Last Pokémon logic
      if (enemyMon.isLastPokemon) {
        if (playerMon.isLastPokemon) scores[mv] -= 1;
        else scores[mv] -= 10;
      }
    }

    // Stat-boosting moves: -10 if Speed + Trick Room
    if ((SPEED_BOOST_MOVES.has(mv) || (DUAL_BOOST_MOVES.has(mv) && mv === 'Dragon Dance')) && isTrickRoom) {
      scores[mv] -= 10; continue;
    }

    // Stat-boosting moves: -10 if already at max stage
    if (ATTACK_BOOST_MOVES.has(mv)) {
      if ((enemyMon.boosts?.atk ?? 0) >= 6) { scores[mv] -= 10; continue; }
    }
    if (SPEED_BOOST_MOVES.has(mv)) {
      if ((enemyMon.boosts?.spe ?? 0) >= 6) { scores[mv] -= 10; continue; }
    }
    if (DUAL_BOOST_MOVES.has(mv)) {
      const boosts = enemyMon.boosts ?? {};
      if (mv === 'Dragon Dance' && (boosts.atk ?? 0) >= 6) { scores[mv] -= 10; continue; }
      if (mv === 'Dragon Dance' && (boosts.spe ?? 0) >= 6) { scores[mv] -= 10; continue; }
      if (mv === 'Bulk Up' && (boosts.atk ?? 0) >= 6) { scores[mv] -= 10; continue; }
      if (mv === 'Bulk Up' && (boosts.def ?? 0) >= 6) { scores[mv] -= 10; continue; }
      if (mv === 'Calm Mind' && (boosts.spa ?? 0) >= 6) { scores[mv] -= 10; continue; }
      if (mv === 'Calm Mind' && (boosts.spd ?? 0) >= 6) { scores[mv] -= 10; continue; }
      if (mv === 'Cosmic Power' && (boosts.def ?? 0) >= 6) { scores[mv] -= 10; continue; }
      if (mv === 'Cosmic Power' && (boosts.spd ?? 0) >= 6) { scores[mv] -= 10; continue; }
    }
  }
}

/** Evaluate Attack Flag — prioritize raw damage.
 *
 * Philosophy: Raw damage output trumps all other considerations.
 * References: gen4_trainer_ai.md.txt "Evaluate Attack Flag" section
 * Key Probabilities:
 *   - Self-Destruct/Explosion: 80% chance of -2
 *   - Focus Punch/Sucker Punch/Future Sight: 80% chance of -2, ~33.6% chance of +4 for KO
 *   - Quad-effective damage: 31.25% chance of +2
 */
function applyEvalAttFlag(
  scores: Record<string, number>,
  moves: string[],
  enemyMon: BattleMon,
  playerMon: BattleMon,
  field: Field,
): void {
  const damages: Record<string, number> = {};
  const maxDamages: Record<string, number> = {};
  const defHP = Math.round((playerMon.hpPercent / 100) * playerMon.level * 2.5 + 10); // rough estimate

  for (const mv of moves) {
    damages[mv] = getDamage(enemyMon, playerMon, mv, field);
    maxDamages[mv] = getMaxDamage(enemyMon, playerMon, mv, field);
  }

  const maxDmgOverall = Math.max(...Object.values(damages), 0);

  for (const mv of moves) {
    const maxRoll = maxDamages[mv];
    const isKO = maxRoll > 0 && maxRoll >= defHP;

    // Self-Destruct: no scoring bonus for KO
    if (SELFDESTRUCT_MOVES.has(mv)) {
      if (Math.random() < 0.8) scores[mv] += -2;
      continue;
    }

    // Focus Punch / Sucker Punch / Future Sight: ~33.6% chance of +4 for KO
    if (EVAL_PENALIZED_MOVES.has(mv) && !SELFDESTRUCT_MOVES.has(mv)) {
      if (isKO && Math.random() < 0.336) scores[mv] += 4;
      if (Math.random() < 0.8) scores[mv] += -2;
      continue;
    }

    // Priority +1 moves: +6 for KO (skip SE check)
    if (isKO && PRIORITY_PLUS_ONE_MOVES.has(mv) && mv !== 'Fake Out') {
      scores[mv] += 6;
      continue;
    }

    // Normal move: +4 for KO
    if (isKO) {
      scores[mv] += 4;
    }

    // Not highest damage: -1
    if (maxDmgOverall > 0 && damages[mv] < maxDmgOverall) {
      scores[mv] -= 1;
    }

    // Quad-effective: 31.25% chance of +2
    // We approximate by checking if damage is ~4x what a neutral move would do
    // (can't easily get exact effectiveness multiplier, so skip for now)
  }
}

/** Expert Flag — conditional encouragement/discouragement based on situation.
 *
 * Philosophy: Add nuance to move selection based on HP, speed, ability matchups.
 * References: gen4_trainer_ai.md.txt "Expert Flag" section
 * Key Probabilities:
 *   - Paralysis when user is slower: 92.2% chance of +3
 *   - Sleep setup: 50% chance of +1 if user knows Dream Eater/Nightmare
 *   - Recovery at >= 70% HP: ~88.3% chance of -3
 *   - Speed boost when user is slower: ~72.7% chance of +3
 *   - Various HP-conditional adjustments with specific thresholds
 */
function applyExpertFlag(
  scores: Record<string, number>,
  moves: string[],
  enemyMon: BattleMon,
  playerMon: BattleMon,
  fieldState: FieldState,
): void {
  const eFaster = enemyIsFaster(enemyMon, playerMon, fieldState.isTrickRoom ?? false);

  for (const mv of moves) {
    if (mv === 'Fake Out' && (fieldState.turnNumber ?? 1) === 1) {
      scores[mv] += 2;
    }

    // Sleep moves: if enemy knows Dream Eater/Nightmare → 50% +1
    if (SLEEP_MOVES.has(mv)) {
      if (moves.includes('Dream Eater') || moves.includes('Nightmare')) {
        if (Math.random() < 0.5) scores[mv] += 1;
      }
    }

    // Poison moves: if attacker HP < 50% or defender HP <= 50% → -1
    if (POISON_MOVES.has(mv)) {
      if (enemyMon.hpPercent < 50 || playerMon.hpPercent <= 50) {
        scores[mv] -= 1;
      }
    }

    // Paralysis moves
    if (PARALYSIS_MOVES.has(mv)) {
      if (!eFaster && Math.random() < 0.922) scores[mv] += 3;  // enemy is slower → encourage para
      if (enemyMon.hpPercent <= 70) scores[mv] -= 1;
    }

    // Confusion moves: HP-based
    if (CONFUSE_MOVES.has(mv) && mv !== 'Swagger' && mv !== 'Flatter') {
      if (playerMon.hpPercent <= 70 && Math.random() < 0.5) scores[mv] += -1;
      if (playerMon.hpPercent <= 50) scores[mv] -= 1;
      if (playerMon.hpPercent <= 30) scores[mv] -= 1;
    }
    if (mv === 'Flatter' && Math.random() < 0.5) scores[mv] += 1;
    if (mv === 'Swagger') {
      if (!moves.includes('Psych Up')) {
        if (Math.random() < 0.5) scores[mv] += 1;
      }
    }

    // Recovery moves: much more nuanced than Basic flag
    if (RECOVERY_MOVES.has(mv)) {
      // At full HP: -3 and done
      if (enemyMon.hpPercent >= 100) { scores[mv] -= 3; continue; }
      // Enemy is faster: -8 and done
      if (eFaster) { scores[mv] -= 8; continue; }
      // HP >= 70%: ~88.3% chance of -3 and done
      if (enemyMon.hpPercent >= 70) { if (Math.random() < 0.883) scores[mv] += -3; continue; }
      // Otherwise: small bonus if opponent lacks Snatch
      if (Math.random() < 0.922) scores[mv] += 2;
    }

    // Stat-boosting (attacking stats): HP-based
    if (ATTACK_BOOST_MOVES.has(mv)) {
      const stage = enemyMon.boosts?.atk ?? 0;
      if (stage >= 3 && Math.random() < 0.609) scores[mv] += -1;
      if (enemyMon.hpPercent >= 100 && Math.random() < 0.5) scores[mv] += 2;
      if (enemyMon.hpPercent > 70) { /* no further changes */ }
      else if (enemyMon.hpPercent < 40) scores[mv] -= 2;
      else if (Math.random() < 0.844) scores[mv] += -2;
    }

    // Speed boosts: discourage if already faster, encourage if slower
    if (SPEED_BOOST_MOVES.has(mv)) {
      if (eFaster) scores[mv] -= 3;
      else if (Math.random() < 0.727) scores[mv] += 3;
    }

    // Self-Destruct / Explosion / Memento: HP-based
    if (SELFDESTRUCT_MOVES.has(mv) || mv === 'Memento') {
      if (enemyMon.hpPercent >= 80) {
        if (eFaster && Math.random() < 0.805) scores[mv] += -3;
        else if (!eFaster && Math.random() < 0.805) scores[mv] += -1;
      } else if (enemyMon.hpPercent > 50) {
        if (Math.random() < 0.805) scores[mv] += -1;
      } else if (enemyMon.hpPercent > 30) {
        if (Math.random() < 0.5) scores[mv] += 1;
      } else {
        if (Math.random() < 0.805) scores[mv] += 1;
      }
    }

    // Evasion boosts: HP-based encouragement
    if (EVASION_BOOST_MOVES.has(mv)) {
      if (enemyMon.hpPercent >= 90 && Math.random() < 0.609) scores[mv] += 3;
      const stage = enemyMon.boosts?.eva ?? 0;
      if (stage >= 3 && Math.random() < 0.5) scores[mv] += -1;
    }

    // Destiny Bond: starts -1; slow→more chances; HP-based
    if (mv === 'Destiny Bond') {
      scores[mv] -= 1;
      if (!eFaster) {
        if (enemyMon.hpPercent <= 70 && Math.random() < 0.5) scores[mv] += 1;
        if (enemyMon.hpPercent <= 50 && Math.random() < 0.5) scores[mv] += 1;
        if (enemyMon.hpPercent <= 30 && Math.random() < 0.609) scores[mv] += 2;
      }
    }

    // Ability-swap moves: discourage if attacker has desirable ability,
    // encourage if opponent does
    if (mv === 'Role Play' || mv === 'Skill Swap') {
      if (DESIRABLE_ABILITIES.has(enemyMon.ability ?? '')) scores[mv] -= 1;
      if (DESIRABLE_ABILITIES.has(playerMon.ability ?? '') && Math.random() < 0.805) scores[mv] += 2;
    }

    // Pluck / Bug Bite
    if (mv === 'Pluck' || mv === 'Bug Bite') {
      if (isResistedOrImmuneMove(mv, enemyMon, playerMon)) scores[mv] -= 1;
      if ((fieldState.turnNumber ?? 1) === 1 && Math.random() < 0.75) scores[mv] += 1;
      if (Math.random() < 0.5) scores[mv] += 1;
    }

    // U-turn
    if (mv === 'U-turn' || mv === 'U Turn') {
      if (isResistedOrImmuneMove(mv, enemyMon, playerMon)) {
        scores[mv] -= 1;
      } else {
        if (enemyMon.isLastPokemon) {
          scores[mv] += 2;
        } else {
          if (hasSuperEffectiveDamagingMove(moves, playerMon) && Math.random() < 0.75) scores[mv] += -2;
          if (playerMon.hpPercent > 70 && Math.random() < 0.75) scores[mv] += 1;
          else if (playerMon.hpPercent > 30 && Math.random() < 0.5) scores[mv] += 1;
          else if (playerMon.hpPercent <= 30 && Math.random() < 0.25) scores[mv] += 1;
          if (eFaster) scores[mv] += 1;
          else if (Math.random() < 0.5) scores[mv] += 1;
        }
      }
    }

    // Close Combat
    if (mv === 'Close Combat') {
      if (isResistedOrImmuneMove(mv, enemyMon, playerMon)) scores[mv] -= 1;
      if (!eFaster && enemyMon.hpPercent <= 80) scores[mv] -= 1;
      if (eFaster && enemyMon.hpPercent <= 60) scores[mv] -= 1;
    }

    // Payback
    if (mv === 'Payback') {
      if (isResistedOrImmuneMove(mv, enemyMon, playerMon)) scores[mv] -= 1;
      if (!eFaster && enemyMon.hpPercent >= 30 && Math.random() < 0.75) scores[mv] += 1;
    }

    // Assurance
    if (mv === 'Assurance') {
      if (isResistedOrImmuneMove(mv, enemyMon, playerMon)) scores[mv] -= 1;
      if (!eFaster) {
        if (enemyMon.ability === 'Rough Skin') {
          if (Math.random() < 0.5) scores[mv] += 1;
        } else if (enemyMon.item === 'Jaboca Berry' || enemyMon.item === 'Rowap Berry') {
          if (Math.random() < 0.5) scores[mv] += 1;
        } else {
          if (Math.random() < 0.25) scores[mv] += 1;
        }
      }
    }
  }
}

/** Setup First Turn Flag — prioritize setup moves on turn 1.
 *
 * Philosophy: Establish advantage early via stat boosts or field manipulation.
 * References: gen4_trainer_ai.md.txt (mentioned in various sections)
 * Behavior: ~68.75% chance of +2 for setup/status moves on turn 1 only.
 */
function applySetupFirstTurnFlag(
  scores: Record<string, number>,
  moves: string[],
  fieldState: FieldState,
): void {
  if ((fieldState.turnNumber ?? 1) !== 1) return;
  for (const mv of moves) {
    if (SETUP_FIRST_TURN_EFFECTS.has(mv) || isStatusMove(mv)) {
      if (Math.random() < 0.6875) scores[mv] += 2;
    }
  }
}

/** Risky Flag — encourage high-risk moves with uncertain outcomes.
 *
 * Philosophy: Less cautious AI takes chances on unreliable moves.
 * References: gen4_trainer_ai.md.txt (risky moves include sleep, OHKO, etc.)
 * Behavior: 50% chance of +2 for moves in RISKY_MOVES set.
 */
function applyRiskyFlag(
  scores: Record<string, number>,
  moves: string[],
): void {
  for (const mv of moves) {
    if (RISKY_MOVES.has(mv)) {
      if (Math.random() < 0.5) scores[mv] += 2;
    }
  }
}

/** Prioritize Extremes Flag — favor status and zero-damage moves.
 *
 * Philosophy: Emphasize non-damage strategies (status, setup, disruption).
 * References: gen4_trainer_ai.md.txt (Prioritize Damage / Prioritize Extremes)
 * Behavior: ~61% chance of +2 for zero-damage or status moves.
 */
function applyPrioritizeExtremesFlag(
  scores: Record<string, number>,
  moves: string[],
): void {
  for (const mv of moves) {
    if (ZERO_DAMAGE_EFFECTS.has(mv) || isStatusMove(mv)) {
      if (Math.random() < 0.61) scores[mv] += 2;
    }
  }
}

/** Baton Pass Flag — prioritize setup, Protect, and Baton Pass.
 *
 * Philosophy: Chain stat boosts and pivot strategically via Baton Pass.
 * References: gen4_trainer_ai.md.txt "Baton Pass Flag" section
 * Behavior: Prioritize setup moves, Protect/Detect, then Baton Pass based on stages.
 */
function applyBatonPassFlag(
  scores: Record<string, number>,
  moves: string[],
  enemyMon: BattleMon,
  fieldState: FieldState,
): void {
  if (enemyMon.isLastPokemon) return; // exit if no remaining party

  const eFaster = (enemyMon.speed ?? 0) > 0; // simplified
  const turn = fieldState.turnNumber ?? 1;

  for (const mv of moves) {
    // Skip damaging moves (Baton Pass flag ignores them)
    const md = getMoveEntry(mv);
    const isDamaging = md ? md.category !== 'Status' && !ZERO_DAMAGE_EFFECTS.has(mv) : false;
    if (isDamaging && !SETUP_FIRST_TURN_EFFECTS.has(mv)) continue;

    // Step 1: Swords Dance / Dragon Dance / Calm Mind / Nasty Plot
    if (['Swords Dance', 'Dragon Dance', 'Calm Mind', 'Nasty Plot', 'Agility', 'Rock Polish'].includes(mv)) {
      if (turn === 1) scores[mv] += 5;
      else if (enemyMon.hpPercent >= 60) scores[mv] += 1;
      else scores[mv] -= 10;
      continue;
    }

    // Step 2: Protect / Detect
    if (mv === 'Protect' || mv === 'Detect') {
      // If last move was protect: -2, else +2
      const lastWasProtect = enemyMon.lastUsedMove === 'Protect' || enemyMon.lastUsedMove === 'Detect';
      scores[mv] += lastWasProtect ? -2 : 2;
      continue;
    }

    // Step 3: Baton Pass scoring
    if (mv === 'Baton Pass') {
      if (turn === 1) { scores[mv] -= 2; continue; }
      const atkStage = enemyMon.boosts?.atk ?? 0;
      if (atkStage >= 3) { scores[mv] += 3; continue; }
      if (atkStage === 2) { scores[mv] += 2; continue; }
      if (atkStage === 1) { scores[mv] += 1; continue; }
      continue;
    }

    // Step 4: all other moves — 92% chance of +3
    if (!isDamaging) {
      if (Math.random() < 0.92) scores[mv] += 3;
    }
  }
  void eFaster; // suppress unused-var warning
}

/** Tag Strategy Flag — double battle partner awareness.
 *
 * Philosophy: Coordinate with partner; avoid hitting them; use synergistic moves.
 * References: gen4_trainer_ai.md.txt "Tag Strategy Flag" section
 * Behavior: In doubles, avoid partner-targeting moves; boost moves benefiting partner.
 */
function applyTagStrategyFlag(
  scores: Record<string, number>,
  moves: string[],
  enemyMon: BattleMon,
  playerMon: BattleMon,
  field: Field,
  fieldState: FieldState,
): void {
  const inDoubles = Boolean(fieldState.isDoubleBattle);
  const hasPartner = fieldState.hasPartner ?? false;
  const partnerAbility = fieldState.partnerAbility ?? '';
  const partnerTypes = (fieldState.partnerTypes ?? []).map((type) => (
    type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()
  ));
  const partnerHasFlying = partnerTypes.includes('Flying');
  const partnerHasElectric = partnerTypes.includes('Electric');
  const partnerIsMonoElectric = partnerTypes.length === 1 && partnerHasElectric;
  const partnerMagnetRise = Boolean(fieldState.partnerMagnetRise);

  for (const mv of moves) {
    if (inDoubles) {
      if (mv === 'Skill Swap') {
        let partnerTargetingDelta = 0;
        if (!hasPartner) {
          partnerTargetingDelta -= 30;
        } else {
          if (partnerAbility === 'Truant' || partnerAbility === 'Slow Start') {
            partnerTargetingDelta += 10;
          }
          if (enemyMon.ability === 'Levitate' && partnerHasElectric) {
            partnerTargetingDelta += 1;
            if (partnerIsMonoElectric) partnerTargetingDelta += 1;
          }
          if (partnerTargetingDelta === 0) partnerTargetingDelta -= 30;
        }
        scores[mv] += partnerTargetingDelta;
      }

      if (mv === 'Earthquake' || mv === 'Magnitude') {
        if (partnerAbility === 'Levitate' || partnerHasFlying || partnerMagnetRise) {
          scores[mv] += 2;
        } else {
          scores[mv] -= 10;
        }
      }

      if (mv === 'Surf') {
        const partnerHasWaterAbsorb = partnerAbility === 'Water Absorb';
        const partnerHasDrySkin = partnerAbility === 'Dry Skin';
        if (partnerHasWaterAbsorb || partnerHasDrySkin) {
          scores[mv] += 2;
        } else {
          scores[mv] -= 10;
        }
      }
    }

    const md = getMoveEntry(mv);
    const isDamaging = md ? md.category !== 'Status' : false;
    if (!isDamaging) continue;

    // Effectiveness modifier: not-very-effective
    try {
      const atk = makePokemon(enemyMon);
      const def = makePokemon(playerMon);
      const smgMove = new Move(4, mv);
      const result = calculate(4, atk, def, smgMove, field);
      const rolls = result.damage as number[];
      if (!Array.isArray(rolls) || rolls.length === 0) continue;
      // rough effectiveness guess from damage ratio
      const maxRoll = rolls[rolls.length - 1];
      const midRoll = (rolls[0] + rolls[rolls.length - 1]) / 2;
      const defHP = Math.round((playerMon.hpPercent / 100) * 100); // normalized

      // Priority +1 moves: 80.5% chance of +1
      if (PRIORITY_PLUS_ONE_MOVES.has(mv)) {
        if (Math.random() < 0.805) scores[mv] += 1;
      } else {
        // 50% chance of +1 if highest damage
        if (Math.random() < 0.5) scores[mv] += 1;
      }

      // If KO on max roll: slight boost
      if (maxRoll > 0 && maxRoll >= defHP) {
        scores[mv] += 2;
      }

      void midRoll; // suppress unused-var warning
    } catch { /* ignore */ }
  }
}

/** Check HP Flag — HP-dependent phase adjustments.
 *
 * Philosophy: Adjust move selection based on attacker and target HP percentages.
 * References: gen4_trainer_ai.md.txt "Check HP Flag" section
 * Behavior: Phase 1 (user HP) and Phase 2 (target HP) with specific thresholds.
 */
function applyCheckHPFlag(
  scores: Record<string, number>,
  moves: string[],
  enemyMon: BattleMon,
  playerMon: BattleMon,
): void {
  const eHP = enemyMon.hpPercent;
  const pHP = playerMon.hpPercent;

  for (const mv of moves) {
    // ── Phase 1: Attacker's HP ─────────────────────────────────────────────

    // Self-Destruct / Explosion: if >= 31% → 80.5% chance -2
    if (SELFDESTRUCT_MOVES.has(mv)) {
      if (eHP >= 31 && Math.random() < 0.805) scores[mv] += -2;
    }

    // Recovery / Rest / Destiny Bond / Flail / Reversal / Memento / Healing Wish / Lunar Dance
    if (
      RECOVERY_MOVES.has(mv) || mv === 'Rest' || mv === 'Destiny Bond' ||
      mv === 'Flail' || mv === 'Reversal' || mv === 'Memento' ||
      mv === 'Healing Wish' || mv === 'Lunar Dance'
    ) {
      if (eHP >= 71 && Math.random() < 0.805) scores[mv] += -2;
    }

    // Stat-boosting/reducing moves and setup at < 70% HP → 80.5% chance -2
    if (
      ATTACK_BOOST_MOVES.has(mv) || SPEED_BOOST_MOVES.has(mv) ||
      DUAL_BOOST_MOVES.has(mv) || EVASION_BOOST_MOVES.has(mv) ||
      mv === 'Focus Energy' || mv === 'Bide' || mv === 'Conversion' ||
      mv === 'Light Screen' || mv === 'Reflect' || mv === 'Mist' ||
      mv === 'Safeguard' || mv === 'Belly Drum'
    ) {
      if (eHP < 70 && Math.random() < 0.805) scores[mv] += -2;
    }

    // Low-priority HP moves: if <= 30% → 80.5% chance -2
    if (
      mv === 'Lock On' || mv === 'Psych Up' || mv === 'Mirror Coat' ||
      mv === 'Metal Burst' || mv === 'Water Spout' || mv === 'Eruption' ||
      mv === 'Mud Sport' || mv === 'Water Sport' || mv === 'Acupressure'
    ) {
      if (eHP <= 30 && Math.random() < 0.805) scores[mv] += -2;
    }

    // ── Phase 2: Target's HP ────────────────────────────────────────────────
    // Exit early if target HP > 71%
    if (pHP > 71) continue;

    // Stat-modifying moves and hazards → 80.5% chance -2
    if (
      isStatusMove(mv) && (
        POISON_MOVES.has(mv) || PARALYSIS_MOVES.has(mv) || BURN_MOVES.has(mv) ||
        mv === 'Mist' || mv === 'Safeguard' || mv === 'Pain Split' ||
        mv === 'Acupressure' || mv === 'Perish Song'
      )
    ) {
      if (Math.random() < 0.805) scores[mv] += -2;
    }

    // Status/OHKO/misc at <= 30% target HP → 80.5% chance -2
    if (pHP <= 30) {
      if (
        SLEEP_MOVES.has(mv) || CONFUSE_MOVES.has(mv) ||
        mv === 'Horn Drill' || mv === 'Fissure' || mv === 'Sheer Cold' || mv === 'Guillotine' ||
        SELFDESTRUCT_MOVES.has(mv)
      ) {
        if (Math.random() < 0.805) scores[mv] += -2;
      }
    }
  }
}

/** Weather Flag — establish weather advantage on turn 1.
 *
 * Philosophy: Set beneficial weather early if not already active.
 * References: gen4_trainer_ai.md.txt "Weather Flag" section
 * Behavior: On turn 1 only, +5 to weather-setting moves if weather not active.
 * Note: This flag only executes on turn 1 (potential game bug replicated here).
 */
function applyWeatherFlag(
  scores: Record<string, number>,
  moves: string[],
  enemyMon: BattleMon,
  fieldState: FieldState,
): void {
  // The doc says this flag exits if it is not turn 1 (appears to be a bug in
  // the original script, but we replicate the behaviour).
  if ((fieldState.turnNumber ?? 1) !== 1) return;

  const currentWeather = fieldState.weather ?? '';
  for (const mv of moves) {
    const targetWeather = WEATHER_MOVES[mv];
    if (targetWeather && targetWeather !== currentWeather) {
      scores[mv] += 5;
    }
  }
  void enemyMon; // suppress unused-var warning
}

/** Harassment Flag — favor disruptive non-damaging moves.
 *
 * Philosophy: Emphasize status conditions, stat reductions, and field disruption.
 * References: gen4_trainer_ai.md.txt "Harassment Flag" section
 * Behavior: 50% chance of +2 for moves in HARASSMENT_MOVES set.
 */
function applyHarassmentFlag(
  scores: Record<string, number>,
  moves: string[],
): void {
  for (const mv of moves) {
    if (HARASSMENT_MOVES.has(mv)) {
      if (Math.random() < 0.5) scores[mv] += 2;
    }
  }
}

/** Prioritize Status Flag — Kaizo extension encouraging status moves.
 *
 * Philosophy: Additional emphasis on status-inflicting moves (Kaizo romhack feature).
 * Behavior: +2 to sleep/poison/paralysis/burn moves if target has no status.
 */
function applyStatusFlag(
  scores: Record<string, number>,
  moves: string[],
  playerMon: BattleMon,
): void {
  if (playerMon.status) return; // target already statused — no benefit
  for (const mv of moves) {
    if (SLEEP_MOVES.has(mv) || POISON_MOVES.has(mv) ||
        PARALYSIS_MOVES.has(mv) || BURN_MOVES.has(mv)) {
      scores[mv] += 2;
    }
  }
}

function applyFogModifier(
  scores: Record<string, number>,
  moves: string[],
): void {
  for (const mv of moves) {
    const md = getMoveEntry(mv);
    if (!md || md.category === 'Status') continue;
    const accuracy = (md as unknown as { accuracy?: number }).accuracy;
    if (typeof accuracy === 'number' && accuracy < 100) {
      scores[mv] -= 1;
    }
  }
}

// Keep these references so TypeScript noUnusedLocals remains satisfied while legacy
// per-flag scorers stay in file for comparison/regression fallback purposes.
const legacyFlagScorers = [
  applyBasicFlag,
  applyEvalAttFlag,
  applyExpertFlag,
  applySetupFirstTurnFlag,
  applyRiskyFlag,
  applyPrioritizeExtremesFlag,
  applyBatonPassFlag,
  applyTagStrategyFlag,
  applyCheckHPFlag,
  applyWeatherFlag,
  applyHarassmentFlag,
  applyStatusFlag,
  applyFogModifier,
];
void legacyFlagScorers;

// Keep helper references used by the old predictor path for quick regression fallback.
// They remain intentionally available while this refactor is iterated in UI tests.
const legacyPredictorHelpers = [
  isMoveImmune,
  getMinDamage,
  getMoveAccuracyMultiplier,
  hasMoveDrawback,
  isStatusMoveRedundant,
  isSetupRedundant,
  isStatusOrSetupMove,
  playerCanLikelyKoThisTurn,
];
void legacyPredictorHelpers;

// ────────────────────────────────────────────────────────────────────────────
// Main export
// ────────────────────────────────────────────────────────────────────────────

/**
 * Predict the probability distribution over the enemy's moves.
 *
 * @param playerMon  The player's active Pokémon
 * @param enemyMon   The enemy's active Pokémon
 * @param fieldState Current field conditions
 * @param aiFlags    AI behaviour flags assigned to this trainer (currently informational)
 */
export function predictEnemyMove(
  playerMon: BattleMon,
  enemyMon: BattleMon,
  fieldState: FieldState,
  aiFlags: AIFlags = {},
): MoveProbability[] {
  const moves = enemyMon.moves.filter(Boolean);
  if (moves.length === 0) return [];

  const field = new Field({
    weather: fieldState.weather as never,
  });
  const result = calculateMoveProbabilities(playerMon, enemyMon, field, aiFlags, fieldState);
  return moves.map((mv) => {
    const probability = result.probabilities[mv] ?? 0;
    return {
      move: mv,
      score: parseFloat(probability.toFixed(2)),
      probability: parseFloat(probability.toFixed(1)),
      breakdown: [
        `Monte Carlo Simulations: ${MONTE_CARLO_ITERATIONS}`,
        `Win Probability: ${parseFloat(probability.toFixed(1))}%`,
      ],
    };
  }).sort((a, b) => b.probability - a.probability);
}

interface CalculateMoveProbabilitiesResult {
  probabilities: MoveProbabilityMap;
  deterministicDeltas: Record<string, {
    basic: number;
    eval_att: number;
    expert: number;
    setup_first_turn: number;
    risky: number;
    damage_prio: number;
    baton_pass: number;
    tag_strategy: number;
    check_hp: number;
    weather: number;
    harassment: number;
    status: number;
    fog: number;
  }>;
  expertExpectedDelta: Record<string, number>;
}

export function calculateMoveProbabilities(
  playerMon: BattleMon,
  enemyMon: BattleMon,
  field: Field,
  aiFlags: AIFlags = {},
  fieldState: FieldState = {},
): CalculateMoveProbabilitiesResult {
  const moves = enemyMon.moves.filter(Boolean);
  const deterministicDeltas: CalculateMoveProbabilitiesResult['deterministicDeltas'] = Object.fromEntries(
    moves.map((mv) => [mv, {
      basic: 0,
      eval_att: 0,
      expert: 0,
      setup_first_turn: 0,
      risky: 0,
      damage_prio: 0,
      baton_pass: 0,
      tag_strategy: 0,
      check_hp: 0,
      weather: 0,
      harassment: 0,
      status: 0,
      fog: 0,
    }]),
  );
  const winCounts: Record<string, number> = Object.fromEntries(moves.map((mv) => [mv, 0]));

  const effectiveFieldState: FieldState = {
    ...fieldState,
    isDoubleBattle: (fieldState.isDoubleBattle ?? false) || Boolean(aiFlags.double_battle),
    isTrickRoom: fieldState.isTrickRoom ?? false,
  };

  for (let i = 0; i < MONTE_CARLO_ITERATIONS; i += 1) {
    const trialScores: Record<string, number> = Object.fromEntries(moves.map((mv) => [mv, 100]));

    if (aiFlags.basic) {
      applyBasicFlag(
        trialScores,
        moves,
        enemyMon,
        playerMon,
        field,
        effectiveFieldState,
        Boolean(effectiveFieldState.isTrickRoom),
      );
    }

    if (aiFlags.eval_att) {
      applyEvalAttFlag(trialScores, moves, enemyMon, playerMon, field);
    }

    if (aiFlags.expert) {
      applyExpertFlag(trialScores, moves, enemyMon, playerMon, effectiveFieldState);
    }

    if (aiFlags.setup_first_turn) {
      applySetupFirstTurnFlag(trialScores, moves, effectiveFieldState);
    }

    if (aiFlags.risky) {
      applyRiskyFlag(trialScores, moves);
    }

    if (aiFlags.damage_prio) {
      applyPrioritizeExtremesFlag(trialScores, moves);
    }

    if (aiFlags.baton_pass) {
      applyBatonPassFlag(trialScores, moves, enemyMon, effectiveFieldState);
    }

    if (aiFlags.tag_strategy) {
      applyTagStrategyFlag(trialScores, moves, enemyMon, playerMon, field, effectiveFieldState);
    }

    if (aiFlags.check_hp) {
      applyCheckHPFlag(trialScores, moves, enemyMon, playerMon);
    }

    if (aiFlags.weather) {
      applyWeatherFlag(trialScores, moves, enemyMon, effectiveFieldState);
    }

    if (aiFlags.harassment) {
      applyHarassmentFlag(trialScores, moves);
    }

    if (aiFlags.status) {
      applyStatusFlag(trialScores, moves, playerMon);
    }

    if (effectiveFieldState.hasFog) {
      applyFogModifier(trialScores, moves);
    }

    const winner = pickWinningMove(moves, trialScores, true);
    if (winner) winCounts[winner] += 1;
  }

  const probabilities: MoveProbabilityMap = Object.fromEntries(moves.map((mv) => [mv, 0]));
  const expertExpectedDelta: Record<string, number> = Object.fromEntries(moves.map((mv) => [mv, 0]));

  for (const mv of moves) {
    const pct = (winCounts[mv] / MONTE_CARLO_ITERATIONS) * 100;
    probabilities[mv] = parseFloat(pct.toFixed(6));
  }

  return { probabilities, deterministicDeltas, expertExpectedDelta };
}

function pickWinningMove(moves: string[], scores: Record<string, number>, breakTiesRandomly = false): string | null {
  if (moves.length === 0) return null;
  let topScore = Number.NEGATIVE_INFINITY;
  const tied: string[] = [];
  for (let i = 0; i < moves.length; i += 1) {
    const mv = moves[i];
    const score = scores[mv] ?? Number.NEGATIVE_INFINITY;
    if (score > topScore) {
      topScore = score;
      tied.length = 0;
      tied.push(mv);
    } else if (score === topScore) {
      tied.push(mv);
    }
  }
  if (tied.length === 0) return null;
  if (!breakTiesRandomly) return tied[0];
  return tied[Math.floor(Math.random() * tied.length)];
}
