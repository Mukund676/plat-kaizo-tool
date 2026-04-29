"""
build_database.py
Reads ../data/Platinum Kaizo Docs.xlsx and produces:
  - ../data/kaizo_data.json  (Pokémon stats/types/abilities + Move data)
  - ../data/trainer_db.json  (Trainer rosters with natures, items, moves, AI flags)
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

AI_FLAG_COLUMNS = {
    5:  'basic',
    6:  'eval_att',
    7:  'expert',
    8:  'status',
    9:  'risky',
    10: 'damage_prio',
    11: 'baton_pass',
    12: 'tag_ai',
    13: 'check_hp',
    14: 'weather',
    15: 'harassment',
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
# Phase 1c: Parse boss-split sheets → trainer_db
# ---------------------------------------------------------------------------

def _parse_split_sheet(df):
    """
    Return a list of trainer dicts from one split sheet.

    Sheet layout (0-indexed columns):
      col 4  : trainer name / Pokémon name / nature / item / move text
      col 5  : Basic AI flag value / ability / (blank)
      col 6  : Eval Att value / Pokémon slot 2 info
      …
      col 16 : row-type label ('Pokémon', 'Nature/Abillity', 'Item', 'Moves')

    Row patterns:
      • Trainer header : col16 is NaN, col4 has the trainer name string,
                         col1 is NaN (not 'AI Flags:')
      • Pokemon row    : col16 == 'Pokémon'
      • Nature/Ability : col16 == 'Nature/Abillity'
      • Item row       : col16 == 'Item' (and col1 == 'AI Flags:')
      • Moves rows     : col16 == 'Moves' or col16 is NaN after a Moves row
    """

    # Row 2 contains the AI flag column labels; capture column → flag name
    ai_flag_header_row = df.iloc[2]
    flag_col_map = {}  # col_index → flag_name
    for col_idx, header in enumerate(ai_flag_header_row):
        h = _val(header)
        if h and col_idx >= 5:
            flag_col_map[col_idx] = h.lower().replace(' ', '_').replace('(', '').replace(')', '')

    trainers = []
    current_trainer = None
    slot_cols = [4, 6, 8, 10, 12, 14]   # columns where Pokémon data lives

    # We need the sheet's AI flags row (row index 2 in 0-based with no header)
    # Trainer-level AI flags are stored *above* the trainer block in some sheets,
    # but examining the data they appear to come from the Trainer Data sheet.
    # In split sheets the flags are shown per-trainer block in a header chunk;
    # we look for a sub-header that precedes the trainer name.

    in_moves = False
    current_slot_idx = 0  # index into pokemon list for move assignment

    for i in range(len(df)):
        row = df.iloc[i]
        col16 = _val(row.iloc[16]) if len(row) > 16 else None
        col4  = _val(row.iloc[4])
        col1  = _val(row.iloc[1])

        # ---- Trainer name row ----
        if col16 is None and col4 and col1 is None and col4 not in (
            'AI Flag Key:', 'Route', 'Route 202', 'Route 203',
        ):
            # Heuristic: not a section header, not a Pokémon level string
            if not re.match(r'^Lv\s', col4) and 'Split' not in col4 and 'Flag' not in col4:
                # Check surrounding rows – if next non-empty row has 'Pokémon' label, this is a trainer
                for j in range(i + 1, min(i + 5, len(df))):
                    nxt = _val(df.iloc[j].iloc[16] if len(df.iloc[j]) > 16 else None)
                    if nxt == 'Pokémon':
                        current_trainer = {
                            'name':     col4,
                            'ai_flags': {},
                            'pokemon':  [],
                        }
                        trainers.append(current_trainer)
                        in_moves = False
                        break

        # ---- Pokémon row ----
        elif col16 == 'Pokémon' and current_trainer is not None:
            in_moves = False
            current_slot_idx = 0
            current_trainer['pokemon'] = []
            for sc in slot_cols:
                val = _val(row.iloc[sc]) if sc < len(row) else None
                if val:
                    # Parse "Lv 5 Zigzagoon ♂" → level + species
                    m = re.match(r'Lv\s+(\d+)\s+(.+?)(?:\s+[♂♀])?$', val)
                    if m:
                        level   = int(m.group(1))
                        species = m.group(2).strip()
                    else:
                        level   = 0
                        species = val
                    current_trainer['pokemon'].append({
                        'slot':   len(current_trainer['pokemon']),
                        'level':  level,
                        'species': species,
                        'nature': None,
                        'ability': None,
                        'item':   None,
                        'moves':  [],
                    })

        # ---- Nature / Ability row ----
        elif col16 == 'Nature/Abillity' and current_trainer is not None:
            for idx, sc in enumerate(slot_cols):
                if idx >= len(current_trainer['pokemon']):
                    break
                nature_col = sc
                ability_col = sc + 1
                nat = _val(row.iloc[nature_col]) if nature_col < len(row) else None
                abl = _val(row.iloc[ability_col]) if ability_col < len(row) else None
                if nat:
                    current_trainer['pokemon'][idx]['nature']  = nat
                if abl:
                    current_trainer['pokemon'][idx]['ability'] = abl

        # ---- Item row (also carries AI Flags label) ----
        elif col16 == 'Item' and current_trainer is not None:
            for idx, sc in enumerate(slot_cols):
                if idx >= len(current_trainer['pokemon']):
                    break
                item = _val(row.iloc[sc]) if sc < len(row) else None
                if item and item != '(None)':
                    current_trainer['pokemon'][idx]['item'] = item
            # Extract AI flags from this row's earlier columns (5-15)
            for ci, flag_name in flag_col_map.items():
                fv = _val(row.iloc[ci]) if ci < len(row) else None
                if fv and fv not in ('NaN', '-'):
                    current_trainer['ai_flags'][flag_name] = True

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
    # Primary source: Trainer Data + Trainer Pokemon sheets
    trainer_data_df = xl.parse('Trainer Data', header=0)
    trainer_poke_df = xl.parse('Trainer Pokemon', header=0)

    # Build trainer map indexed by ID
    trainers = {}
    for _, row in trainer_data_df.iterrows():
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

        def flag(col):
            v = row.get(col)
            try:
                return bool(v) if not pd.isna(v) else False
            except (TypeError, ValueError):
                return False

        trainers[tid] = {
            'id':   tid,
            'name': name,
            'ai_flags': {
                'basic':        flag('Prioritize Effectiveness'),
                'eval_att':     flag('Evaluate Attacks'),
                'expert':       flag('Expert'),
                'status':       flag('Prioritize Status'),
                'risky':        flag('Risky Attacks'),
                'damage_prio':  flag('Prioritize Damage'),
                'baton_pass':   False,
                'tag_ai':       flag('Double Battle'),
                'check_hp':     flag('Prioritize Healing'),
                'weather':      flag('Utilize Weather'),
                'harassment':   flag('Harassment'),
            },
            'pokemon': [],
        }

    # Per-Pokémon slot columns (6 slots, each 11 columns wide)
    slot_offsets = [0, 11, 22, 33, 44, 55]
    base_cols = ['Difficulty Value', 'Ability Number', 'Level', 'Species',
                 'Form Number', 'Held Item', 'Move 1', 'Move 2', 'Move 3', 'Move 4', 'Ball Seal']

    for _, row in trainer_poke_df.iterrows():
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
            col_idx = 2 + offset  # first slot starts at col index 2
            try:
                species = _val(row.iloc[col_idx + 3])
            except IndexError:
                break
            if not species:
                continue
            try:
                level  = int(row.iloc[col_idx + 2]) if not pd.isna(row.iloc[col_idx + 2]) else 0
                item   = _val(row.iloc[col_idx + 5])
                move1  = _val(row.iloc[col_idx + 6])
                move2  = _val(row.iloc[col_idx + 7])
                move3  = _val(row.iloc[col_idx + 8])
                move4  = _val(row.iloc[col_idx + 9])
            except IndexError:
                level  = 0
                item   = None
                move1  = move2 = move3 = move4 = None

            moves = [m for m in [move1, move2, move3, move4] if m and m != '-']
            trainers[tid]['pokemon'].append({
                'slot':    len(trainers[tid]['pokemon']),
                'level':   level,
                'species': species,
                'nature':  None,
                'ability': None,
                'item':    item,
                'moves':   moves,
            })

    # Also pull data from boss-split sheets and merge/supplement
    boss_trainers = []
    for sheet_name in BOSS_SPLITS:
        try:
            df = xl.parse(sheet_name, header=None)
            boss_trainers.extend(_parse_split_sheet(df))
        except Exception as e:
            print(f'  Warning: could not parse {sheet_name}: {e}')

    # Index boss trainers by name for quick lookup
    boss_by_name = {}
    for bt in boss_trainers:
        boss_by_name.setdefault(bt['name'], bt)

    # Build final output: combine both sources
    result = {}
    for tid, tdata in trainers.items():
        key = f"{tdata['name']}_{tid}"
        result[key] = tdata

    # Add boss-split trainers not already present (by name)
    existing_names = {v['name'] for v in trainers.values()}
    for bt_name, bt in boss_by_name.items():
        # Try to find match in existing trainers
        matched = False
        for tid, tdata in trainers.items():
            if tdata['name'] == bt_name:
                # Supplement AI flags from split sheet if richer
                if bt['ai_flags']:
                    for flag, val in bt['ai_flags'].items():
                        if val:
                            tdata['ai_flags'][flag] = True
                matched = True
                break
        if not matched:
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
