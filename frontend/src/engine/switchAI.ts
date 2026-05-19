import { calculate, Field, Generations, Move, Pokemon } from '@smogon/calc'
import type { BattleMon, FieldState } from './aiPredictor'

const gen4 = Generations.get(4)

type TypeName =
  | 'Normal' | 'Fire' | 'Water' | 'Electric' | 'Grass' | 'Ice' | 'Fighting' | 'Poison'
  | 'Ground' | 'Flying' | 'Psychic' | 'Bug' | 'Rock' | 'Ghost' | 'Dragon' | 'Dark' | 'Steel'

const TYPE_CHART: Record<TypeName, Partial<Record<TypeName, number>>> = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5, Steel: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Steel: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5 },
}

const AI_SE_BUG_EXEMPT_DEFENDER_TYPES = new Set(['Dark/Ghost', 'Dark/Poison', 'Flying/Ground'])

interface SwitchEvaluation {
  partyIndex: number
  species: string
  phase1Score: number | null
  phase2MaxDamageRoll: number
  hasSuperEffectiveMove: boolean
}

export interface SwitchDecision {
  selected: BattleMon | null
  selectedPartyIndex: number
  usedPhase: 1 | 2 | null
  evaluations: SwitchEvaluation[]
}

function normalizeType(type: string): TypeName | null {
  const normalized = `${type}`.trim()
  const cased = normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase()
  return (cased in TYPE_CHART ? cased : null) as TypeName | null
}

function moveEntry(moveName: string) {
  const key = moveName.toLowerCase().replace(/[\s'-]/g, '') as never
  return gen4.moves.get(key) ?? null
}

function getMonTypes(mon: BattleMon): TypeName[] {
  const listed = (mon.types ?? []).map(normalizeType).filter(Boolean) as TypeName[]
  if (listed.length > 0) return listed.slice(0, 2)
  try {
    const dex = gen4.species.get(mon.species.toLowerCase().replace(/[\s'-]/g, '') as never)
    const dexTypes = (dex?.types ?? []).map(normalizeType).filter(Boolean) as TypeName[]
    return dexTypes.slice(0, 2)
  } catch {
    return []
  }
}

function abilityGrantsImmunity(moveType: TypeName, defenderAbility?: string, attackerAbility?: string): boolean {
  if (!defenderAbility || attackerAbility === 'Mold Breaker') return false
  if (moveType === 'Ground' && defenderAbility === 'Levitate') return true
  if (moveType === 'Electric' && (defenderAbility === 'Volt Absorb' || defenderAbility === 'Motor Drive')) return true
  if (moveType === 'Water' && defenderAbility === 'Water Absorb') return true
  if (moveType === 'Fire' && defenderAbility === 'Flash Fire') return true
  return false
}

function typePairKey(types: TypeName[]): string {
  return [...types].sort().join('/')
}

function getSeCheckMultiplier(
  moveType: TypeName,
  defender: BattleMon,
  attackerAbility?: string,
): number {
  const defenderTypes = getMonTypes(defender)
  if (defenderTypes.length === 0) return 1
  if (abilityGrantsImmunity(moveType, defender.ability, attackerAbility)) return 0

  let multiplier = 1
  for (const defType of defenderTypes) {
    let typeMult = TYPE_CHART[moveType][defType] ?? 1
    if (
      moveType === 'Ground'
      && defType === 'Electric'
      && !AI_SE_BUG_EXEMPT_DEFENDER_TYPES.has(typePairKey(defenderTypes))
    ) {
      typeMult = 2
    }
    multiplier *= typeMult
  }
  return multiplier
}

function monHasSuperEffectiveMove(attacker: BattleMon, defender: BattleMon): boolean {
  for (const moveName of attacker.moves.filter(Boolean)) {
    const md = moveEntry(moveName)
    if (!md) continue
    const moveType = normalizeType(String(md.type ?? ''))
    if (!moveType) continue
    if (getSeCheckMultiplier(moveType, defender, attacker.ability) > 1) {
      return true
    }
  }
  return false
}

function singleTypeScoreVsDefenderTypes(attackerType: TypeName, defenderTypes: TypeName[]): number {
  const [def1, def2] = defenderTypes.length >= 2 ? defenderTypes : [defenderTypes[0], defenderTypes[0]]
  const m1 = TYPE_CHART[attackerType]?.[def1] ?? 1
  const m2 = TYPE_CHART[attackerType]?.[def2] ?? 1
  return m1 * m2
}

function phase1OffensiveTypingScore(aiMon: BattleMon, playerMon: BattleMon): number {
  const aiTypes = getMonTypes(aiMon)
  const playerTypes = getMonTypes(playerMon)
  if (aiTypes.length === 0 || playerTypes.length === 0) return 2

  const [atkType1, atkType2] = aiTypes.length >= 2 ? aiTypes : [aiTypes[0], aiTypes[0]]
  const scoreA = singleTypeScoreVsDefenderTypes(atkType1, playerTypes)
  const scoreB = singleTypeScoreVsDefenderTypes(atkType2, playerTypes)
  const combined = scoreA + scoreB
  // Gen 4 switch scorer overflow bug: "8.0" (quad + quad) is remapped by engine behavior
  // to sort between 2.0 and 1.5 tiers rather than stay as a strict max.
  return combined === 8 ? 1.75 : combined
}

function makePokemon(mon: BattleMon, forceFullHp = false): Pokemon {
  const built = new Pokemon(4, mon.species, {
    level: mon.level,
    nature: mon.nature as never,
    ability: mon.ability as never,
    item: mon.item as never,
    evs: mon.evs ?? {},
    ivs: mon.ivs ?? {},
    boosts: mon.boosts ?? {},
    status: mon.status,
  })

  if (forceFullHp) {
    const withHp = built as unknown as { rawStats?: { hp?: number }; curHP?: number }
    withHp.curHP = withHp.rawStats?.hp ?? withHp.curHP
  }
  return built
}

function getAssistStyleMoveMaxDamage(
  deadPokemon: BattleMon,
  teammateMove: string,
  playerPokemon: BattleMon,
  fieldState: FieldState,
): number {
  const md = moveEntry(teammateMove)
  if (!md || md.category === 'Status') return 0
  try {
    const attacker = makePokemon(deadPokemon)
    const defender = makePokemon(playerPokemon, true)
    const move = new Move(4, teammateMove)
    const field = new Field({
      weather: fieldState.weather as never,
      isTrickRoom: fieldState.isTrickRoom ?? false,
    } as never)
    const result = calculate(4, attacker, defender, move, field)
    const rolls = result.damage
    if (!Array.isArray(rolls) || rolls.length === 0) return 0
    const rawMax = Math.max(...(rolls as number[]))
    if (!Number.isFinite(rawMax) || rawMax <= 0) return 0
    // Gen 4 overflow behavior: assist-style max roll wraps in 8-bit byte space.
    // Engine stores this intermediate in a single byte, so values >255 roll over via modulo 256.
    return rawMax > 255 ? rawMax % 256 : rawMax
  } catch {
    return 0
  }
}

export function calculateNextSwitchDecision(
  deadPokemon: BattleMon,
  aiParty: BattleMon[],
  playerPokemon: BattleMon,
  fieldState: FieldState,
): SwitchDecision {
  const alive = aiParty
    .map((mon, idx) => ({ mon, idx }))
    .filter(({ mon }) => !!mon.species)

  if (alive.length === 0) {
    return { selected: null, selectedPartyIndex: -1, usedPhase: null, evaluations: [] }
  }

  const hasAnySeMove = alive.some(({ mon }) => monHasSuperEffectiveMove(mon, playerPokemon))

  const evaluations: SwitchEvaluation[] = alive.map(({ mon, idx }) => {
    const phase2MaxDamageRoll = mon.moves
      .filter(Boolean)
      .reduce((best, moveName) => Math.max(best, getAssistStyleMoveMaxDamage(deadPokemon, moveName, playerPokemon, fieldState)), 0)

    return {
      partyIndex: idx,
      species: mon.species,
      phase1Score: hasAnySeMove ? phase1OffensiveTypingScore(mon, playerPokemon) : null,
      phase2MaxDamageRoll,
      hasSuperEffectiveMove: monHasSuperEffectiveMove(mon, playerPokemon),
    }
  })

  if (hasAnySeMove) {
    const seCandidates = evaluations.filter((entry) => entry.hasSuperEffectiveMove)
    const winner = seCandidates.reduce((best, next) => {
      if (!best) return next
      const bestScore = best.phase1Score ?? Number.NEGATIVE_INFINITY
      const nextScore = next.phase1Score ?? Number.NEGATIVE_INFINITY
      if (nextScore > bestScore) return next
      if (nextScore === bestScore && next.partyIndex < best.partyIndex) return next
      return best
    }, null as SwitchEvaluation | null)

    return {
      selected: winner ? aiParty[winner.partyIndex] : null,
      selectedPartyIndex: winner?.partyIndex ?? -1,
      usedPhase: 1,
      evaluations,
    }
  }

  const winner = evaluations.reduce((best, next) => {
    if (!best) return next
    if (next.phase2MaxDamageRoll > best.phase2MaxDamageRoll) return next
    if (next.phase2MaxDamageRoll === best.phase2MaxDamageRoll && next.partyIndex < best.partyIndex) return next
    return best
  }, null as SwitchEvaluation | null)

  return {
    selected: winner ? aiParty[winner.partyIndex] : null,
    selectedPartyIndex: winner?.partyIndex ?? -1,
    usedPhase: 2,
    evaluations,
  }
}

export function calculateNextSwitch(
  deadPokemon: BattleMon,
  aiParty: BattleMon[],
  playerPokemon: BattleMon,
  fieldState: FieldState,
): BattleMon | null {
  return calculateNextSwitchDecision(deadPokemon, aiParty, playerPokemon, fieldState).selected
}
