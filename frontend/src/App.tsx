/**
 * App.tsx
 *
 * Three-pane Platinum Kaizo VGC Calculator & Router dashboard.
 *
 * Left  Pane – Player: file dropzone → POST to Flask /api/upload-save → show team
 *              Supports both party and PC box Pokémon browsing.
 *              Shows level-up learnset moves at or below current level.
 *              Allows editing the moves used in the damage calculator.
 * Right Pane – Enemy:  trainer dropdown → show lead Pokémon
 * Bottom Pane – Output: damage rolls via @smogon/calc + AI move probabilities
 */

import { useState, useCallback } from 'react'
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
// Learnset helpers
// ────────────────────────────────────────────────────────────────────────────

const kaizoData = kaizoRaw as KaizoData

/**
 * Return all moves a Pokémon can learn at or below `level` via level-up
 * (i.e. moves available via the Move Reminder / Heart Scale).
 */
function getLearnableAtLevel(species: string, level: number): LearnsetEntry[] {
  // Normalise species name to upper-case to match kaizo_data key format
  const key = species.toUpperCase()
  const learnset = kaizoData.learnsets[key] ?? []
  return learnset.filter((e) => e.level <= level)
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────
// Damage helper
// ────────────────────────────────────────────────────────────────────────────

function computeDamage(
  attackerMon: PartyMon | TrainerPokemon,
  defenderMon: PartyMon | TrainerPokemon,
  moveName: string,
  label: string,
): DamageResult | null {
  try {
    const atk = new Pokemon(4, attackerMon.species, {
      level:   attackerMon.level,
      nature:  (attackerMon.nature ?? 'Hardy') as never,
      ability: (attackerMon.ability ?? '') as never,
      item:    (attackerMon.item ?? '') as never,
      evs:     ('evs' in attackerMon ? attackerMon.evs : {}) as never,
      ivs:     ('ivs' in attackerMon ? attackerMon.ivs : {}) as never,
    })
    const def = new Pokemon(4, defenderMon.species, {
      level:   defenderMon.level,
      nature:  (defenderMon.nature ?? 'Hardy') as never,
      ability: (defenderMon.ability ?? '') as never,
      item:    (defenderMon.item ?? '') as never,
      evs:     ('evs' in defenderMon ? defenderMon.evs : {}) as never,
      ivs:     ('ivs' in defenderMon ? defenderMon.ivs : {}) as never,
    })
    const mv    = new Move(4, moveName)
    const field = new Field()
    const res   = calculate(4, atk, def, mv, field)
    const dmg   = res.damage as number[]
    if (!dmg || dmg.length === 0) return null
    const lo = dmg[0]
    const hi = dmg[dmg.length - 1]
    const maxHp =
      'max_hp' in defenderMon && (defenderMon as PartyMon).max_hp != null &&
      (defenderMon as PartyMon).max_hp! > 0
        ? (defenderMon as PartyMon).max_hp!
        : def.maxHP()
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
  // Player state
  const [partyMons, setPartyMons]   = useState<PartyMon[]>([])
  const [boxMons, setBoxMons]       = useState<PartyMon[]>([])
  const [playerSource, setPlayerSource] = useState<'party' | 'box'>('party')
  const [playerIdx, setPlayerIdx]   = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading]   = useState(false)

  // Editable moves for the calculator (player side)
  const [calcMoves, setCalcMoves]   = useState<string[]>(['', '', '', ''])

  // Enemy state
  const [trainerKey, setTrainerKey] = useState(trainerKeys[0] ?? '')
  const [enemyIdx, setEnemyIdx]     = useState(0)

  // Output
  const [damageResults, setDamageResults] = useState<DamageResult[]>([])
  const [aiProbs, setAiProbs]             = useState<{ move: string; probability: number }[]>([])

  // ── File drop ──────────────────────────────────────────────────────────
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
      setPlayerSource('party')
      setPlayerIdx(0)
      setCalcMoves(['', '', '', ''])
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

  // ── Derived data ───────────────────────────────────────────────────────
  const visibleMons  = playerSource === 'party' ? partyMons : boxMons
  const playerMon    = visibleMons[playerIdx] ?? null
  const trainer      = db[trainerKey]
  const enemyPokemon = trainer?.pokemon ?? []
  const enemyMon     = enemyPokemon[enemyIdx] ?? null

  // Learnset moves available at or below current level
  const learnableMoves: LearnsetEntry[] = playerMon
    ? getLearnableAtLevel(playerMon.species, playerMon.level)
    : []

  // When a different player mon is selected, pre-populate calcMoves
  const selectPlayerMon = (idx: number) => {
    setPlayerIdx(idx)
    const mon = visibleMons[idx]
    if (mon) {
      const mv = [...mon.moves, '', '', '', ''].slice(0, 4)
      setCalcMoves(mv)
    }
    setDamageResults([])
    setAiProbs([])
  }

  // ── Compute button ─────────────────────────────────────────────────────
  function handleCompute() {
    if (!playerMon || !enemyMon) return
    const results: DamageResult[] = []

    // Use the editable calcMoves for the player side
    const playerMovesForCalc = calcMoves.filter(Boolean)

    // Player → Enemy damage for each selected player move
    for (const mv of playerMovesForCalc) {
      const r = computeDamage(playerMon, enemyMon, mv, `Player: ${mv}`)
      if (r) results.push(r)
    }

    // Enemy → Player damage for each enemy move
    for (const mv of (enemyMon.moves ?? []).filter(Boolean)) {
      const r = computeDamage(enemyMon, playerMon, mv, `Enemy: ${mv}`)
      if (r) results.push(r)
    }

    setDamageResults(results)

    // AI probability prediction (uses enemy's actual moves)
    const pMon: BattleMon = {
      species:   playerMon.species,
      level:     playerMon.level,
      nature:    playerMon.nature,
      ability:   playerMon.ability,
      item:      playerMon.item,
      hpPercent: (playerMon.max_hp ?? 0) > 0
        ? (playerMon.hp! / playerMon.max_hp!) * 100
        : 100,
      moves:     playerMovesForCalc,
      evs:       playerMon.evs as BattleMon['evs'],
      ivs:       playerMon.ivs as BattleMon['ivs'],
    }
    const eMon: BattleMon = {
      species:   enemyMon.species,
      level:     enemyMon.level,
      nature:    enemyMon.nature ?? undefined,
      ability:   enemyMon.ability ?? undefined,
      item:      enemyMon.item ?? undefined,
      hpPercent: 100,
      moves:     enemyMon.moves,
    }
    const flags: AIFlags = Object.fromEntries(
      (trainer?.ai_flags ?? []).map((f) => [f, true]),
    ) as AIFlags
    const probs = predictEnemyMove(pMon, eMon, {}, flags)
    setAiProbs(probs)
  }

  const hasTeam = partyMons.length > 0 || boxMons.length > 0

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="app-header">
        <h1>⚔️ Platinum Kaizo Damage Calculator</h1>
      </header>

      <div className="pane-row">
        {/* Left Pane – Player */}
        <section className="pane pane-player">
          <h2>Player Team</h2>
          <div
            {...getRootProps()}
            className={`dropzone ${isDragActive ? 'dropzone-active' : ''}`}
          >
            <input {...getInputProps()} />
            {uploading
              ? 'Uploading…'
              : isDragActive
              ? 'Drop .sav here…'
              : 'Drop your .sav file here, or click to select'}
          </div>
          {uploadError && <p className="error">{uploadError}</p>}

          {hasTeam && (
            <>
              {/* Party / Box tabs */}
              <div className="source-tabs">
                <button
                  className={playerSource === 'party' ? 'active' : ''}
                  onClick={() => { setPlayerSource('party'); setPlayerIdx(0); setDamageResults([]); setAiProbs([]) }}
                >
                  Party ({partyMons.length})
                </button>
                <button
                  className={playerSource === 'box' ? 'active' : ''}
                  onClick={() => { setPlayerSource('box'); setPlayerIdx(0); setDamageResults([]); setAiProbs([]) }}
                >
                  Boxes ({boxMons.length})
                </button>
              </div>

              {/* Pokémon selector */}
              <div className="slot-selector">
                {visibleMons.map((m, i) => (
                  <button
                    key={i}
                    onClick={() => selectPlayerMon(i)}
                    className={i === playerIdx ? 'active' : ''}
                    title={m.box !== undefined ? `Box ${m.box + 1}` : 'Party'}
                  >
                    {m.species}
                    {m.box !== undefined && (
                      <span className="box-label"> B{m.box + 1}</span>
                    )}
                  </button>
                ))}
              </div>

              {playerMon && (
                <>
                  <MonCard mon={playerMon} />

                  {/* Learnset section */}
                  {learnableMoves.length > 0 && (
                    <div className="learnset-section">
                      <h3>♥ Learnable Moves (Heart Scale)</h3>
                      <div className="learnset-list">
                        {learnableMoves.map((e, i) => (
                          <span
                            key={i}
                            className="learnset-tag"
                            title={`Learned at Lv ${e.level}`}
                            onClick={() => {
                              // Clicking a learnset move fills the first empty calcMove slot
                              setCalcMoves((prev) => {
                                const next = [...prev]
                                const emptyIdx = next.findIndex((m) => !m)
                                if (emptyIdx !== -1) next[emptyIdx] = e.move
                                else next[3] = e.move
                                return next
                              })
                            }}
                          >
                            Lv{e.level} {e.move}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Editable moves for the calculator */}
                  <div className="calc-moves-section">
                    <h3>🔧 Moves for Calculator</h3>
                    <div className="calc-moves-grid">
                      {calcMoves.map((mv, i) => (
                        <input
                          key={i}
                          className="calc-move-input"
                          value={mv}
                          placeholder={`Move ${i + 1}`}
                          onChange={(e) => {
                            const next = [...calcMoves]
                            next[i] = e.target.value
                            setCalcMoves(next)
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {!hasTeam && !uploadError && (
            <p className="hint">Upload a .sav to see your team.</p>
          )}
        </section>

        {/* Right Pane – Enemy */}
        <section className="pane pane-enemy">
          <h2>Enemy Trainer</h2>
          <select
            value={trainerKey}
            onChange={(e) => {
              setTrainerKey(e.target.value)
              setEnemyIdx(0)
              setDamageResults([])
              setAiProbs([])
            }}
            className="trainer-select"
          >
            {trainerKeys.map((k) => (
              <option key={k} value={k}>
                {db[k].name}
              </option>
            ))}
          </select>

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

      {/* Compute button */}
      <div className="compute-row">
        <button
          className="compute-btn"
          onClick={handleCompute}
          disabled={!playerMon || !enemyMon || calcMoves.every((m) => !m)}
        >
          Calculate Damage &amp; AI Probabilities
        </button>
      </div>

      {/* Bottom Pane – Output */}
      {(damageResults.length > 0 || aiProbs.length > 0) && (
        <section className="pane pane-output">
          <h2>Output</h2>
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
                          <div
                            className="prob-bar"
                            style={{ width: `${p.probability}%` }}
                          />
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
