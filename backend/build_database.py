"""
build_database.py
Reads ../data/Platinum Kaizo Docs.xlsx and produces:
  - ../data/kaizo_data.json  (Pokémon stats/types/abilities + Move data)
  - ../data/trainer_db.json  (Trainer rosters with natures, items, moves, AI flags)

AI flags for every trainer are sourced exclusively from the RAW TRAINER DATA
sheet (the authoritative game-data export).  Boss-split trainer names such as
"Champion Cynthia (Permanent Gravity)" are matched back to the plain name
"Cynthia" in RAW TRAINER DATA via a cascading suffix search.

The ai_flags field is stored as a list of active flag strings, e.g.
["basic", "eval_att", "expert"].
"""

import json
import re
import os
import pandas as pd

XLSX_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'Platinum Kaizo Docs.xlsx')
OUT_DIR   = os.path.join(os.path.dirname(__file__), '..', 'data')

BOSS_SPLITS = [
    'Roark Split', 'Gardenia Split', 'Fantina Split', 'Maylene Split',
    'Wake Split', 'Byron Split', 'Candice Split', 'Volkner Split',
    'Galactic Split', 'Elite Four Split',
]

# Exact column names in RAW TRAINER DATA → short flag identifier used in JSON
AI_FLAG_COLS = {
    # --- Flags documented in gen4_trainer_ai.md.txt ---
    'Prioritize Effectiveness': 'basic',          # Basic Flag
    'Evaluate Attacks':         'eval_att',        # Evaluate Attack Flag
    'Expert':                   'expert',          # Expert Flag
    'Prioritize Status':        'status',          # Prioritize Status (Kaizo extra flag)
    'Risky Attacks':            'risky',           # Risky Flag
    'Prioritize Damage':        'damage_prio',     # Prioritize Extremes Flag
    'Partner':                  'tag_strategy',    # Tag Strategy Flag (doubles)
    'Double Battle':            'double_battle',   # whether this encounter is doubles
    'Prioritize Healing':       'check_hp',        # Check HP Flag
    'Utilize Weather':          'weather',         # Weather Flag
    'Harassment':               'harassment',      # Harassment Flag
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clean_stat(value):
    """Return integer stat, stripping Kaizo buff/nerf annotations like '92 (+10)'."""
    s = str(value).strip()
    m = re.match(r'^(\d+)', s)
    if m:
        return int(m.group(1))
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return 0


def _val(v):
    """Return None for NaN/empty, else the value."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    s = str(v).strip()
    return None if s in ('', 'nan', 'NaN', '-') else s


# ---------------------------------------------------------------------------
# Phase 1a: Parse Personal sheet → Pokémon data
# ---------------------------------------------------------------------------

def parse_personal(xl):
    df = xl.parse('Personal', header=0)
    pokemon = {}
    for _, row in df.iterrows():
        name = _val(row.get('Name'))
        if not name or name == '-----':
            continue
        pokemon[name] = {
            'id':       int(row['ID Number']) if not pd.isna(row['ID Number']) else 0,
            'hp':       _clean_stat(row.get('HP', 0)),
            'attack':   _clean_stat(row.get('Attack', 0)),
            'defense':  _clean_stat(row.get('Defense', 0)),
            'sp_atk':   _clean_stat(row.get('Sp. Atk', 0)),
            'sp_def':   _clean_stat(row.get('Sp. Def', 0)),
            'speed':    _clean_stat(row.get('Speed', 0)),
            'type1':    _val(row.get('Type 1')) or 'Normal',
            'type2':    _val(row.get('Type 2')),
            'ability1': _val(row.get('Ability 1')),
            'ability2': _val(row.get('Ability 2')),
        }
    return pokemon


# ---------------------------------------------------------------------------
# Phase 1b: Parse Moves sheet → Move data
# ---------------------------------------------------------------------------

def parse_moves(xl):
    df = xl.parse('Moves', header=0)
    moves = {}
    for _, row in df.iterrows():
        name = _val(row.get('Name'))
        if not name or name == '-':
            continue
        power = _clean_stat(row.get('Power', 0))
        acc   = _clean_stat(row.get('Accuracy', 0))
        moves[name] = {
            'id':       int(row['ID Number']) if not pd.isna(row.get('ID Number', float('nan'))) else 0,
            'category': _val(row.get('Category')) or 'Physical',
            'power':    power,
            'type':     _val(row.get('Type')) or 'Normal',
            'accuracy': acc,
            'pp':       int(row['PP']) if not pd.isna(row.get('PP', float('nan'))) else 0,
        }
    return moves


# ---------------------------------------------------------------------------
# Phase 1c – RAW TRAINER DATA: build an authoritative AI-flags lookup
# ---------------------------------------------------------------------------

def _build_raw_trainer_lookup(xl):
    """
    Parse the RAW TRAINER DATA sheet and return a dict keyed by lower-cased
    trainer name mapping to a list of active flag strings.

    The 8 authoritative columns (per the spec) are:
        Prioritize Effectiveness, Evaluate Attacks, Expert,
        Prioritize Status, Risky Attacks, Prioritize Damage,
        Utilize Weather, Harassment
    """
    df = xl.parse('RAW TRAINER DATA', header=0)
    lookup = {}  # name_lower → list[str]
    for _, row in df.iterrows():
        name = _val(row.get('Name'))
        if not name or name == '-':
            continue
        active = []
        for col, short in AI_FLAG_COLS.items():
            v = row.get(col)
            try:
                if v and not pd.isna(v) and bool(v):
                    active.append(short)
            except (TypeError, ValueError):
                pass
        lookup[name.lower()] = active
    return lookup


def _flags_for_split_name(split_name: str, raw_lookup: dict) -> list:
    """
    Given a split-sheet trainer name like "Champion Cynthia (Permanent Gravity)"
    find the best match in raw_lookup (keyed by lower-cased plain name) and
    return the active flag list.

    Strategy:
      1. Strip any parenthetical suffix.
      2. Try the last word of what remains (the bare first name).
      3. Then try progressively longer suffixes (in case of compound names).
      4. Fall back to an empty list if nothing matches.
    """
    # Strip parenthetical suffix
    plain = re.sub(r'\s*\(.*\)', '', split_name).strip()
    words = plain.split()

    # Try from the last word toward the full string
    for start in range(len(words) - 1, -1, -1):
        candidate = ' '.join(words[start:]).lower()
        if candidate in raw_lookup:
            return raw_lookup[candidate]

    # No match
    return []


# ---------------------------------------------------------------------------
# Phase 1d: Parse boss-split sheets → trainer roster data
# ---------------------------------------------------------------------------

def _parse_split_sheet(df):
    """
    Return a list of trainer dicts from one split sheet.
    ai_flags is left empty here; it will be filled from RAW TRAINER DATA later.

    Sheet layout (0-indexed columns):
      col 4  : trainer name / Pokémon name / nature / item / move text
      col 16 : row-type label ('Pokémon', 'Nature/Abillity', 'Item', 'Moves')
    """
    trainers = []
    current_trainer = None
    slot_cols = [4, 6, 8, 10, 12, 14]
    in_moves = False

    for i in range(len(df)):
        row = df.iloc[i]
        col16 = _val(row.iloc[16]) if len(row) > 16 else None
        col4  = _val(row.iloc[4])
        col1  = _val(row.iloc[1])

        # ---- Trainer name row ----
        if col16 is None and col4 and col1 is None and col4 not in (
            'AI Flag Key:', 'Route', 'Route 202', 'Route 203',
        ):
            if not re.match(r'^Lv\s', col4) and 'Split' not in col4 and 'Flag' not in col4:
                for j in range(i + 1, min(i + 5, len(df))):
                    nxt = _val(df.iloc[j].iloc[16] if len(df.iloc[j]) > 16 else None)
                    if nxt == 'Pokémon':
                        current_trainer = {
                            'name':     col4,
                            'ai_flags': [],   # filled later from RAW TRAINER DATA
                            'pokemon':  [],
                        }
                        trainers.append(current_trainer)
                        in_moves = False
                        break

        # ---- Pokémon row ----
        elif col16 == 'Pokémon' and current_trainer is not None:
            in_moves = False
            current_trainer['pokemon'] = []
            for sc in slot_cols:
                val = _val(row.iloc[sc]) if sc < len(row) else None
                if val:
                    m = re.match(r'Lv\s+(\d+)\s+(.+?)(?:\s+[♂♀])?$', val)
                    if m:
                        level   = int(m.group(1))
                        species = m.group(2).strip()
                    else:
                        level   = 0
                        species = val
                    current_trainer['pokemon'].append({
                        'slot':    len(current_trainer['pokemon']),
                        'level':   level,
                        'species': species,
                        'nature':  None,
                        'ability': None,
                        'item':    None,
                        'moves':   [],
                    })

        # ---- Nature / Ability row ----
        elif col16 == 'Nature/Abillity' and current_trainer is not None:
            for idx, sc in enumerate(slot_cols):
                if idx >= len(current_trainer['pokemon']):
                    break
                nat = _val(row.iloc[sc])     if sc     < len(row) else None
                abl = _val(row.iloc[sc + 1]) if sc + 1 < len(row) else None
                if nat:
                    current_trainer['pokemon'][idx]['nature']  = nat
                if abl:
                    current_trainer['pokemon'][idx]['ability'] = abl

        # ---- Item row ----
        elif col16 == 'Item' and current_trainer is not None:
            for idx, sc in enumerate(slot_cols):
                if idx >= len(current_trainer['pokemon']):
                    break
                item = _val(row.iloc[sc]) if sc < len(row) else None
                if item and item != '(None)':
                    current_trainer['pokemon'][idx]['item'] = item

        # ---- Moves rows ----
        elif (col16 == 'Moves' or (in_moves and col16 is None and col4)) and current_trainer is not None:
            in_moves = True
            for idx, sc in enumerate(slot_cols):
                if idx >= len(current_trainer['pokemon']):
                    break
                mv = _val(row.iloc[sc]) if sc < len(row) else None
                if mv:
                    current_trainer['pokemon'][idx]['moves'].append(mv)
        else:
            if col16 is None and col4 is None:
                in_moves = False

    return trainers


def parse_trainer_db(xl):
    # ── Step 1: Build authoritative AI-flags lookup from RAW TRAINER DATA ──
    raw_lookup = _build_raw_trainer_lookup(xl)

    # ── Step 2: Load every trainer from RAW TRAINER DATA ───────────────────
    raw_df      = xl.parse('RAW TRAINER DATA', header=0)
    poke_df     = xl.parse('Trainer Pokemon',  header=0)

    trainers = {}
    for _, row in raw_df.iterrows():
        tid = _val(row.get('ID Number'))
        if tid is None:
            continue
        name = _val(row.get('Name')) or '-'
        if name == '-':
            continue
        try:
            tid = int(float(tid))
        except (ValueError, TypeError):
            continue

        active_flags = raw_lookup.get(name.lower(), [])
        trainers[tid] = {
            'id':       tid,
            'name':     name,
            'ai_flags': active_flags,
            'pokemon':  [],
        }

    # ── Step 3: Attach Pokémon rosters from Trainer Pokemon sheet ──────────
    slot_offsets = [0, 11, 22, 33, 44, 55]

    for _, row in poke_df.iterrows():
        tid = _val(row.iloc[0])
        if tid is None:
            continue
        try:
            tid = int(float(tid))
        except (ValueError, TypeError):
            continue
        if tid not in trainers:
            continue

        for offset in slot_offsets:
            col_idx = 2 + offset
            try:
                species = _val(row.iloc[col_idx + 3])
            except IndexError:
                break
            if not species:
                continue
            try:
                level = int(row.iloc[col_idx + 2]) if not pd.isna(row.iloc[col_idx + 2]) else 0
                item  = _val(row.iloc[col_idx + 5])
                moves = [_val(row.iloc[col_idx + 6 + k]) for k in range(4)]
            except IndexError:
                level = 0
                item  = None
                moves = []

            moves = [m for m in moves if m and m != '-']
            trainers[tid]['pokemon'].append({
                'slot':    len(trainers[tid]['pokemon']),
                'level':   level,
                'species': species,
                'nature':  None,
                'ability': None,
                'item':    item,
                'moves':   moves,
            })

    # ── Step 4: Parse boss-split sheets and cross-reference RAW TRAINER DATA ─
    boss_trainers = []
    for sheet_name in BOSS_SPLITS:
        try:
            df = xl.parse(sheet_name, header=None)
            boss_trainers.extend(_parse_split_sheet(df))
        except Exception as e:
            print(f'  Warning: could not parse {sheet_name}: {e}')

    # Fill ai_flags for every boss-split trainer from RAW TRAINER DATA
    for bt in boss_trainers:
        bt['ai_flags'] = _flags_for_split_name(bt['name'], raw_lookup)

    # ── Step 5: Merge boss-split data into the main trainer map ────────────
    # Index by plain name for matching
    boss_by_name: dict = {}
    for bt in boss_trainers:
        boss_by_name.setdefault(bt['name'], bt)

    # Build output dict
    result = {}
    for tid, tdata in trainers.items():
        result[f"{tdata['name']}_{tid}"] = tdata

    # Boss-split trainers that weren't already in RAW TRAINER DATA get added
    # by their split-sheet name (richer roster data from the split sheets).
    # For any name that does match an existing entry, the split-sheet roster
    # supplements it only when the base roster is empty.
    for bt_name, bt in boss_by_name.items():
        matched_key = None
        for key, tdata in result.items():
            if tdata['name'] == bt_name:
                if not tdata['pokemon'] and bt['pokemon']:
                    tdata['pokemon'] = bt['pokemon']
                matched_key = key
                break
        if matched_key is None:
            result[bt_name] = bt

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f'Reading {XLSX_PATH} …')
    xl = pd.ExcelFile(XLSX_PATH)

    print('Parsing Personal sheet …')
    pokemon = parse_personal(xl)
    print(f'  → {len(pokemon)} Pokémon')

    print('Parsing Moves sheet …')
    moves = parse_moves(xl)
    print(f'  → {len(moves)} moves')

    kaizo_data = {'pokemon': pokemon, 'moves': moves}
    out_path = os.path.join(OUT_DIR, 'kaizo_data.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(kaizo_data, f, indent=2, ensure_ascii=False)
    print(f'Written {out_path}')

    print('Parsing trainer sheets …')
    trainer_db = parse_trainer_db(xl)
    print(f'  → {len(trainer_db)} trainers')

    out_path2 = os.path.join(OUT_DIR, 'trainer_db.json')
    with open(out_path2, 'w', encoding='utf-8') as f:
        json.dump(trainer_db, f, indent=2, ensure_ascii=False)
    print(f'Written {out_path2}')

    print('Done.')


if __name__ == '__main__':
    main()
