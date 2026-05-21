import { memo, useCallback, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import { calculate, Field, Move, Pokemon } from '@smogon/calc'
import { predictEnemyMove, type AIFlags, type BattleMon, type FieldState } from './engine/aiPredictor'
import { calculateNextSwitchDecision } from './engine/switchAI'
import trainerDb from '../../data/trainer_db.json'
import kaizoRaw from '../../data/kaizo_data.json'
import './App.css'

type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe'
type BoostKey = Exclude<StatKey, 'hp'>
type StatusCode = '' | 'slp' | 'psn' | 'brn' | 'frz' | 'par' | 'tox'

type StatSpread = Record<StatKey, number>
type BoostSpread = Record<BoostKey, number>

interface PartyMon {
  source: 'party' | 'box'
  slot: number
  box?: number
  species: string
  level: number
  nature: string
  ability: string
  item: string
  hp?: number
  max_hp?: number
  evs: Record<string, number>
  ivs: Record<string, number>
  moves: string[]
}

interface TrainerPokemon {
  slot: number
  level: number
  species: string
  nature: string | null
  ability: string | null
  item: string | null
  moves: string[]
}

interface TrainerEntry {
  name: string
  split?: string
  ai_flags: string[]
  pokemon: TrainerPokemon[]
}

type TrainerDbBySplit = Record<string, TrainerEntry[]>
type TrainerOption = { key: string; split: string; trainer: TrainerEntry }

const TRAINER_SPLITS = ['Roark', 'Gardenia', 'Fantina', 'Maylene', 'Wake', 'Byron', 'Candice', 'Volkner', 'Galactic', 'Elite Four'] as const
const DEFAULT_SPLIT = TRAINER_SPLITS[0]

interface KaizoPokemon {
  id: number
  hp: number
  attack: number
  defense: number
  sp_atk: number
  sp_def: number
  speed: number
  type1: string
  type2?: string | null
  ability1?: string | null
  ability2?: string | null
  uncommon_item?: string | null
  rare_item?: string | null
}

interface KaizoMove {
  id: number
  category: 'Physical' | 'Special' | 'Status'
  power: number
  type: string
  accuracy: number
  pp: number
}

interface KaizoData {
  pokemon: Record<string, KaizoPokemon>
  moves: Record<string, KaizoMove>
  items: string[]
}

interface EditableMon {
  species: string
  level: number
  nature: string
  ability: string
  item: string
  status: StatusCode
  hp: number
  maxHp: number
  evs: StatSpread
  ivs: StatSpread
  boosts: BoostSpread
  moves: string[]
  moveBpOverrides: Array<number | undefined>
}

interface CalcResult {
  description: string
  range: string
}

type DamageSourceSide = 'player' | 'enemy'

interface FieldUiState {
  weather: '' | 'sun' | 'rain' | 'sand' | 'hail'
  terrain: '' | 'electric' | 'grassy' | 'misty' | 'psychic'
  gravity: boolean
  spikes: 0 | 1 | 2 | 3
  stealthRock: boolean
  reflect: boolean
  lightScreen: boolean
  trickRoom: boolean
  fog: boolean
  partnerPresent: boolean
  partnerHpPercent: number
  partnerAbility: string
  partnerType1: string
  partnerType2: string
  partnerMagnetRise: boolean
  partnerStatus: 'unknown' | 'healthy' | 'fainted' | 'statused'
  turnNumber: number
  battleMode: 'singles' | 'doubles'
}

const STAT_ROWS: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']

const STAT_LABELS: Record<StatKey, string> = {
  hp: 'HP',
  atk: 'Attack',
  def: 'Defense',
  spa: 'Sp. Atk',
  spd: 'Sp. Def',
  spe: 'Speed',
}

const defaultEvs: StatSpread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }
const defaultIvs: StatSpread = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }
const defaultBoosts: BoostSpread = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }

const NATURE_EFFECTS: Record<string, { plus: BoostKey; minus: BoostKey }> = {
  Hardy: { plus: 'atk', minus: 'atk' },
  Lonely: { plus: 'atk', minus: 'def' },
  Brave: { plus: 'atk', minus: 'spe' },
  Adamant: { plus: 'atk', minus: 'spa' },
  Naughty: { plus: 'atk', minus: 'spd' },
  Bold: { plus: 'def', minus: 'atk' },
  Docile: { plus: 'def', minus: 'def' },
  Relaxed: { plus: 'def', minus: 'spe' },
  Impish: { plus: 'def', minus: 'spa' },
  Lax: { plus: 'def', minus: 'spd' },
  Timid: { plus: 'spe', minus: 'atk' },
  Hasty: { plus: 'spe', minus: 'def' },
  Serious: { plus: 'spe', minus: 'spe' },
  Jolly: { plus: 'spe', minus: 'spa' },
  Naive: { plus: 'spe', minus: 'spd' },
  Modest: { plus: 'spa', minus: 'atk' },
  Mild: { plus: 'spa', minus: 'def' },
  Quiet: { plus: 'spa', minus: 'spe' },
  Bashful: { plus: 'spa', minus: 'spa' },
  Rash: { plus: 'spa', minus: 'spd' },
  Calm: { plus: 'spd', minus: 'atk' },
  Gentle: { plus: 'spd', minus: 'def' },
  Sassy: { plus: 'spd', minus: 'spe' },
  Careful: { plus: 'spd', minus: 'spa' },
  Quirky: { plus: 'spd', minus: 'spd' },
}

const NATURES = Object.keys(NATURE_EFFECTS)

const kaizoData = kaizoRaw as KaizoData
const speciesOptions = Object.keys(kaizoData.pokemon).sort()
const moveOptions = Object.keys(kaizoData.moves).sort()
const TYPE_OPTIONS = ['', 'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel'] as const

const AI_FLAG_KEY_MAP: Record<string, keyof AIFlags> = {
  basic: 'basic',
  eval_att: 'eval_att',
  expert: 'expert',
  setup_first_turn: 'setup_first_turn',
  risky: 'risky',
  damage_prio: 'damage_prio',
  baton_pass: 'baton_pass',
  tag_strategy: 'tag_strategy',
  check_hp: 'check_hp',
  weather: 'weather',
  harassment: 'harassment',
  status: 'status',
  double_battle: 'double_battle',
  'Prioritize Effectiveness': 'basic',
  'Evaluate Attacks': 'eval_att',
  Expert: 'expert',
  'Setup First Turn': 'status',
  'Risky Attacks': 'risky',
  'Prioritize Damage': 'damage_prio',
  'Baton Pass': 'baton_pass',
  Partner: 'tag_strategy',
  'Tag Strategy': 'tag_strategy',
  'Prioritize Healing': 'check_hp',
  'Check HP': 'check_hp',
  'Utilize Weather': 'weather',
  Harassment: 'harassment',
  'Prioritize Status': 'status',
  Status: 'status',
  'Double Battle': 'double_battle',
}

const AI_DEBUG_FLAG_LABELS = [
  'Prioritize Effectiveness',
  'Evaluate Attacks',
  'Expert',
  'Setup First Turn',
  'Risky Attacks',
  'Prioritize Damage',
  'Baton Pass',
  'Tag Strategy',
  'Check HP',
  'Utilize Weather',
  'Harassment',
] as const

function normalizeSpeciesKey(species: string): string {
  return species.trim().toLowerCase()
}

function buildKaizoPokemonLookup(): Map<string, KaizoPokemon> {
  const lookup = new Map<string, KaizoPokemon>()

  for (const [key, value] of Object.entries(kaizoData.pokemon)) {
    lookup.set(key, value)
    lookup.set(normalizeSpeciesKey(key), value)
  }

  const aliases: Array<[string, string]> = [
    ['GIRATINA-ORIGIN', 'Giratina (O)'],
    ['GIRATINA ORIGIN', 'Giratina (O)'],
    ['GIRATINA-ORIGIN ', 'Giratina (O)'],
    ['DEOXYS-S', 'Deoxys (S)'],
    ['DEOXYS SPEED', 'Deoxys (S)'],
    ['DEOXYS-A', 'Deoxys (A)'],
    ['DEOXYS ATTACK', 'Deoxys (A)'],
    ['DEOXYS-D', 'Deoxys (D)'],
    ['DEOXYS DEFENSE', 'Deoxys (D)'],
    ['SHAYMIN-S', 'Shaymin (S)'],
    ['SHAYMIN SKY', 'Shaymin (S)'],
    ['WORMADAM-S', 'Wormadam (S)'],
    ['WORMADAM-TRASH', 'Wormadam (T)'],
    ['GIRATINA-O', 'Giratina (O)'],
  ]

  for (const [alias, canonical] of aliases) {
    const pokemon = kaizoData.pokemon[canonical]
    if (pokemon) {
      lookup.set(normalizeSpeciesKey(alias), pokemon)
      lookup.set(alias, pokemon)
    }
  }

  return lookup
}

const kaizoPokemonLookup = buildKaizoPokemonLookup()

function getKaizoPokemon(species: string): KaizoPokemon | null {
  const trimmed = species.trim()
  if (!trimmed) return null

  return (
    kaizoPokemonLookup.get(trimmed) ??
    kaizoPokemonLookup.get(normalizeSpeciesKey(trimmed)) ??
    null
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toSpread(raw: Record<string, number> | undefined, fallback: StatSpread, maxValue: number): StatSpread {
  return {
    hp: clamp(raw?.hp ?? fallback.hp, 0, maxValue),
    atk: clamp(raw?.atk ?? fallback.atk, 0, maxValue),
    def: clamp(raw?.def ?? fallback.def, 0, maxValue),
    spa: clamp(raw?.spa ?? fallback.spa, 0, maxValue),
    spd: clamp(raw?.spd ?? fallback.spd, 0, maxValue),
    spe: clamp(raw?.spe ?? fallback.spe, 0, maxValue),
  }
}

function getNatureEffect(nature: string): { plus: BoostKey; minus: BoostKey } {
  return NATURE_EFFECTS[nature] ?? NATURE_EFFECTS.Hardy
}

function getNatureModifier(nature: string, stat: StatKey): number {
  if (stat === 'hp') return 1
  const effect = getNatureEffect(nature)
  if (effect.plus === effect.minus) return 1
  if (effect.plus === stat) return 1.1
  if (effect.minus === stat) return 0.9
  return 1
}

function getBaseStat(speciesData: KaizoPokemon | null, stat: StatKey): number {
  if (!speciesData) return 0
  if (stat === 'hp') return speciesData.hp
  if (stat === 'atk') return speciesData.attack
  if (stat === 'def') return speciesData.defense
  if (stat === 'spa') return speciesData.sp_atk
  if (stat === 'spd') return speciesData.sp_def
  return speciesData.speed
}

function calcTotalStat(mon: EditableMon, speciesData: KaizoPokemon | null, stat: StatKey): number {
  const base = getBaseStat(speciesData, stat)
  if (base <= 0) return 0
  const iv = mon.ivs[stat]
  const ev = mon.evs[stat]
  if (stat === 'hp') {
    return Math.max(1, Math.floor((((2 * base + iv + Math.floor(ev / 4)) * mon.level) / 100)) + mon.level + 10)
  }
  const neutral = Math.floor((((2 * base + iv + Math.floor(ev / 4)) * mon.level) / 100)) + 5
  return Math.max(1, Math.floor(neutral * getNatureModifier(mon.nature, stat)))
}

function getSpriteUrl(species: string): string {
  const key = species.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `https://play.pokemonshowdown.com/sprites/gen4/${key}.png`
}

function createDefaultMon(): EditableMon {
  return {
    species: '',
    level: 50,
    nature: 'Hardy',
    ability: '',
    item: '',
    status: '',
    hp: 100,
    maxHp: 100,
    evs: defaultEvs,
    ivs: defaultIvs,
    boosts: defaultBoosts,
    moves: ['', '', '', ''],
    moveBpOverrides: [undefined, undefined, undefined, undefined],
  }
}

function fromImportedMon(mon: PartyMon): EditableMon {
  const hp = mon.hp ?? mon.max_hp ?? 100
  const maxHp = mon.max_hp ?? Math.max(1, hp)
  return {
    species: mon.species,
    level: clamp(mon.level, 1, 100),
    nature: mon.nature || 'Hardy',
    ability: mon.ability || '',
    item: mon.item || '',
    status: '',
    hp,
    maxHp,
    evs: toSpread(mon.evs, defaultEvs, 252),
    ivs: toSpread(mon.ivs, defaultIvs, 31),
    boosts: defaultBoosts,
    moves: [...mon.moves, '', '', '', ''].slice(0, 4),
    moveBpOverrides: [undefined, undefined, undefined, undefined],
  }
}

function fromTrainerPokemon(mon: TrainerPokemon): EditableMon {
  return {
    species: mon.species,
    level: clamp(mon.level, 1, 100),
    nature: mon.nature || 'Hardy',
    ability: mon.ability || '',
    item: mon.item || '',
    status: '',
    hp: 100,
    maxHp: 100,
    evs: defaultEvs,
    ivs: defaultIvs,
    boosts: defaultBoosts,
    moves: [...mon.moves, '', '', '', ''].slice(0, 4),
    moveBpOverrides: [undefined, undefined, undefined, undefined],
  }
}

function normalizeTrainerDb(raw: unknown): TrainerOption[] {
  if (!raw || typeof raw !== 'object') return []
  const grouped = raw as TrainerDbBySplit
  const out: TrainerOption[] = []
  const normalizeSplit = (split: string) => split.replace(/\s+Split$/i, '').trim()
  for (const [split, trainers] of Object.entries(grouped)) {
    const normalizedSplit = normalizeSplit(split)
    trainers.forEach((trainer, idx) => {
      if (trainer?.pokemon?.length) {
        out.push({ key: `${split}::${idx}`, split: normalizedSplit, trainer })
      }
    })
  }
  return out
}

function getFirstTrainerKeyForSplit(trainers: TrainerOption[], split: string): string {
  return trainers.find((trainer) => trainer.split === split)?.key ?? ''
}

function moveMeta(moveName: string): KaizoMove | null {
  return kaizoData.moves[moveName] ?? null
}

function toAIFlags(rawFlags: string[]): AIFlags {
  const mapped: AIFlags = {}
  for (const raw of rawFlags) {
    const key = AI_FLAG_KEY_MAP[raw]
    if (key) mapped[key] = true
  }
  return mapped
}

function toEffectiveTrainerFlags(rawFlags: string[], overrides: Record<string, boolean>): string[] {
  const merged = new Set([...rawFlags, ...AI_DEBUG_FLAG_LABELS])
  return [...merged].filter((flag) => {
    if (Object.prototype.hasOwnProperty.call(overrides, flag)) return overrides[flag]
    return rawFlags.includes(flag)
  })
}

function sanitizeBp(overrideBp: number | undefined, moveName: string): number {
  if (overrideBp !== undefined) return overrideBp
  return moveMeta(moveName)?.power ?? 0
}

function getHpStatusClass(currentHp: number, maxHp: number): string {
  const hpRatio = maxHp > 0 ? currentHp / maxHp : 1
  if (hpRatio < 0.2) return 'hp-critical'
  if (hpRatio < 0.5) return 'hp-warning'
  return 'hp-healthy'
}

function makePokemon(mon: EditableMon): Pokemon {
  return new Pokemon(4, mon.species, {
    level: mon.level,
    nature: mon.nature as never,
    ability: mon.ability as never,
    item: mon.item as never,
    evs: mon.evs as never,
    ivs: mon.ivs as never,
    boosts: mon.boosts as never,
    status: mon.status || undefined,
    curHP: Math.max(1, mon.hp),
  })
}

function toBattleMon(
  mon: EditableMon,
  speciesData: KaizoPokemon | null,
  isLastPokemon = false,
): BattleMon {
  return {
    species: mon.species,
    level: mon.level,
    nature: mon.nature,
    ability: mon.ability || undefined,
    item: mon.item || undefined,
    hpPercent: mon.maxHp > 0 ? (mon.hp / mon.maxHp) * 100 : 100,
    moves: mon.moves.filter(Boolean),
    evs: mon.evs,
    ivs: mon.ivs,
    boosts: mon.boosts,
    status: mon.status || undefined,
    speed: calcTotalStat(mon, speciesData, 'spe'),
    types: speciesData ? [speciesData.type1, speciesData.type2].filter(Boolean) as string[] : undefined,
    isLastPokemon,
  }
}

function calculateClassicDamage(
  attacker: EditableMon,
  defender: EditableMon,
  moveName: string,
  moveBpOverride: number | undefined,
  fieldState: FieldUiState,
): CalcResult | null {
  if (!moveName) return null
  try {
    const atk = makePokemon(attacker)
    const def = makePokemon(defender)
    const move = new Move(4, moveName)
    const bp = sanitizeBp(moveBpOverride, moveName)
    if (bp > 0) {
      ;(move as unknown as { bp?: number }).bp = bp
    }

    const field = new Field({
      weather: fieldState.weather as never,
      terrain: fieldState.terrain as never,
      isGravity: fieldState.gravity,
      isTrickRoom: fieldState.trickRoom,
      defenderSide: {
        isReflect: fieldState.reflect,
        isLightScreen: fieldState.lightScreen,
        isSR: fieldState.stealthRock,
        spikes: fieldState.spikes,
      },
    } as never)

    const result = calculate(4, atk, def, move, field)
    const damage = result.damage as number[]
    if (!Array.isArray(damage) || damage.length === 0) return null

    const lo = damage[0]
    const hi = damage[damage.length - 1]
    const maxHp = Math.max(1, defender.maxHp)
    return {
      description: result.desc(),
      range: `${lo} - ${hi} (${((lo / maxHp) * 100).toFixed(1)} - ${((hi / maxHp) * 100).toFixed(1)}%)`,
    }
  } catch {
    return null
  }
}

const StatMatrix = memo(function StatMatrix({
  mon,
  speciesData,
  onChange,
}: {
  mon: EditableMon
  speciesData: KaizoPokemon | null
  onChange: (next: EditableMon) => void
}) {
  return (
    <table className="stat-matrix">
      <thead>
        <tr>
          <th>Stat</th>
          <th>Base</th>
          <th>IV</th>
          <th>EV</th>
          <th>Total</th>
          <th>Stage</th>
        </tr>
      </thead>
      <tbody>
        {STAT_ROWS.map((stat) => {
          const total = calcTotalStat(mon, speciesData, stat)
          const isHp = stat === 'hp'
          return (
            <tr key={stat}>
              <td>{STAT_LABELS[stat]}</td>
              <td>{getBaseStat(speciesData, stat)}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={31}
                  value={mon.ivs[stat]}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    onChange({
                      ...mon,
                      ivs: { ...mon.ivs, [stat]: clamp(Number.isFinite(value) ? value : 0, 0, 31) },
                    })
                  }}
                />
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={252}
                  value={mon.evs[stat]}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    onChange({
                      ...mon,
                      evs: { ...mon.evs, [stat]: clamp(Number.isFinite(value) ? value : 0, 0, 252) },
                    })
                  }}
                />
              </td>
              <td className="stat-total">{total}</td>
              <td>
                {isHp ? (
                  <span className="stage-na">—</span>
                ) : (
                  <select
                    value={mon.boosts[stat as BoostKey]}
                    onChange={(e) => {
                      const value = Number(e.target.value)
                      onChange({
                        ...mon,
                        boosts: { ...mon.boosts, [stat]: clamp(Number.isFinite(value) ? value : 0, -6, 6) },
                      })
                    }}
                  >
                    {Array.from({ length: 13 }, (_, i) => i - 6).map((n) => (
                      <option key={n} value={n}>
                        {n > 0 ? `+${n}` : n}
                      </option>
                    ))}
                  </select>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
})

const MoveRow = memo(function MoveRow({
  mon,
  idx,
  moveName,
  isActive,
  onChange,
  onSelectMoveIndex,
  radioName,
}: {
  mon: EditableMon
  idx: number
  moveName: string
  isActive: boolean
  onChange: (next: EditableMon) => void
  onSelectMoveIndex: (idx: number) => void
  radioName: string
}) {
  const meta = moveMeta(moveName)

  return (
    <div className={isActive ? 'move-row selected' : 'move-row'}>
      <input
        className="move-radio"
        type="radio"
        name={radioName}
        checked={isActive}
        onChange={() => onSelectMoveIndex(idx)}
      />

      <select
        value={moveName}
        onChange={(e) => {
          const nextMoves = [...mon.moves]
          nextMoves[idx] = e.target.value
          onChange({ ...mon, moves: nextMoves })
        }}
      >
        <option value="">(No Move)</option>
        {moveOptions.map((mv) => (
          <option key={mv} value={mv}>
            {mv}
          </option>
        ))}
      </select>

      <input
        type="number"
        min={0}
        max={300}
        value={mon.moveBpOverrides[idx] ?? (meta?.power ?? 0)}
        onChange={(e) => {
          const value = Number(e.target.value)
          const nextBp = [...mon.moveBpOverrides]
          nextBp[idx] = clamp(Number.isFinite(value) ? value : 0, 0, 300)
          onChange({ ...mon, moveBpOverrides: nextBp })
        }}
      />

      <span className="move-name-display">{moveName || '(No Move)'}</span>
      <span className="move-meta move-type">{meta?.type ?? '—'}</span>
      <span className="move-category">{meta?.category ?? '—'}</span>
    </div>
  )
})

const MovesetPanel = memo(function MovesetPanel({
  mon,
  onChange,
  selectedForMainDamage,
  selectedMoveIndex,
  onSelectMoveIndex,
  radioName,
}: {
  mon: EditableMon
  onChange: (next: EditableMon) => void
  selectedForMainDamage: boolean
  selectedMoveIndex: number
  onSelectMoveIndex: (idx: number) => void
  radioName: string
}) {
  return (
    <div className="moveset-block">
      {mon.moves.map((moveName, idx) => {
        const isActive = selectedForMainDamage && selectedMoveIndex === idx
        return (
          <MoveRow
            key={`${idx}-${moveName}`}
            mon={mon}
            idx={idx}
            moveName={moveName}
            isActive={isActive}
            onChange={onChange}
            onSelectMoveIndex={onSelectMoveIndex}
            radioName={radioName}
          />
        )
      })}
    </div>
  )
})

const FieldConditions = memo(function FieldConditions({
  fieldState,
  setFieldState,
}: {
  fieldState: FieldUiState
  setFieldState: Dispatch<SetStateAction<FieldUiState>>
}) {
  return (
    <section className="field-card">
      <h3>Field Conditions</h3>

      <label>Weather
        <select value={fieldState.weather} onChange={(e) => setFieldState((prev) => ({ ...prev, weather: e.target.value as FieldUiState['weather'] }))}>
          <option value="">None</option>
          <option value="sun">Sun</option>
          <option value="rain">Rain</option>
          <option value="sand">Sand</option>
          <option value="hail">Hail</option>
        </select>
      </label>

      <label>Terrain
        <select value={fieldState.terrain} onChange={(e) => setFieldState((prev) => ({ ...prev, terrain: e.target.value as FieldUiState['terrain'] }))}>
          <option value="">None</option>
          <option value="electric">Electric</option>
          <option value="grassy">Grassy</option>
          <option value="misty">Misty</option>
          <option value="psychic">Psychic</option>
        </select>
      </label>

      <label>Spikes
        <select value={fieldState.spikes} onChange={(e) => setFieldState((prev) => ({ ...prev, spikes: Number(e.target.value) as 0 | 1 | 2 | 3 }))}>
          <option value={0}>0</option>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>
      </label>

      <label>Turn
        <input
          type="number"
          min={1}
          value={fieldState.turnNumber}
          onChange={(e) => setFieldState((prev) => ({ ...prev, turnNumber: Math.max(1, Number(e.target.value) || 1) }))}
        />
      </label>

      <label className="check-row"><input type="checkbox" checked={fieldState.gravity} onChange={(e) => setFieldState((prev) => ({ ...prev, gravity: e.target.checked }))} />Gravity</label>
      <label className="check-row"><input type="checkbox" checked={fieldState.stealthRock} onChange={(e) => setFieldState((prev) => ({ ...prev, stealthRock: e.target.checked }))} />Stealth Rock</label>
      <label className="check-row"><input type="checkbox" checked={fieldState.reflect} onChange={(e) => setFieldState((prev) => ({ ...prev, reflect: e.target.checked }))} />Reflect</label>
      <label className="check-row"><input type="checkbox" checked={fieldState.lightScreen} onChange={(e) => setFieldState((prev) => ({ ...prev, lightScreen: e.target.checked }))} />Light Screen</label>
      <label className="check-row"><input type="checkbox" checked={fieldState.trickRoom} onChange={(e) => setFieldState((prev) => ({ ...prev, trickRoom: e.target.checked }))} />Trick Room</label>
      <label className="check-row"><input type="checkbox" checked={fieldState.fog} onChange={(e) => setFieldState((prev) => ({ ...prev, fog: e.target.checked }))} />Fog</label>
      <label className="check-row"><input type="checkbox" checked={fieldState.partnerPresent} onChange={(e) => setFieldState((prev) => ({ ...prev, partnerPresent: e.target.checked }))} />Partner Present</label>
      <label className="check-row"><input type="checkbox" checked={fieldState.partnerMagnetRise} onChange={(e) => setFieldState((prev) => ({ ...prev, partnerMagnetRise: e.target.checked }))} />Partner Magnet Rise</label>
      <label>Partner HP %
        <input
          type="number"
          min={0}
          max={100}
          value={fieldState.partnerHpPercent}
          onChange={(e) => setFieldState((prev) => ({ ...prev, partnerHpPercent: clamp(Number(e.target.value) || 0, 0, 100) }))}
        />
      </label>
      <label>Partner Ability
        <input
          value={fieldState.partnerAbility}
          onChange={(e) => setFieldState((prev) => ({ ...prev, partnerAbility: e.target.value }))}
        />
      </label>
      <label>Partner Type 1
        <select value={fieldState.partnerType1} onChange={(e) => setFieldState((prev) => ({ ...prev, partnerType1: e.target.value }))}>
          {TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type || 'None'}</option>)}
        </select>
      </label>
      <label>Partner Type 2
        <select value={fieldState.partnerType2} onChange={(e) => setFieldState((prev) => ({ ...prev, partnerType2: e.target.value }))}>
          {TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type || 'None'}</option>)}
        </select>
      </label>
      <label>Partner Status
        <select
          value={fieldState.partnerStatus}
          onChange={(e) => setFieldState((prev) => ({ ...prev, partnerStatus: e.target.value as FieldUiState['partnerStatus'] }))}
        >
          <option value="unknown">Unknown</option>
          <option value="healthy">Healthy</option>
          <option value="fainted">Fainted</option>
          <option value="statused">Statused</option>
        </select>
      </label>
    </section>
  )
})

const OutputHub = memo(function OutputHub({
  primaryDamage,
  aiProbs,
  switchPrediction,
}: {
  primaryDamage: CalcResult | null
  aiProbs: ReturnType<typeof predictEnemyMove>
  switchPrediction: ReturnType<typeof calculateNextSwitchDecision> | null
}) {
  return (
    <section className="output-hub">
      <h3>Main Damage String</h3>
      <p className="damage-string">
        {primaryDamage?.description ?? 'Select species and moves to generate a Smogon-style damage string.'}
      </p>
      {primaryDamage && <p className="damage-range">{primaryDamage.range}</p>}

      <h3>AI Prediction</h3>
      {aiProbs.length > 0 ? (
        <div className="ai-bars">
          {aiProbs.map((row) => (
            <div key={row.move} className="ai-bar-row" title={row.breakdown.join('\n')}>
              <span className="ai-bar-label">{row.move}</span>
              <div className="ai-bar-track">
                <div
                  className={`ai-bar-fill ${row.probability >= 60 ? 'high' : row.probability >= 30 ? 'mid' : 'low'}`}
                  style={{ width: `${row.probability}%` }}
                />
              </div>
              <span className="ai-bar-score">{row.score.toFixed(1)}</span>
              <span className="ai-bar-value">{row.probability.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">No AI prediction available yet.</p>
      )}

      <h3>Next Switch Prediction</h3>
      {switchPrediction && switchPrediction.evaluations.length > 0 ? (
        <div className="switch-prediction-list">
          {switchPrediction.evaluations.map((row) => {
            const isWinner = row.partyIndex === switchPrediction.selectedPartyIndex
            return (
              <div key={`${row.species}-${row.partyIndex}`} className={isWinner ? 'switch-row winner' : 'switch-row'}>
                <span className="switch-species">{row.species}</span>
                <span>Phase 1 Score: {row.phase1Score === null ? '—' : `${row.phase1Score.toFixed(2)}x`}</span>
                <span>Phase 2 Max Damage Roll: {row.phase2MaxDamageRoll} HP</span>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="hint">No switch prediction available.</p>
      )}
    </section>
  )
})

const TopBar = memo(function TopBar({
  getRootProps,
  getInputProps,
  uploading,
  isDragActive,
  uploadError,
  battleMode,
  setFieldState,
}: {
  getRootProps: ReturnType<typeof useDropzone>['getRootProps']
  getInputProps: ReturnType<typeof useDropzone>['getInputProps']
  uploading: boolean
  isDragActive: boolean
  uploadError: string | null
  battleMode: FieldUiState['battleMode']
  setFieldState: Dispatch<SetStateAction<FieldUiState>>
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="upload-btn" type="button" {...getRootProps()}>
          <input {...getInputProps()} />
          {uploading ? 'Importing…' : isDragActive ? 'Drop save file…' : 'Import Save File (.sav)'}
        </button>
        {uploadError && <span className="topbar-error">{uploadError}</span>}
      </div>
      <div className="topbar-toggle">
        <span>Battle Mode:</span>
        <label>
          <input
            type="radio"
            checked={battleMode === 'singles'}
            onChange={() => setFieldState((prev) => ({ ...prev, battleMode: 'singles' }))}
          />
          Singles
        </label>
        <label>
          <input
            type="radio"
            checked={battleMode === 'doubles'}
            onChange={() => setFieldState((prev) => ({ ...prev, battleMode: 'doubles' }))}
          />
          Doubles
        </label>
      </div>
    </header>
  )
})

const PokemonPanel = memo(function PokemonPanel({
  title,
  spriteSpecies,
  spriteFallback,
  children,
}: {
  title: string
  spriteSpecies: string
  spriteFallback: string
  children: ReactNode
}) {
  return (
    <section className="calc-card">
      <div className="card-header">
        <img className="sprite" src={getSpriteUrl(spriteSpecies || spriteFallback)} alt={`${title} sprite`} />
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  )
})

export default function App() {
  const trainerOptions = useMemo(() => normalizeTrainerDb(trainerDb), [])
  const trainerByKey = useMemo(() => new Map(trainerOptions.map((t) => [t.key, t])), [trainerOptions])

  const [partyMons, setPartyMons] = useState<PartyMon[]>([])
  const [boxMons, setBoxMons] = useState<PartyMon[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [playerMon, setPlayerMon] = useState<EditableMon>(createDefaultMon())
  const [activeSplit, setActiveSplit] = useState<string>(DEFAULT_SPLIT)
  const [trainerKey, setTrainerKey] = useState(() => getFirstTrainerKeyForSplit(trainerOptions, DEFAULT_SPLIT))
  const [enemySlot, setEnemySlot] = useState(0)
  const [aiFlagOverrides, setAiFlagOverrides] = useState<Record<string, boolean>>({})
  const [showAiFlagEditor, setShowAiFlagEditor] = useState(false)
  const [mainDamageSelection, setMainDamageSelection] = useState<{ side: DamageSourceSide; idx: number }>({
    side: 'player',
    idx: 0,
  })
  const filteredTrainers = useMemo(
    () => trainerOptions.filter((trainer) => trainer.split === activeSplit),
    [trainerOptions, activeSplit],
  )

  const initialTrainer = trainerByKey.get(trainerKey)?.trainer
  const initialEnemy = initialTrainer?.pokemon[0] ? fromTrainerPokemon(initialTrainer.pokemon[0]) : createDefaultMon()
  const [enemyMon, setEnemyMon] = useState<EditableMon>(initialEnemy)
  const trainer = trainerByKey.get(trainerKey)?.trainer

  const selectTrainer = useCallback((key: string) => {
    if (!key) {
      setTrainerKey('')
      setAiFlagOverrides({})
      setEnemySlot(0)
      setEnemyMon(createDefaultMon())
      return
    }

    const nextTrainer = trainerByKey.get(key)?.trainer
    setTrainerKey(key)
    setAiFlagOverrides({})
    setEnemySlot(0)
    if (nextTrainer?.pokemon?.[0]) {
      setEnemyMon(fromTrainerPokemon(nextTrainer.pokemon[0]))
      return
    }
    setEnemyMon(createDefaultMon())
  }, [trainerByKey])

  const [fieldState, setFieldState] = useState<FieldUiState>({
    weather: '',
    terrain: '',
    gravity: false,
    spikes: 0,
    stealthRock: false,
    reflect: false,
    lightScreen: false,
    trickRoom: false,
    fog: false,
    partnerPresent: false,
    partnerHpPercent: 100,
    partnerAbility: '',
    partnerType1: '',
    partnerType2: '',
    partnerMagnetRise: false,
    partnerStatus: 'unknown',
    turnNumber: 1,
    battleMode: 'singles',
  })

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)

    try {
      const form = new FormData()
      form.append('save', file)
      const { data } = await axios.post<{ party: PartyMon[]; boxes: PartyMon[] }>(
        'http://localhost:5000/api/upload-save',
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      setPartyMons(data.party ?? [])
      setBoxMons(data.boxes ?? [])
      if (data.party?.[0]) setPlayerMon(fromImportedMon(data.party[0]))
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) && err.response?.data?.error
        ? err.response.data.error
        : 'Upload failed – is the Flask server running?'
      setUploadError(msg)
    } finally {
      setUploading(false)
    }
  }, [])

  const saveAiFlags = useCallback(async () => {
    if (!trainer) return

    // Rebuild the stored short-key flag list from the visible checkbox state.
    // This lets unchecking a flag remove it from trainer_db.json permanently.
    const visibleFlagKeys = AI_DEBUG_FLAG_LABELS.map((label) => AI_FLAG_KEY_MAP[label]).filter(Boolean) as string[]
    const visibleFlagSet = new Set(visibleFlagKeys)
    const persistedFlags = new Set<string>()

    for (const flag of trainer.ai_flags ?? []) {
      if (!visibleFlagSet.has(flag)) {
        persistedFlags.add(flag)
      }
    }

    for (const label of AI_DEBUG_FLAG_LABELS) {
      const mapped = AI_FLAG_KEY_MAP[label]
      if (!mapped) continue
      const checked = Object.prototype.hasOwnProperty.call(aiFlagOverrides, label)
        ? aiFlagOverrides[label]
        : (trainer.ai_flags ?? []).includes(mapped)
      if (checked) {
        persistedFlags.add(mapped)
      } else {
        persistedFlags.delete(mapped)
      }
    }

    const effectiveFlags = [...persistedFlags]

    try {
      const response = await axios.post(
        'http://localhost:5000/api/save-trainer-flags',
        {
          trainerName: trainer.name,
          trainerSplit: trainer.split,
          aiFlags: effectiveFlags,
        }
      )

      if (response.status === 200) {
        setAiFlagOverrides({})
        alert(`Saved AI flags for ${trainer.name}`)
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) && err.response?.data?.error
        ? err.response.data.error
        : 'Failed to save AI flags'
      alert(`Error: ${msg}`)
    }
  }, [trainer, aiFlagOverrides])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/octet-stream': ['.sav', '.dsv'] },
    multiple: false,
  })

  const enemyRoster = useMemo(() => trainer?.pokemon ?? [], [trainer?.pokemon])

  const playerSpeciesData = useMemo(
    () => getKaizoPokemon(playerMon.species),
    [playerMon.species],
  )

  const enemySpeciesData = useMemo(
    () => getKaizoPokemon(enemyMon.species),
    [enemyMon.species],
  )

  const playerMaxHp = useMemo(() => calcTotalStat(playerMon, playerSpeciesData, 'hp'), [playerMon, playerSpeciesData])
  const enemyMaxHp = useMemo(() => calcTotalStat(enemyMon, enemySpeciesData, 'hp'), [enemyMon, enemySpeciesData])

  const normalizedPlayer = useMemo(() => ({
    ...playerMon,
    maxHp: playerMaxHp,
    hp: clamp(playerMon.hp, 0, playerMaxHp || 1),
  }), [playerMon, playerMaxHp])

  const normalizedEnemy = useMemo(() => ({
    ...enemyMon,
    maxHp: enemyMaxHp,
    hp: clamp(enemyMon.hp, 0, enemyMaxHp || 1),
  }), [enemyMon, enemyMaxHp])
  const playerHpClass = getHpStatusClass(normalizedPlayer.hp, normalizedPlayer.maxHp)
  const enemyHpClass = getHpStatusClass(normalizedEnemy.hp, normalizedEnemy.maxHp)

  const playerAbilityOptions = useMemo(() => {
    const options = [playerSpeciesData?.ability1, playerSpeciesData?.ability2].filter(Boolean) as string[]
    return [...new Set(options)]
  }, [playerSpeciesData])

  const enemyAbilityOptions = useMemo(() => {
    const options = [enemySpeciesData?.ability1, enemySpeciesData?.ability2].filter(Boolean) as string[]
    return [...new Set(options)]
  }, [enemySpeciesData])

  const allItemOptions = useMemo(() => kaizoData.items, [])

  const importChoices = partyMons.length > 0 ? partyMons.slice(0, 6) : [...partyMons, ...boxMons].slice(0, 6)

  const primaryDamage = useMemo(() => {
    const attacker = mainDamageSelection.side === 'player' ? normalizedPlayer : normalizedEnemy
    const defender = mainDamageSelection.side === 'player' ? normalizedEnemy : normalizedPlayer
    const selectedMoveName = attacker.moves[mainDamageSelection.idx]
    const moveIdx = selectedMoveName ? mainDamageSelection.idx : attacker.moves.findIndex(Boolean)
    if (moveIdx === -1) return null
    return calculateClassicDamage(
      attacker,
      defender,
      attacker.moves[moveIdx],
      attacker.moveBpOverrides[moveIdx],
      fieldState,
    )
  }, [mainDamageSelection, normalizedPlayer, normalizedEnemy, fieldState])

  const aiProbs = useMemo(() => {
    if (!normalizedEnemy.species || !normalizedPlayer.species) return []

    const playerBattleMon = toBattleMon(normalizedPlayer, playerSpeciesData)
    const enemyBattleMon = toBattleMon(normalizedEnemy, enemySpeciesData, enemySlot === enemyRoster.length - 1)

    const trainerFlags = trainer?.ai_flags ?? []
    const effectiveTrainerFlags = toEffectiveTrainerFlags(trainerFlags, aiFlagOverrides)
    if (trainer && effectiveTrainerFlags.length === 0) {
      console.warn('[AI Predictor] Trainer has no AI flags', { trainer: trainer.name })
    }
    const flags = toAIFlags(effectiveTrainerFlags)
    if (effectiveTrainerFlags.length > 0 && Object.keys(flags).length === 0) {
      console.warn('[AI Predictor] No recognized AI flags after mapping', { effectiveTrainerFlags })
    }
    const aiFieldState: FieldState = {
      weather: fieldState.weather,
      isTrickRoom: fieldState.trickRoom,
      turnNumber: fieldState.turnNumber,
      isDoubleBattle: fieldState.battleMode === 'doubles',
      hasFog: fieldState.fog,
      hasPartner: fieldState.partnerPresent,
      partnerHpPercent: fieldState.partnerHpPercent,
      partnerAbility: fieldState.partnerAbility || undefined,
      partnerTypes: [fieldState.partnerType1, fieldState.partnerType2].filter(Boolean),
      partnerMagnetRise: fieldState.partnerMagnetRise,
      partnerStatus: fieldState.partnerStatus,
    }
    if (!Number.isFinite(playerBattleMon.hpPercent) || !Number.isFinite(enemyBattleMon.hpPercent)) {
      console.warn('[AI Predictor] Invalid HP inputs', {
        playerHpPercent: playerBattleMon.hpPercent,
        enemyHpPercent: enemyBattleMon.hpPercent,
      })
    }

    return predictEnemyMove(playerBattleMon, enemyBattleMon, aiFieldState, flags)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 4)
  }, [
    normalizedEnemy,
    normalizedPlayer,
    playerSpeciesData,
    enemySpeciesData,
    trainer,
    fieldState.weather,
    fieldState.trickRoom,
    fieldState.fog,
    fieldState.partnerPresent,
    fieldState.partnerHpPercent,
    fieldState.partnerAbility,
    fieldState.partnerType1,
    fieldState.partnerType2,
    fieldState.partnerMagnetRise,
    fieldState.partnerStatus,
    fieldState.turnNumber,
    fieldState.battleMode,
    enemySlot,
    enemyRoster.length,
    aiFlagOverrides,
  ])

  const switchPrediction = useMemo(() => {
    if (!normalizedEnemy.species || !normalizedPlayer.species || enemyRoster.length <= 1) return null

    const playerBattleMon = toBattleMon(normalizedPlayer, playerSpeciesData)
    const deadPokemon = toBattleMon(normalizedEnemy, enemySpeciesData)
    const aiParty = enemyRoster
      .map((partyMon, idx) => {
        if (idx === enemySlot) return null
        const editable = fromTrainerPokemon(partyMon)
        const data = getKaizoPokemon(editable.species)
        return toBattleMon(editable, data, idx === enemyRoster.length - 1)
      })
      .filter(Boolean) as BattleMon[]

    const aiFieldState: FieldState = {
      weather: fieldState.weather,
      isTrickRoom: fieldState.trickRoom,
      turnNumber: fieldState.turnNumber,
      isDoubleBattle: fieldState.battleMode === 'doubles',
      hasFog: fieldState.fog,
      hasPartner: fieldState.partnerPresent,
      partnerHpPercent: fieldState.partnerHpPercent,
      partnerAbility: fieldState.partnerAbility || undefined,
      partnerTypes: [fieldState.partnerType1, fieldState.partnerType2].filter(Boolean),
      partnerMagnetRise: fieldState.partnerMagnetRise,
      partnerStatus: fieldState.partnerStatus,
    }
    return calculateNextSwitchDecision(deadPokemon, aiParty, playerBattleMon, aiFieldState)
  }, [
    normalizedEnemy,
    normalizedPlayer,
    enemyRoster,
    enemySlot,
    enemySpeciesData,
    playerSpeciesData,
    fieldState.weather,
    fieldState.trickRoom,
    fieldState.turnNumber,
    fieldState.battleMode,
    fieldState.fog,
    fieldState.partnerPresent,
    fieldState.partnerHpPercent,
    fieldState.partnerAbility,
    fieldState.partnerType1,
    fieldState.partnerType2,
    fieldState.partnerMagnetRise,
    fieldState.partnerStatus,
  ])

  return (
    <div className="classic-app">
      <TopBar
        getRootProps={getRootProps}
        getInputProps={getInputProps}
        uploading={uploading}
        isDragActive={isDragActive}
        uploadError={uploadError}
        battleMode={fieldState.battleMode}
        setFieldState={setFieldState}
      />

      <main className="main-grid">
        <PokemonPanel title="Player Pokémon" spriteSpecies={normalizedPlayer.species} spriteFallback="pikachu">

          {importChoices.length > 0 && (
            <div className="import-strip">
              <span>Imported roster:</span>
              <div className="import-buttons">
                {importChoices.map((mon, idx) => (
                  <button
                    key={`${mon.source}-${mon.slot}-${idx}`}
                    type="button"
                    onClick={() => setPlayerMon(fromImportedMon(mon))}
                  >
                    {mon.species}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="attr-grid">
            <label>Species
              <select value={normalizedPlayer.species} onChange={(e) => setPlayerMon({ ...normalizedPlayer, species: e.target.value })}>
                <option value="">(Select Species)</option>
                {speciesOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>

            <label>Item
              <select value={normalizedPlayer.item} onChange={(e) => setPlayerMon({ ...normalizedPlayer, item: e.target.value })}>
                <option value="">(None)</option>
                {allItemOptions.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>

            <label>Ability
              <select value={normalizedPlayer.ability} onChange={(e) => setPlayerMon({ ...normalizedPlayer, ability: e.target.value })}>
                <option value="">(None)</option>
                {playerAbilityOptions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>

            <label>Nature
              <select value={normalizedPlayer.nature} onChange={(e) => setPlayerMon({ ...normalizedPlayer, nature: e.target.value })}>
                {NATURES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            <label>Level
              <input
                type="number"
                min={1}
                max={100}
                value={normalizedPlayer.level}
                onChange={(e) => setPlayerMon({ ...normalizedPlayer, level: clamp(Number(e.target.value) || 1, 1, 100) })}
              />
            </label>

            <label>Status
              <select value={normalizedPlayer.status} onChange={(e) => setPlayerMon({ ...normalizedPlayer, status: e.target.value as StatusCode })}>
                <option value="">Healthy</option>
                <option value="brn">Burn</option>
                <option value="frz">Freeze</option>
                <option value="par">Paralysis</option>
                <option value="psn">Poison</option>
                <option value="tox">Bad Poison</option>
                <option value="slp">Sleep</option>
              </select>
            </label>

            <label>Current HP
              <input
                className={playerHpClass}
                type="number"
                min={0}
                max={normalizedPlayer.maxHp}
                value={normalizedPlayer.hp}
                onChange={(e) => setPlayerMon({ ...normalizedPlayer, hp: clamp(Number(e.target.value) || 0, 0, normalizedPlayer.maxHp) })}
              />
            </label>

            <label>Max HP
              <input
                className={playerHpClass}
                type="number"
                min={1}
                value={normalizedPlayer.maxHp}
                onChange={(e) => setPlayerMon({ ...normalizedPlayer, maxHp: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
          </div>

          <StatMatrix mon={normalizedPlayer} speciesData={playerSpeciesData} onChange={setPlayerMon} />

          <MovesetPanel
            mon={normalizedPlayer}
            onChange={setPlayerMon}
            selectedForMainDamage={mainDamageSelection.side === 'player'}
            selectedMoveIndex={mainDamageSelection.idx}
            onSelectMoveIndex={(idx) => setMainDamageSelection({ side: 'player', idx })}
            radioName="main-damage-player"
          />

          <div className="damage-output-box">
            <h3>Damage Output</h3>
            {mainDamageSelection.side === 'player' && primaryDamage ? (
              <>
                <p className="damage-string">{primaryDamage.description}</p>
                <p className="damage-range">{primaryDamage.range}</p>
              </>
            ) : (
              <p className="hint">Select a player move radio button to view damage output.</p>
            )}
          </div>
        </PokemonPanel>

        <FieldConditions fieldState={fieldState} setFieldState={setFieldState} />

        <PokemonPanel title="Enemy Boss" spriteSpecies={normalizedEnemy.species} spriteFallback="gengar">

          <div className="split-button-row">
            {TRAINER_SPLITS.map((split) => (
              <button
                key={split}
                type="button"
                className={activeSplit === split ? 'split-toggle active' : 'split-toggle'}
                onClick={() => {
                  setActiveSplit(split)
                  const firstSplitTrainerKey = getFirstTrainerKeyForSplit(trainerOptions, split)
                  selectTrainer(firstSplitTrainerKey)
                }}
              >
                {split}
              </button>
            ))}
          </div>

          <label className="boss-picker">Boss Trainer
            <select
              value={trainerKey}
              disabled={filteredTrainers.length === 0}
              onChange={(e) => {
                selectTrainer(e.target.value)
              }}
            >
              {filteredTrainers.length === 0
                ? <option value="">No trainers in this split</option>
                : filteredTrainers.map((opt) => <option key={opt.key} value={opt.key}>{opt.trainer.name}</option>)}
            </select>
          </label>

          <div className="ai-flag-row">
            {(trainer?.ai_flags ?? []).map((flag) => (
              <span key={flag} className="flag-pill">{flag}</span>
            ))}
          </div>

          {(trainer?.ai_flags ?? []).length === 0 ? (
            <p className="ai-flag-empty-note">
              No AI flags were recorded for this trainer. Use the toggles below to set them manually.
            </p>
          ) : null}

          <div className="ai-flag-editor-shell">
            <button
              type="button"
              className="ai-flag-toggle-button"
              onClick={() => setShowAiFlagEditor((prev) => !prev)}
            >
              {showAiFlagEditor ? 'Hide AI Flags' : 'Show AI Flags'}
            </button>

            {showAiFlagEditor ? (
              <>
                <div className="ai-flag-debug">
                  {AI_DEBUG_FLAG_LABELS.map((flag) => {
                    const mappedFlag = AI_FLAG_KEY_MAP[flag]
                    const trainerHas = mappedFlag ? (trainer?.ai_flags ?? []).includes(mappedFlag) : false
                    const checked = Object.prototype.hasOwnProperty.call(aiFlagOverrides, flag)
                      ? aiFlagOverrides[flag]
                      : trainerHas
                    return (
                      <label key={flag} className="check-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setAiFlagOverrides((prev) => ({ ...prev, [flag]: e.target.checked }))}
                        />
                        {flag}
                      </label>
                    )
                  })}
                </div>

                {trainer && Object.keys(aiFlagOverrides).length > 0 ? (
                  <button
                    type="button"
                    className="save-flags-button"
                    onClick={saveAiFlags}
                  >
                    Save AI Flags for {trainer.name}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="enemy-slot-buttons">
            {enemyRoster.map((p, idx) => (
              <button
                key={`${p.species}-${idx}`}
                type="button"
                className={enemySlot === idx ? 'active' : ''}
                onClick={() => {
                  setEnemySlot(idx)
                  setEnemyMon(fromTrainerPokemon(p))
                }}
              >
                {p.species}
              </button>
            ))}
          </div>

          <div className="attr-grid">
            <label>Species
              <input value={normalizedEnemy.species} readOnly />
            </label>

            <label>Item
              <select value={normalizedEnemy.item} onChange={(e) => setEnemyMon({ ...normalizedEnemy, item: e.target.value })}>
                <option value="">(None)</option>
                {allItemOptions.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>

            <label>Ability
              <select value={normalizedEnemy.ability} onChange={(e) => setEnemyMon({ ...normalizedEnemy, ability: e.target.value })}>
                <option value="">(None)</option>
                {enemyAbilityOptions.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>

            <label>Nature
              <select value={normalizedEnemy.nature} onChange={(e) => setEnemyMon({ ...normalizedEnemy, nature: e.target.value })}>
                {NATURES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            <label>Level
              <input
                type="number"
                min={1}
                max={100}
                value={normalizedEnemy.level}
                onChange={(e) => setEnemyMon({ ...normalizedEnemy, level: clamp(Number(e.target.value) || 1, 1, 100) })}
              />
            </label>

            <label>Status
              <select value={normalizedEnemy.status} onChange={(e) => setEnemyMon({ ...normalizedEnemy, status: e.target.value as StatusCode })}>
                <option value="">Healthy</option>
                <option value="brn">Burn</option>
                <option value="frz">Freeze</option>
                <option value="par">Paralysis</option>
                <option value="psn">Poison</option>
                <option value="tox">Bad Poison</option>
                <option value="slp">Sleep</option>
              </select>
            </label>

            <label>Current HP
              <input
                className={enemyHpClass}
                type="number"
                min={0}
                max={normalizedEnemy.maxHp}
                value={normalizedEnemy.hp}
                onChange={(e) => setEnemyMon({ ...normalizedEnemy, hp: clamp(Number(e.target.value) || 0, 0, normalizedEnemy.maxHp) })}
              />
            </label>

            <label>Max HP
              <input
                className={enemyHpClass}
                type="number"
                min={1}
                value={normalizedEnemy.maxHp}
                onChange={(e) => setEnemyMon({ ...normalizedEnemy, maxHp: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
          </div>

          <StatMatrix mon={normalizedEnemy} speciesData={enemySpeciesData} onChange={setEnemyMon} />

          <div className="enemy-move-slot-list">
            {normalizedEnemy.moves.map((move, idx) => (
              <div key={`${move}-${idx}`} className="enemy-move-slot-row">
                {(() => {
                  const meta = moveMeta(move)
                  const bp = normalizedEnemy.moveBpOverrides[idx] ?? (meta?.power ?? 0)
                  return (
                    <>
                      <span className="enemy-slot-label">Slot {idx + 1}:</span>
                      <span>{move || '(No Move)'}</span>
                      <span className="enemy-slot-pipe">|</span>
                      <span>{bp || 0}</span>
                      <span className="enemy-slot-pipe">|</span>
                      <span>{meta?.type ?? '—'}</span>
                      <span className="enemy-slot-pipe">|</span>
                      <span>{meta?.category ?? '—'}</span>
                    </>
                  )
                })()}
              </div>
            ))}
          </div>

          <MovesetPanel
            mon={normalizedEnemy}
            onChange={setEnemyMon}
            selectedForMainDamage={mainDamageSelection.side === 'enemy'}
            selectedMoveIndex={mainDamageSelection.idx}
            onSelectMoveIndex={(idx) => setMainDamageSelection({ side: 'enemy', idx })}
            radioName="main-damage-enemy"
          />

          <div className="damage-output-box">
            <h3>Damage Output</h3>
            {mainDamageSelection.side === 'enemy' && primaryDamage ? (
              <>
                <p className="damage-string">{primaryDamage.description}</p>
                <p className="damage-range">{primaryDamage.range}</p>
              </>
            ) : (
              <p className="hint">Select an enemy move radio button to view damage output.</p>
            )}
          </div>
        </PokemonPanel>
      </main>

      <OutputHub primaryDamage={primaryDamage} aiProbs={aiProbs} switchPrediction={switchPrediction} />
    </div>
  )
}
