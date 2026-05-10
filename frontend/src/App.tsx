/**
 * App.tsx
 *
 * Three-pane Platinum Kaizo VGC Calculator & Router dashboard.
 *
 * Left  Pane – Player: comprehensive manual input form (Showdown-style teambuilder).
 *              No save file required to start.
 *              Optional "Import from Save" section autofills the form from a .sav.
 *              Sample team presets for instant use.
 *              Level-up learnset shown for the current species/level.
 * Right Pane – Enemy:  trainer dropdown → show lead Pokémon
 * Bottom Pane – Output: damage rolls (via @smogon/calc) + AI move probabilities
 *              updated automatically in real-time — no button required.
 */

import { useState, useMemo, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import axios from 'axios'
import { calculate, Pokemon, Move, Field } from '@smogon/calc'
import { predictEnemyMove, type BattleMon, type AIFlags } from './engine/aiPredictor'
import trainerDb from '../../data/trainer_db.json'
import kaizoRaw from '../../data/kaizo_data.json'
import './App.css'

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface StatBlock {
  [key: string]: number
  hp: number
  atk: number
  def: number
  spa: number
  spd: number
  spe: number
}

type StatusType = '' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz'

/** The manual input form state for the player's Pokémon */
interface ManualMon {
  species: string
  level: number
  nature: string
  ability: string
  item: string
  evs: StatBlock
  ivs: StatBlock
  moves: [string, string, string, string]
  currentHp: number  // percentage 0–100
  status: StatusType
}

/** A Pokémon returned from the save-file upload (used for autofill only) */
interface ImportedMon {
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
}

interface KaizoData {
  pokemon: Record<string, unknown>
  moves: Record<string, unknown>
  learnsets: Record<string, LearnsetEntry[]>
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
  ai_flags: string[]
  pokemon: TrainerPokemon[]
}

type TrainerDb = Record<string, TrainerEntry>

interface DamageResult {
  label: string
  rolls: string
  range: string
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
  'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
  'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
] as const

const STATUS_LABELS: Record<StatusType, string> = {
  '':    'None',
  'brn': 'Burn',
  'par': 'Paralysis',
  'psn': 'Poison',
  'tox': 'Bad Poison',
  'slp': 'Sleep',
  'frz': 'Freeze',
}

const STAT_KEYS: (keyof StatBlock)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']

const STAT_LABELS: Record<keyof StatBlock, string> = {
  hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
}

const DEFAULT_MANUAL_MON: ManualMon = {
  species:   'Infernape',
  level:     50,
  nature:    'Jolly',
  ability:   'Blaze',
  item:      'Life Orb',
  evs:       { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
  ivs:       { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  moves:     ['Close Combat', 'Flare Blitz', 'U-turn', 'Mach Punch'],
  currentHp: 100,
  status:    '',
}

const SAMPLE_TEAM: { label: string; mon: ManualMon }[] = [
  {
    label: 'Infernape',
    mon: {
      species: 'Infernape', level: 50, nature: 'Jolly', ability: 'Blaze', item: 'Life Orb',
      evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      moves: ['Close Combat', 'Flare Blitz', 'U-turn', 'Mach Punch'], currentHp: 100, status: '',
    },
  },
  {
    label: 'Garchomp',
    mon: {
      species: 'Garchomp', level: 50, nature: 'Jolly', ability: 'Sand Veil', item: 'Yache Berry',
      evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'], currentHp: 100, status: '',
    },
  },
  {
    label: 'Lucario',
    mon: {
      species: 'Lucario', level: 50, nature: 'Timid', ability: 'Steadfast', item: 'Choice Specs',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      moves: ['Aura Sphere', 'Shadow Ball', 'Flash Cannon', 'Vacuum Wave'], currentHp: 100, status: '',
    },
  },
  {
    label: 'Togekiss',
    mon: {
      species: 'Togekiss', level: 50, nature: 'Calm', ability: 'Serene Grace', item: 'Sitrus Berry',
      evs: { hp: 252, atk: 0, def: 0, spa: 4, spd: 252, spe: 0 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      moves: ['Air Slash', 'Aura Sphere', 'Thunder Wave', 'Roost'], currentHp: 100, status: '',
    },
  },
  {
    label: 'Weavile',
    mon: {
      species: 'Weavile', level: 50, nature: 'Jolly', ability: 'Pressure', item: 'Focus Sash',
      evs: { hp: 0, atk: 252, def: 4, spa: 0, spd: 0, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      moves: ['Ice Punch', 'Night Slash', 'Brick Break', 'Fake Out'], currentHp: 100, status: '',
    },
  },
  {
    label: 'Gengar',
    mon: {
      species: 'Gengar', level: 50, nature: 'Timid', ability: 'Levitate', item: 'Focus Sash',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      moves: ['Shadow Ball', 'Focus Blast', 'Thunderbolt', 'Destiny Bond'], currentHp: 100, status: '',
    },
  },
]

// ────────────────────────────────────────────────────────────────────────────
// Learnset helpers
// ────────────────────────────────────────────────────────────────────────────

const kaizoData = kaizoRaw as KaizoData

/** Species list derived from kaizo_data for the datalist autocomplete. */
const SPECIES_LIST: string[] = Object.keys(kaizoData.pokemon).map((name) =>
  name
    .split(' ')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' '),
)

/** Return all moves a Pokémon can learn at or below `level` via level-up. */
function getLearnableAtLevel(species: string, level: number): LearnsetEntry[] {
  const key = species.toUpperCase()
  const learnset = kaizoData.learnsets[key] ?? []
  return learnset.filter((e) => e.level <= level)
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

function MonCard({ mon }: { mon: TrainerPokemon }) {
  return (
    <div className="mon-card">
      <div className="mon-header">
        <span className="mon-name">{mon.species}</span>
        <span className="mon-level">Lv {mon.level}</span>
      </div>
      {mon.nature  && <div className="mon-detail">Nature: {mon.nature}</div>}
      {mon.ability && <div className="mon-detail">Ability: {mon.ability}</div>}
      {mon.item    && <div className="mon-detail">Item: {mon.item}</div>}
      <div className="moves-list">
        {(mon.moves ?? []).filter(Boolean).map((mv, i) => (
          <span key={i} className="move-tag">{mv}</span>
        ))}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Damage helper
// ────────────────────────────────────────────────────────────────────────────

function computeDamage(
  attackerSpecies: string,
  attackerLevel: number,
  attackerNature: string,
  attackerAbility: string,
  attackerItem: string,
  attackerEvs: Record<string, number>,
  attackerIvs: Record<string, number>,
  defenderSpecies: string,
  defenderLevel: number,
  defenderNature: string,
  defenderAbility: string,
  defenderItem: string,
  defenderEvs: Record<string, number>,
  defenderIvs: Record<string, number>,
  defenderMaxHpOverride: number | null,
  moveName: string,
  label: string,
): DamageResult | null {
  try {
    const atk = new Pokemon(4, attackerSpecies, {
      level:   attackerLevel,
      nature:  attackerNature  as never,
      ability: attackerAbility as never,
      item:    attackerItem    as never,
      evs:     attackerEvs     as never,
      ivs:     attackerIvs     as never,
    })
    const def = new Pokemon(4, defenderSpecies, {
      level:   defenderLevel,
      nature:  defenderNature  as never,
      ability: defenderAbility as never,
      item:    defenderItem    as never,
      evs:     defenderEvs     as never,
      ivs:     defenderIvs     as never,
    })
    const mv    = new Move(4, moveName)
    const field = new Field()
    const res   = calculate(4, atk, def, mv, field)
    const dmg   = res.damage as number[]
    if (!dmg || dmg.length === 0) return null
    const lo    = dmg[0]
    const hi    = dmg[dmg.length - 1]
    const maxHp = defenderMaxHpOverride ?? def.maxHP()
    return {
      label,
      rolls: dmg.slice(0, 4).join(' / ') + (dmg.length > 4 ? ' …' : ''),
      range: `${lo}–${hi} (${Math.round((lo / maxHp) * 100)}–${Math.round((hi / maxHp) * 100)}%)`,
    }
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main App
// ────────────────────────────────────────────────────────────────────────────

const db = trainerDb as TrainerDb
const trainerKeys = Object.keys(db).filter((k) => db[k].pokemon.length > 0)

export default function App() {
  // ── Manual player form state ──────────────────────────────────────────────
  const [manualMon, setManualMon] = useState<ManualMon>(DEFAULT_MANUAL_MON)

  // ── Save-file import (optional / secondary) ───────────────────────────────
  const [showImport,    setShowImport]    = useState(false)
  const [importedParty, setImportedParty] = useState<ImportedMon[]>([])
  const [importedBoxes, setImportedBoxes] = useState<ImportedMon[]>([])
  const [importSource,  setImportSource]  = useState<'party' | 'box'>('party')
  const [uploadError,   setUploadError]   = useState<string | null>(null)
  const [uploading,     setUploading]     = useState(false)

  // ── Enemy state ───────────────────────────────────────────────────────────
  const [trainerKey, setTrainerKey] = useState(trainerKeys[0] ?? '')
  const [enemyIdx,   setEnemyIdx]   = useState(0)

  // ── Reactive calculations — derived during render (no button needed) ──────
  const { damageResults, aiProbs } = useMemo(() => {
    const trainer  = db[trainerKey]
    const enemyMon = trainer?.pokemon[enemyIdx] ?? null
    const playerMoves = manualMon.moves.filter(Boolean)

    if (!manualMon.species || playerMoves.length === 0 || !enemyMon) {
      return { damageResults: [] as DamageResult[], aiProbs: [] as { move: string; probability: number }[] }
    }

    const results: DamageResult[] = []

    // Player → Enemy
    for (const mv of playerMoves) {
      const r = computeDamage(
        manualMon.species, manualMon.level, manualMon.nature,
        manualMon.ability, manualMon.item, manualMon.evs, manualMon.ivs,
        enemyMon.species,  enemyMon.level, enemyMon.nature  ?? 'Hardy',
        enemyMon.ability   ?? '',          enemyMon.item    ?? '',
        {}, {},
        null,
        mv, `Player: ${mv}`,
      )
      if (r) results.push(r)
    }

    // Enemy → Player
    for (const mv of (enemyMon.moves ?? []).filter(Boolean)) {
      const r = computeDamage(
        enemyMon.species,  enemyMon.level, enemyMon.nature  ?? 'Hardy',
        enemyMon.ability   ?? '',          enemyMon.item    ?? '',
        {}, {},
        manualMon.species, manualMon.level, manualMon.nature,
        manualMon.ability, manualMon.item, manualMon.evs, manualMon.ivs,
        null,
        mv, `Enemy: ${mv}`,
      )
      if (r) results.push(r)
    }

    // AI probability prediction
    const pMon: BattleMon = {
      species:    manualMon.species,
      level:      manualMon.level,
      nature:     manualMon.nature,
      ability:    manualMon.ability,
      item:       manualMon.item,
      hpPercent:  manualMon.currentHp,
      moves:      playerMoves,
      evs:        manualMon.evs,
      ivs:        manualMon.ivs,
      status:     manualMon.status || undefined,
    }
    const eMon: BattleMon = {
      species:   enemyMon.species,
      level:     enemyMon.level,
      nature:    enemyMon.nature   ?? undefined,
      ability:   enemyMon.ability  ?? undefined,
      item:      enemyMon.item     ?? undefined,
      hpPercent: 100,
      moves:     enemyMon.moves,
    }
    const flags: AIFlags = Object.fromEntries(
      (trainer?.ai_flags ?? []).map((f) => [f, true]),
    ) as AIFlags

    return { damageResults: results, aiProbs: predictEnemyMove(pMon, eMon, {}, flags) }
  }, [manualMon, trainerKey, enemyIdx])

  // ── Helpers for updating manualMon sub-fields ─────────────────────────────
  const setField = <K extends keyof ManualMon>(key: K, value: ManualMon[K]) =>
    setManualMon((prev) => ({ ...prev, [key]: value }))

  const setEv = (stat: keyof StatBlock, raw: string) => {
    const v = Math.min(252, Math.max(0, parseInt(raw) || 0))
    setManualMon((prev) => ({ ...prev, evs: { ...prev.evs, [stat]: v } }))
  }

  const setIv = (stat: keyof StatBlock, raw: string) => {
    const v = Math.min(31, Math.max(0, parseInt(raw) || 0))
    setManualMon((prev) => ({ ...prev, ivs: { ...prev.ivs, [stat]: v } }))
  }

  const setMove = (idx: number, value: string) =>
    setManualMon((prev) => {
      const moves = [...prev.moves] as [string, string, string, string]
      moves[idx] = value
      return { ...prev, moves }
    })

  // Autofill the manual form from an imported Pokémon
  const autofill = (imp: ImportedMon) => {
    const evBlock: StatBlock = {
      hp:  imp.evs['hp']  ?? 0,
      atk: imp.evs['atk'] ?? 0,
      def: imp.evs['def'] ?? 0,
      spa: imp.evs['spa'] ?? 0,
      spd: imp.evs['spd'] ?? 0,
      spe: imp.evs['spe'] ?? 0,
    }
    const ivBlock: StatBlock = {
      hp:  imp.ivs['hp']  ?? 31,
      atk: imp.ivs['atk'] ?? 31,
      def: imp.ivs['def'] ?? 31,
      spa: imp.ivs['spa'] ?? 31,
      spd: imp.ivs['spd'] ?? 31,
      spe: imp.ivs['spe'] ?? 31,
    }
    const moves = [...imp.moves, '', '', '', ''].slice(0, 4) as [string, string, string, string]
    const currentHp = (imp.max_hp ?? 0) > 0
      ? Math.round(((imp.hp ?? imp.max_hp ?? 0) / imp.max_hp!) * 100)
      : 100
    setManualMon({
      species:   imp.species,
      level:     imp.level,
      nature:    imp.nature,
      ability:   imp.ability,
      item:      imp.item,
      evs:       evBlock,
      ivs:       ivBlock,
      moves,
      currentHp,
      status:    '',
    })
  }

  // ── Learnset for current species/level ────────────────────────────────────
  const learnableMoves = getLearnableAtLevel(manualMon.species, manualMon.level)

  // Fill first empty move slot with a learnset move
  const addLearnsetMove = (moveName: string) => {
    setManualMon((prev) => {
      const moves = [...prev.moves] as [string, string, string, string]
      const emptyIdx = moves.findIndex((m) => !m)
      if (emptyIdx !== -1) moves[emptyIdx] = moveName
      else moves[3] = moveName
      return { ...prev, moves }
    })
  }

  // ── Save file drop ────────────────────────────────────────────────────────
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const form = new FormData()
      form.append('save', file)
      const { data } = await axios.post<{ party: ImportedMon[]; boxes: ImportedMon[] }>(
        'http://localhost:5000/api/upload-save',
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      setImportedParty(data.party ?? [])
      setImportedBoxes(data.boxes ?? [])
      setImportSource('party')
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

  // ── Derived enemy data ────────────────────────────────────────────────────
  const trainer      = db[trainerKey]
  const enemyPokemon = trainer?.pokemon ?? []
  const enemyMon     = enemyPokemon[enemyIdx] ?? null

  const hasImported = importedParty.length > 0 || importedBoxes.length > 0
  const visibleImported = importSource === 'party' ? importedParty : importedBoxes

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="app-header">
        <h1>⚔️ Platinum Kaizo VGC Calculator</h1>
        <p className="app-subtitle">Build your team and get instant damage calculations — no save file required</p>
      </header>

      <div className="pane-row">
        {/* ── Left Pane – Player manual input ── */}
        <section className="pane pane-player">
          <h2>Your Pokémon</h2>

          {/* Sample team presets */}
          <div className="sample-team-section">
            <span className="section-label">📋 Sample Team</span>
            <div className="sample-team-buttons">
              {SAMPLE_TEAM.map((s) => (
                <button
                  key={s.label}
                  className={`sample-btn${manualMon.species === s.mon.species ? ' active' : ''}`}
                  onClick={() => setManualMon(s.mon)}
                  title={`Load ${s.label} preset`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Manual input form ── */}
          <div className="manual-form">
            {/* Species */}
            <div className="form-row">
              <label className="form-label">Species</label>
              <input
                className="form-input"
                list="species-list"
                value={manualMon.species}
                onChange={(e) => setField('species', e.target.value)}
                placeholder="e.g. Infernape"
              />
              <datalist id="species-list">
                {SPECIES_LIST.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>

            {/* Level + Nature */}
            <div className="form-row form-row-two">
              <div className="form-group">
                <label className="form-label">Level</label>
                <input
                  className="form-input"
                  type="number"
                  min={1} max={100}
                  value={manualMon.level}
                  onChange={(e) => setField('level', Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Nature</label>
                <select
                  className="form-input"
                  value={manualMon.nature}
                  onChange={(e) => setField('nature', e.target.value)}
                >
                  {NATURES.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            </div>

            {/* Ability + Item */}
            <div className="form-row form-row-two">
              <div className="form-group">
                <label className="form-label">Ability</label>
                <input
                  className="form-input"
                  value={manualMon.ability}
                  onChange={(e) => setField('ability', e.target.value)}
                  placeholder="e.g. Blaze"
                />
              </div>
              <div className="form-group">
                <label className="form-label">Item</label>
                <input
                  className="form-input"
                  value={manualMon.item}
                  onChange={(e) => setField('item', e.target.value)}
                  placeholder="e.g. Life Orb"
                />
              </div>
            </div>

            {/* HP% + Status */}
            <div className="form-row form-row-two">
              <div className="form-group">
                <label className="form-label">Current HP %</label>
                <input
                  className="form-input"
                  type="number"
                  min={1} max={100}
                  value={manualMon.currentHp}
                  onChange={(e) => setField('currentHp', Math.min(100, Math.max(1, parseInt(e.target.value) || 100)))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Status</label>
                <select
                  className="form-input"
                  value={manualMon.status}
                  onChange={(e) => setField('status', e.target.value as StatusType)}
                >
                  {(Object.keys(STATUS_LABELS) as StatusType[]).map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* EVs */}
            <div className="form-stat-group">
              <label className="form-label">EVs (0–252)</label>
              <div className="stat-grid">
                {STAT_KEYS.map((s) => (
                  <div key={s} className="stat-cell">
                    <label className="stat-label">{STAT_LABELS[s]}</label>
                    <input
                      className="stat-input"
                      type="number"
                      min={0} max={252}
                      value={manualMon.evs[s]}
                      onChange={(e) => setEv(s, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* IVs */}
            <div className="form-stat-group">
              <label className="form-label">IVs (0–31)</label>
              <div className="stat-grid">
                {STAT_KEYS.map((s) => (
                  <div key={s} className="stat-cell">
                    <label className="stat-label">{STAT_LABELS[s]}</label>
                    <input
                      className="stat-input"
                      type="number"
                      min={0} max={31}
                      value={manualMon.ivs[s]}
                      onChange={(e) => setIv(s, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Moves */}
            <div className="form-stat-group">
              <label className="form-label">Moves</label>
              <div className="calc-moves-grid">
                {manualMon.moves.map((mv, i) => (
                  <input
                    key={i}
                    className="calc-move-input"
                    value={mv}
                    placeholder={`Move ${i + 1}`}
                    onChange={(e) => setMove(i, e.target.value)}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Learnset reference */}
          {learnableMoves.length > 0 && (
            <div className="learnset-section">
              <h3>♥ Learnable Moves (Heart Scale) — click to add</h3>
              <div className="learnset-list">
                {learnableMoves.map((e, i) => (
                  <span
                    key={i}
                    className="learnset-tag"
                    title={`Learned at Lv ${e.level}`}
                    onClick={() => addLearnsetMove(e.move)}
                  >
                    Lv{e.level} {e.move}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Import from Save (optional / secondary) ── */}
          <div className="import-section">
            <button
              className="import-toggle-btn"
              onClick={() => setShowImport((v) => !v)}
            >
              {showImport ? '▲' : '▼'} Import from Save File
            </button>

            {showImport && (
              <div className="import-body">
                <div
                  {...getRootProps()}
                  className={`dropzone${isDragActive ? ' dropzone-active' : ''}`}
                >
                  <input {...getInputProps()} />
                  {uploading
                    ? 'Uploading…'
                    : isDragActive
                    ? 'Drop .sav here…'
                    : 'Drop your .sav/.dsv file here, or click to select'}
                </div>
                {uploadError && <p className="error">{uploadError}</p>}

                {hasImported && (
                  <>
                    <div className="source-tabs">
                      <button
                        className={importSource === 'party' ? 'active' : ''}
                        onClick={() => setImportSource('party')}
                      >
                        Party ({importedParty.length})
                      </button>
                      <button
                        className={importSource === 'box' ? 'active' : ''}
                        onClick={() => setImportSource('box')}
                      >
                        Boxes ({importedBoxes.length})
                      </button>
                    </div>
                    <p className="import-hint">Click a Pokémon to autofill the form above.</p>
                    <div className="slot-selector">
                      {visibleImported.map((m, i) => (
                        <button
                          key={i}
                          onClick={() => autofill(m)}
                          className={manualMon.species === m.species ? 'active' : ''}
                          title={m.box !== undefined ? `Box ${m.box + 1} – ${m.species} Lv${m.level}` : `Party – ${m.species} Lv${m.level}`}
                        >
                          {m.species}
                          {m.box !== undefined && <span className="box-label"> B{m.box + 1}</span>}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── Right Pane – Enemy ── */}
        <section className="pane pane-enemy">
          <h2>Enemy Trainer</h2>
          <select
            value={trainerKey}
            onChange={(e) => { setTrainerKey(e.target.value); setEnemyIdx(0) }}
            className="trainer-select"
          >
            {trainerKeys.map((k) => (
              <option key={k} value={k}>{db[k].name}</option>
            ))}
          </select>

          {trainer && (
            <>
              <div className="ai-flags">
                {(trainer.ai_flags ?? []).map((flag) => (
                  <span key={flag} className="flag-tag">{flag}</span>
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

      {/* ── Bottom Pane – Live Output (no button) ── */}
      {(damageResults.length > 0 || aiProbs.length > 0) && (
        <section className="pane pane-output">
          <h2>Live Output</h2>
          <div className="output-columns">
            {damageResults.length > 0 && (
              <div className="output-section">
                <h3>Damage Rolls</h3>
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
              </div>
            )}

            {aiProbs.length > 0 && (
              <div className="output-section">
                <h3>AI Move Prediction</h3>
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
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
