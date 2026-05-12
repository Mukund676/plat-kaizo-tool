import { useState, useCallback, useMemo } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import { calculate, Pokemon, Move, Field } from '@smogon/calc'
import { predictEnemyMove, type BattleMon, type AIFlags, type FieldState } from './engine/aiPredictor'
import trainerDb from '../../data/trainer_db.json'
import kaizoRaw from '../../data/kaizo_data.json'
import './App.css'

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

interface LearnsetEntry {
  move: string
  level: number
  source?: string
  method?: 'level' | 'tm'
}

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

interface KaizoData {
  pokemon: Record<string, KaizoPokemon>
  moves: Record<string, unknown>
  learnsets: Record<string, LearnsetEntry[]>
  tm_learnsets: Record<string, string[]>
  pre_evolutions: Record<string, string[]>
  items: string[]
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
  id?: number
  name: string
  split?: string
  ai_flags: string[]
  pokemon: TrainerPokemon[]
}

type TrainerDb = Record<string, TrainerEntry>
type TrainerDbBySplit = Record<string, TrainerEntry[]>
type TrainerOption = { key: string; split: string; trainer: TrainerEntry }

type StatusCode = '' | 'slp' | 'psn' | 'brn' | 'frz' | 'par' | 'tox'

type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe'
type StatSpread = Record<StatKey, number>

interface ManualMon {
  species: string
  level: number
  nature: string
  ability: string
  item: string
  evs: StatSpread
  ivs: StatSpread
  moves: string[]
  hp: number
  maxHp: number
  status: StatusCode
}

interface DamageResult {
  label: string
  rolls: string
  range: string
}

type CalcMon = {
  species: string
  level: number
  nature?: string | null
  ability?: string | null
  item?: string | null
  evs?: Partial<StatSpread>
  ivs?: Partial<StatSpread>
  hp?: number
  max_hp?: number
}

const NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
]

const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']
const WEATHER_OPTIONS = ['', 'sun', 'rain', 'sand', 'hail'] as const

const kaizoData = kaizoRaw as KaizoData
const speciesOptions = Object.keys(kaizoData.pokemon).sort()
const moveOptions = Object.keys(kaizoData.moves).sort()

function isTrainerEntry(value: unknown): value is TrainerEntry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as TrainerEntry).pokemon) &&
    typeof (value as TrainerEntry).name === 'string',
  )
}

function normalizeTrainerDb(raw: unknown): TrainerOption[] {
  if (!raw || typeof raw !== 'object') return []
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0) return []

  const looksGrouped = entries.every(([, value]) => Array.isArray(value))
  if (looksGrouped) {
    const grouped = raw as TrainerDbBySplit
    const out: TrainerOption[] = []
    for (const [split, trainers] of Object.entries(grouped)) {
      trainers.forEach((trainer, idx) => {
        if (isTrainerEntry(trainer) && trainer.pokemon.length > 0) {
          out.push({
            key: `${split}::${idx}`,
            split,
            trainer,
          })
        }
      })
    }
    return out
  }

  const legacy = raw as TrainerDb
  return Object.entries(legacy)
    .filter(([, trainer]) => isTrainerEntry(trainer) && trainer.pokemon.length > 0)
    .map(([key, trainer]) => ({
      key,
      split: trainer.split ?? 'All Trainers',
      trainer,
    }))
}

const trainerOptions = normalizeTrainerDb(trainerDb)
const trainerKeys = trainerOptions.map((option) => option.key)
const trainerByKey = new Map(trainerOptions.map((option) => [option.key, option]))
const trainerOptionsBySplit = trainerOptions.reduce<Record<string, TrainerOption[]>>((acc, option) => {
  if (!acc[option.split]) acc[option.split] = []
  acc[option.split].push(option)
  return acc
}, {})

const defaultEvs: StatSpread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }
const defaultIvs: StatSpread = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }

function normalizeSpeciesKey(species: string): string {
  return species.trim().toUpperCase()
}

function getSpeciesLineage(species: string): string[] {
  const key = normalizeSpeciesKey(species)
  if (!key) return []
  const prevos = kaizoData.pre_evolutions[key] ?? []
  return [key, ...prevos]
}

function getLearnableMoves(species: string, level: number): LearnsetEntry[] {
  const lineage = getSpeciesLineage(species)
  if (lineage.length === 0) return []

  const byKey = new Map<string, LearnsetEntry>()

  for (const mon of lineage) {
    const levelUps = kaizoData.learnsets[mon] ?? []
    for (const entry of levelUps) {
      if (entry.level > level) continue
      const key = `level:${entry.move.toLowerCase()}`
      if (!byKey.has(key)) {
        byKey.set(key, { ...entry, source: mon, method: 'level' })
      }
    }

    const tmMoves = kaizoData.tm_learnsets[mon] ?? []
    for (const tmMove of tmMoves) {
      const key = `tm:${tmMove.toLowerCase()}`
      if (!byKey.has(key)) {
        byKey.set(key, { move: tmMove, level: 0, source: mon, method: 'tm' })
      }
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if ((a.method ?? 'level') !== (b.method ?? 'level')) {
      return (a.method ?? 'level') === 'level' ? -1 : 1
    }
    if (a.level !== b.level) return a.level - b.level
    return a.move.localeCompare(b.move)
  })
}

function getNatureSpeedModifier(nature: string): number {
  const plusSpeed = new Set(['Timid', 'Hasty', 'Jolly', 'Naive'])
  const minusSpeed = new Set(['Brave', 'Relaxed', 'Quiet', 'Sassy'])
  if (plusSpeed.has(nature)) return 1.1
  if (minusSpeed.has(nature)) return 0.9
  return 1
}

function computeApproxSpeed(mon: ManualMon, speciesData: KaizoPokemon | null): number | undefined {
  if (!speciesData) return undefined
  const base = speciesData.speed
  const iv = mon.ivs.spe
  const ev = mon.evs.spe
  const neutral = Math.floor((((2 * base) + iv + Math.floor(ev / 4)) * mon.level) / 100) + 5
  return Math.floor(neutral * getNatureSpeedModifier(mon.nature))
}

function computeMaxHp(
  level: number,
  ivHp: number,
  evHp: number,
  fallbackMaxHp: number,
  speciesData: KaizoPokemon | null,
): number {
  if (!speciesData) return Math.max(1, fallbackMaxHp)
  const base = speciesData.hp
  return Math.max(1, Math.floor((((2 * base) + ivHp + Math.floor(evHp / 4)) * level) / 100) + level + 10)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function toSpread(raw: Record<string, number> | undefined, fallback: StatSpread): StatSpread {
  return {
    hp: clamp(raw?.hp ?? fallback.hp, 0, 255),
    atk: clamp(raw?.atk ?? fallback.atk, 0, 255),
    def: clamp(raw?.def ?? fallback.def, 0, 255),
    spa: clamp(raw?.spa ?? fallback.spa, 0, 255),
    spd: clamp(raw?.spd ?? fallback.spd, 0, 255),
    spe: clamp(raw?.spe ?? fallback.spe, 0, 255),
  }
}

function fromImportedMon(mon: PartyMon): ManualMon {
  const hp = mon.hp ?? mon.max_hp ?? 100
  const maxHp = mon.max_hp ?? Math.max(hp, 1)
  return {
    species: mon.species,
    level: mon.level,
    nature: mon.nature || 'Hardy',
    ability: mon.ability || '',
    item: mon.item || '',
    evs: toSpread(mon.evs, defaultEvs),
    ivs: toSpread(mon.ivs, defaultIvs),
    moves: [...mon.moves, '', '', '', ''].slice(0, 4),
    hp,
    maxHp,
    status: '',
  }
}

function MonCard({ mon }: { mon: PartyMon | TrainerPokemon }) {
  const hpPct =
    'hp' in mon && 'max_hp' in mon &&
    (mon as PartyMon).max_hp != null && (mon as PartyMon).max_hp! > 0
      ? Math.round(((mon as PartyMon).hp! / (mon as PartyMon).max_hp!) * 100)
      : null

  return (
    <div className="mon-card">
      <div className="mon-header">
        <span className="mon-name">{mon.species}</span>
        <span className="mon-level">Lv {mon.level}</span>
      </div>
      {hpPct !== null && (
        <div className="hp-bar-wrap">
          <div className="hp-bar" style={{ width: `${hpPct}%` }} />
          <span className="hp-label">
            {(mon as PartyMon).hp}/{(mon as PartyMon).max_hp} HP
          </span>
        </div>
      )}
      {mon.nature && <div className="mon-detail">Nature: {mon.nature}</div>}
      {mon.ability && <div className="mon-detail">Ability: {mon.ability}</div>}
      {mon.item && <div className="mon-detail">Item: {mon.item}</div>}
      <div className="moves-list">
        {mon.moves.filter(Boolean).map((mv, i) => (
          <span key={i} className="move-tag">
            {mv}
          </span>
        ))}
      </div>
    </div>
  )
}

function computeDamage(
  attackerMon: CalcMon,
  defenderMon: CalcMon,
  moveName: string,
  label: string,
  fieldState: Pick<FieldState, 'weather'>,
): DamageResult | null {
  try {
    const atk = new Pokemon(4, attackerMon.species, {
      level: attackerMon.level,
      nature: (attackerMon.nature ?? 'Hardy') as never,
      ability: (attackerMon.ability ?? '') as never,
      item: (attackerMon.item ?? '') as never,
      evs: (attackerMon.evs ?? {}) as never,
      ivs: (attackerMon.ivs ?? {}) as never,
    })
    const def = new Pokemon(4, defenderMon.species, {
      level: defenderMon.level,
      nature: (defenderMon.nature ?? 'Hardy') as never,
      ability: (defenderMon.ability ?? '') as never,
      item: (defenderMon.item ?? '') as never,
      evs: (defenderMon.evs ?? {}) as never,
      ivs: (defenderMon.ivs ?? {}) as never,
    })

    const mv = new Move(4, moveName)
    const field = new Field({ weather: fieldState.weather as never })
    const res = calculate(4, atk, def, mv, field)
    const dmg = res.damage as number[]
    if (!dmg || dmg.length === 0) return null

    const lo = dmg[0]
    const hi = dmg[dmg.length - 1]
    const maxHp = defenderMon.max_hp && defenderMon.max_hp > 0 ? defenderMon.max_hp : def.maxHP()

    return {
      label,
      rolls: dmg.slice(0, 4).join(' / ') + (dmg.length > 4 ? ' …' : ''),
      range: `${lo}–${hi} (${Math.round((lo / maxHp) * 100)}–${Math.round((hi / maxHp) * 100)}%)`,
    }
  } catch {
    return null
  }
}

export default function App() {
  const [partyMons, setPartyMons] = useState<PartyMon[]>([])
  const [boxMons, setBoxMons] = useState<PartyMon[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  const [manualMon, setManualMon] = useState<ManualMon>({
    species: '',
    level: 50,
    nature: 'Hardy',
    ability: '',
    item: '',
    evs: defaultEvs,
    ivs: defaultIvs,
    moves: ['', '', '', ''],
    hp: 100,
    maxHp: 100,
    status: '',
  })

  const [trainerKey, setTrainerKey] = useState(trainerKeys[0] ?? '')
  const [enemyIdx, setEnemyIdx] = useState(0)
  const [fieldState, setFieldState] = useState<FieldState>({ weather: '', isTrickRoom: false, turnNumber: 1 })

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
      const nextParty = data.party ?? []
      const nextBoxes = data.boxes ?? []
      setPartyMons(nextParty)
      setBoxMons(nextBoxes)
      if (nextParty[0]) setManualMon(fromImportedMon(nextParty[0]))
    } catch (err: unknown) {
      const msg =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : 'Upload failed – is the Flask server running?'
      setUploadError(msg)
    } finally {
      setUploading(false)
    }
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/octet-stream': ['.sav', '.dsv'] },
    multiple: false,
  })

  const trainerOption = trainerByKey.get(trainerKey)
  const trainer = trainerOption?.trainer
  const enemyPokemon = trainer?.pokemon ?? []
  const enemyMon = enemyPokemon[enemyIdx] ?? null

  const importChoices = partyMons.length > 0
    ? partyMons.slice(0, 6)
    : [...partyMons, ...boxMons].slice(0, 6)

  const manualSpecies = useMemo(
    () => kaizoData.pokemon[normalizeSpeciesKey(manualMon.species)] ?? null,
    [manualMon.species],
  )
  const enemySpecies = enemyMon
    ? kaizoData.pokemon[normalizeSpeciesKey(enemyMon.species)] ?? null
    : null

  const learnableMoves: LearnsetEntry[] = useMemo(
    () => (manualMon.species ? getLearnableMoves(manualMon.species, manualMon.level) : []),
    [manualMon.species, manualMon.level],
  )

  const abilityOptions = useMemo(() => {
    const options = [manualSpecies?.ability1, manualSpecies?.ability2]
      .filter((ability): ability is string => Boolean(ability && ability !== '-'))
    return [...new Set(options)]
  }, [manualSpecies])

  const itemOptions = useMemo(() => {
    const speciesItems = [manualSpecies?.uncommon_item, manualSpecies?.rare_item]
      .filter((item): item is string => Boolean(item && item !== '-'))
    return [...new Set([...speciesItems, ...kaizoData.items])]
  }, [manualSpecies])

  const baseStatSummary = manualSpecies
    ? `HP ${manualSpecies.hp} / Atk ${manualSpecies.attack} / Def ${manualSpecies.defense} / SpA ${manualSpecies.sp_atk} / SpD ${manualSpecies.sp_def} / Spe ${manualSpecies.speed}`
    : 'Select a species to view base stats'

  const computedMaxHp = useMemo(
    () => computeMaxHp(manualMon.level, manualMon.ivs.hp, manualMon.evs.hp, manualMon.maxHp, manualSpecies),
    [manualMon.level, manualMon.ivs.hp, manualMon.evs.hp, manualSpecies, manualMon.maxHp],
  )
  const effectiveCurrentHp = clamp(manualMon.hp, 0, computedMaxHp)

  const damageResults = (() => {
    if (!manualMon.species || !enemyMon) return []

    const playerForCalc: CalcMon = {
      species: manualMon.species,
      level: manualMon.level,
      nature: manualMon.nature,
      ability: manualMon.ability,
      item: manualMon.item,
      evs: manualMon.evs,
      ivs: manualMon.ivs,
      hp: effectiveCurrentHp,
      max_hp: computedMaxHp,
    }

    const results: DamageResult[] = []

    for (const mv of manualMon.moves.filter(Boolean)) {
      const r = computeDamage(playerForCalc, enemyMon, mv, `Player: ${mv}`, fieldState)
      if (r) results.push(r)
    }

    for (const mv of enemyMon.moves.filter(Boolean)) {
      const r = computeDamage(enemyMon, playerForCalc, mv, `Enemy: ${mv}`, fieldState)
      if (r) results.push(r)
    }

    return results
  })()

  const aiProbs = (() => {
    if (!manualMon.species || !enemyMon) return []

    const hpPercent = computedMaxHp > 0
      ? clamp((effectiveCurrentHp / computedMaxHp) * 100, 0, 100)
      : 100

    const pMon: BattleMon = {
      species: manualMon.species,
      level: manualMon.level,
      nature: manualMon.nature,
      ability: manualMon.ability || undefined,
      item: manualMon.item || undefined,
      hpPercent,
      moves: manualMon.moves.filter(Boolean),
      evs: manualMon.evs,
      ivs: manualMon.ivs,
      status: manualMon.status || undefined,
      speed: computeApproxSpeed(manualMon, manualSpecies),
      types: manualSpecies ? [manualSpecies.type1, manualSpecies.type2].filter(Boolean) as string[] : undefined,
    }

    const eMon: BattleMon = {
      species: enemyMon.species,
      level: enemyMon.level,
      nature: enemyMon.nature ?? undefined,
      ability: enemyMon.ability ?? undefined,
      item: enemyMon.item ?? undefined,
      hpPercent: 100,
      moves: enemyMon.moves,
      speed: enemySpecies?.speed,
      types: enemySpecies ? [enemySpecies.type1, enemySpecies.type2].filter(Boolean) as string[] : undefined,
    }

    const flags: AIFlags = Object.fromEntries(
      (trainer?.ai_flags ?? []).map((f) => [f, true]),
    ) as AIFlags

    return predictEnemyMove(pMon, eMon, fieldState, flags)
  })()

  return (
    <div className="app">
      <header className="app-header">
        <h1>⚔️ Platinum Kaizo VGC Calculator</h1>
      </header>

      <div className="pane-row">
        <section className="pane pane-player">
          <h2>Player Theorycrafting</h2>

          <div className="import-section">
            <h3>Import from Save (Optional)</h3>
            <div
              {...getRootProps()}
              className={`dropzone ${isDragActive ? 'dropzone-active' : ''}`}
            >
              <input {...getInputProps()} />
              {uploading
                ? 'Uploading…'
                : isDragActive
                  ? 'Drop .sav here…'
                  : 'Click or drop a .sav/.dsv to autofill from save data'}
            </div>
            {uploadError && <p className="error">{uploadError}</p>}

            {importChoices.length > 0 && (
              <div className="imported-team">
                <p className="hint-inline">Imported team (click to autofill form)</p>
                <div className="slot-selector">
                  {importChoices.map((m, i) => (
                    <button
                      key={`${m.source}-${m.slot}-${i}`}
                      onClick={() => setManualMon(fromImportedMon(m))}
                      title={m.box !== undefined ? `Box ${m.box + 1}` : 'Party'}
                    >
                      {m.species}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="manual-form">
            <h3>Manual Pokémon Input</h3>

            <div className="manual-grid">
              <label>
                Species
                <input
                  value={manualMon.species}
                  onChange={(e) => setManualMon((prev) => ({ ...prev, species: e.target.value }))}
                  list="species-list"
                  placeholder="e.g. Garchomp"
                />
              </label>

              <label>
                Level
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={manualMon.level}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    setManualMon((prev) => ({ ...prev, level: clamp(Number.isFinite(value) ? value : 1, 1, 100) }))
                  }}
                />
              </label>

              <label>
                Nature
                <select
                  value={manualMon.nature}
                  onChange={(e) => setManualMon((prev) => ({ ...prev, nature: e.target.value }))}
                >
                  {NATURES.map((nature) => (
                    <option key={nature} value={nature}>
                      {nature}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Ability
                <select
                  value={manualMon.ability}
                  onChange={(e) => setManualMon((prev) => ({ ...prev, ability: e.target.value }))}
                >
                  <option value="">(None)</option>
                  {abilityOptions.map((ability) => (
                    <option key={ability} value={ability}>
                      {ability}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Item
                <select
                  value={manualMon.item}
                  onChange={(e) => setManualMon((prev) => ({ ...prev, item: e.target.value }))}
                >
                  <option value="">(None)</option>
                  {itemOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Current HP
                <input
                  type="number"
                  min={0}
                  max={computedMaxHp}
                  value={effectiveCurrentHp}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    setManualMon((prev) => ({
                      ...prev,
                      hp: clamp(Number.isFinite(value) ? value : 0, 0, computedMaxHp),
                    }))
                  }}
                />
              </label>

              <label>
                Max HP (calculated)
                <input
                  type="number"
                  min={1}
                  value={computedMaxHp}
                  readOnly
                />
              </label>

              <label>
                Status
                <select
                  value={manualMon.status}
                  onChange={(e) => setManualMon((prev) => ({ ...prev, status: e.target.value as StatusCode }))}
                >
                  <option value="">Healthy</option>
                  <option value="brn">Burn</option>
                  <option value="frz">Freeze</option>
                  <option value="par">Paralysis</option>
                  <option value="psn">Poison</option>
                  <option value="tox">Bad Poison</option>
                  <option value="slp">Sleep</option>
                </select>
              </label>
            </div>

            <div className="stat-block">
              <h3>Stats (Base: {baseStatSummary})</h3>
              <h4 className="stat-subheading">EVs</h4>
              <div className="stat-grid">
                {STAT_KEYS.map((stat) => (
                  <label key={`ev-${stat}`}>
                    {stat.toUpperCase()}
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={manualMon.evs[stat]}
                      onChange={(e) => {
                        const value = Number(e.target.value)
                        setManualMon((prev) => ({
                          ...prev,
                          evs: {
                            ...prev.evs,
                            [stat]: clamp(Number.isFinite(value) ? value : 0, 0, 255),
                          },
                        }))
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="stat-block">
              <h4 className="stat-subheading">IVs</h4>
              <div className="stat-grid">
                {STAT_KEYS.map((stat) => (
                  <label key={`iv-${stat}`}>
                    {stat.toUpperCase()}
                    <input
                      type="number"
                      min={0}
                      max={31}
                      value={manualMon.ivs[stat]}
                      onChange={(e) => {
                        const value = Number(e.target.value)
                        setManualMon((prev) => ({
                          ...prev,
                          ivs: {
                            ...prev.ivs,
                            [stat]: clamp(Number.isFinite(value) ? value : 0, 0, 31),
                          },
                        }))
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="calc-moves-section">
              <h3>Moves</h3>
              <div className="calc-moves-grid">
                {manualMon.moves.map((mv, i) => (
                  <input
                    key={i}
                    className="calc-move-input"
                    value={mv}
                    list="move-list"
                    placeholder={`Move ${i + 1}`}
                    onChange={(e) => {
                      const next = [...manualMon.moves]
                      next[i] = e.target.value
                      setManualMon((prev) => ({ ...prev, moves: next }))
                    }}
                  />
                ))}
              </div>
            </div>

            {learnableMoves.length > 0 && (
              <div className="learnset-section">
                <h3>♥ Learnable Moves (Level-up + TM/HM + Prior Evolutions)</h3>
                <div className="learnset-list">
                  {learnableMoves.map((entry, i) => (
                    <span
                      key={i}
                      className="learnset-tag"
                      title={
                        entry.method === 'tm'
                          ? `TM/HM learnset (${entry.source})`
                          : `Learned at Lv ${entry.level} (${entry.source})`
                      }
                      onClick={() => {
                        setManualMon((prev) => {
                          const next = [...prev.moves]
                          const emptyIdx = next.findIndex((m) => !m)
                          if (emptyIdx !== -1) next[emptyIdx] = entry.move
                          else next[3] = entry.move
                          return { ...prev, moves: next }
                        })
                      }}
                    >
                      {entry.method === 'tm' ? 'TM/HM' : `Lv${entry.level}`} {entry.move}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="pane pane-enemy">
          <h2>Enemy Trainer</h2>
          <select
            value={trainerKey}
            onChange={(e) => {
              setTrainerKey(e.target.value)
              setEnemyIdx(0)
            }}
            className="trainer-select"
          >
            {Object.entries(trainerOptionsBySplit).map(([splitName, options]) => (
              <optgroup key={splitName} label={splitName}>
                {options.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.trainer.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <div className="field-controls">
            <h3>Field State</h3>
            <div className="manual-grid">
              <label>
                Weather
                <select
                  value={fieldState.weather ?? ''}
                  onChange={(e) => setFieldState((prev) => ({ ...prev, weather: e.target.value }))}
                >
                  {WEATHER_OPTIONS.map((weather) => (
                    <option key={weather || 'none'} value={weather}>
                      {weather || 'none'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Turn
                <input
                  type="number"
                  min={1}
                  value={fieldState.turnNumber ?? 1}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    setFieldState((prev) => ({ ...prev, turnNumber: Math.max(1, Number.isFinite(value) ? value : 1) }))
                  }}
                />
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={fieldState.isTrickRoom ?? false}
                  onChange={(e) => setFieldState((prev) => ({ ...prev, isTrickRoom: e.target.checked }))}
                />
                Trick Room
              </label>
            </div>
          </div>

          {trainer && (
            <>
              <div className="ai-flags">
                {(trainer.ai_flags ?? []).map((flag) => (
                  <span key={flag} className="flag-tag">
                    {flag}
                  </span>
                ))}
              </div>

              <div className="slot-selector">
                {enemyPokemon.map((m, i) => (
                  <button
                    key={i}
                    onClick={() => setEnemyIdx(i)}
                    className={i === enemyIdx ? 'active' : ''}
                  >
                    {m.species}
                  </button>
                ))}
              </div>

              {enemyMon && <MonCard mon={enemyMon} />}
            </>
          )}
        </section>
      </div>

      <section className="pane pane-output">
        <h2>Output</h2>

        {!manualMon.species || !enemyMon ? (
          <p className="hint">Pick a player species and enemy Pokémon to see instant results.</p>
        ) : (
          <div className="output-columns">
            <div className="output-section">
              <h3>Damage Rolls</h3>
              {damageResults.length > 0 ? (
                <table className="damage-table">
                  <thead>
                    <tr>
                      <th>Move</th>
                      <th>Range</th>
                      <th>Sample Rolls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {damageResults.map((r, i) => (
                      <tr key={i}>
                        <td>{r.label}</td>
                        <td>{r.range}</td>
                        <td>{r.rolls}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="hint">Enter valid move names to see damage rolls.</p>
              )}
            </div>

            <div className="output-section">
              <h3>AI Move Prediction</h3>
              {aiProbs.length > 0 ? (
                <div className="ai-probs">
                  {aiProbs
                    .sort((a, b) => b.probability - a.probability)
                    .map((p, i) => (
                      <div key={i} className="prob-row">
                        <span className="prob-move">{p.move}</span>
                        <div className="prob-bar-wrap">
                          <div className="prob-bar" style={{ width: `${p.probability}%` }} />
                        </div>
                        <span className="prob-pct">{p.probability}%</span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="hint">No AI move probabilities available for current inputs.</p>
              )}
            </div>
          </div>
        )}
      </section>

      <datalist id="species-list">
        {speciesOptions.map((species) => (
          <option key={species} value={species} />
        ))}
      </datalist>

      <datalist id="move-list">
        {moveOptions.map((move) => (
          <option key={move} value={move} />
        ))}
      </datalist>
    </div>
  )
}
