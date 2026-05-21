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
    'Prioritize Effectiveness': 'basic',          
    'Evaluate Attacks':         'eval_att',        
    'Expert':                   'expert',          
    'Prioritize Status':        'status',          
    'Risky Attacks':            'risky',           
    'Prioritize Damage':        'damage_prio',     
    'Partner':                  'tag_strategy',    
    'Double Battle':            'double_battle',   
    'Prioritize Healing':       'check_hp',        
    'Utilize Weather':          'weather',         
    'Harassment':               'harassment', 
    'Baton Pass':                'baton_pass'
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clean_stat(value):
    s = str(value).strip()
    m = re.match(r'^(\d+)', s)
    if m:
        return int(m.group(1))
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return 0


def _val(v):
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
            'uncommon_item': _val(row.get('Uncommon Held Item')),
            'rare_item': _val(row.get('Rare Held Item')),
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
        moves[name] = {
            'id':       int(row['ID Number']) if not pd.isna(row.get('ID Number', float('nan'))) else 0,
            'category': _val(row.get('Category')) or 'Physical',
            'power':    _clean_stat(row.get('Power', 0)),
            'type':     _val(row.get('Type')) or 'Normal',
            'accuracy': _clean_stat(row.get('Accuracy', 0)),
            'pp':       int(row['PP']) if not pd.isna(row.get('PP', float('nan'))) else 0,
        }
    return moves


# ---------------------------------------------------------------------------
# Phase 1c – RAW TRAINER DATA: build an authoritative AI-flags lookup
# ---------------------------------------------------------------------------

def _build_raw_trainer_lookup(xl):
    df = xl.parse('RAW TRAINER DATA', header=0)
    df.columns = [str(c).strip() for c in df.columns]
    
    raw_trainers = []
    for _, row in df.iterrows():
        name = _val(row.get('Name'))
        if not name or name == '-':
            continue
            
        active = []
        for col, short in AI_FLAG_COLS.items():
            v = row.get(col)
            if pd.isna(v):
                continue
            if isinstance(v, str):
                if v.strip().upper() in ('TRUE', '1', 'YES', 'Y'):
                    active.append(short)
            else:
                if bool(v):
                    active.append(short)
        
        try:
            num_pokemon = int(row.get('Number of Pokemon', 1))
        except (ValueError, TypeError):
            num_pokemon = 1
            
        raw_trainers.append({
            'name': name.lower(),
            'num_pokemon': num_pokemon,
            'flags': active
        })
            
    return raw_trainers


def _flags_for_split_name(split_name: str, num_pokemon: int, raw_trainers: list) -> list:
    plain = re.sub(r'\s*\(.*?\)', '', split_name).strip()
    plain = re.sub(r'#\d+', '', plain).strip()
    plain = re.sub(r'\*', '', plain).strip()
    plain = re.sub(r'\s+', ' ', plain)

    candidates = []
    seen = set()

    def add_candidate(value):
        key = value.strip().lower()
        if key and key not in seen:
            seen.add(key)
            candidates.append(key)

    add_candidate(plain)

    words = [w for w in plain.split() if w]
    for start in range(len(words) - 1, -1, -1):
        add_candidate(' '.join(words[start:]))

    stripped_words = [re.sub(r"[^A-Za-z&'-]", '', w) for w in words]
    stripped_words = [w for w in stripped_words if w]
    for start in range(len(stripped_words) - 1, -1, -1):
        add_candidate(' '.join(stripped_words[start:]))

    for part in re.split(r'&|/|,', plain):
        part = part.strip()
        if not part:
            continue
        add_candidate(part)
        part_words = [re.sub(r"[^A-Za-z'-]", '', w) for w in part.split()]
        part_words = [w for w in part_words if w]
        if part_words:
            add_candidate(part_words[-1])

    # 1. Primary Check: Exact Name & Exact Number of Pokemon
    for candidate in candidates:
        for rt in raw_trainers:
            if candidate == rt['name'] and rt['num_pokemon'] == num_pokemon:
                return rt['flags']

    # 2. Fallback Check: Name only match
    best_flags = []
    matched = False
    for candidate in candidates:
        for rt in raw_trainers:
            if candidate == rt['name']:
                matched = True
                if len(rt['flags']) > len(best_flags):
                    best_flags = rt['flags']
        if matched:
            return best_flags

    return []


# ---------------------------------------------------------------------------
# Phase 1d: Parse boss-split sheets → trainer roster data
# ---------------------------------------------------------------------------

def _parse_split_sheet(df):
    trainers = []
    current_trainer = None
    moves_row_count = 0

    for i in range(len(df)):
        row = df.iloc[i]

        # ---- Robust row label detection scanning ALL columns ----
        row_label = ""
        for col_idx in range(len(row)):
            val = _val(row.iloc[col_idx])
            if val:
                v_lower = str(val).lower().strip()
                if v_lower in ('pokemon', 'pokémon', 'pokèmon'):
                    row_label = 'pokemon'
                    break
                elif v_lower == 'nature':
                    row_label = 'nature'
                    break
                elif v_lower == 'item':
                    row_label = 'item'
                    break
                elif v_lower == 'moves':
                    row_label = 'moves'
                    break
        
        # --- Auto-detect trainer block if 'pokemon' label is missing but 'Lv.' exists ---
        is_pokemon_row = False
        dynamic_slot_cols = []
        
        if row_label == 'pokemon':
            is_pokemon_row = True
        
        # Find any column that explicitly defines a Pokemon Level
        for col_idx in range(len(row)):
            val = _val(row.iloc[col_idx])
            if val and re.search(r'^Lv\.?\s*\d+', str(val).strip(), re.IGNORECASE):
                if col_idx not in dynamic_slot_cols:
                    dynamic_slot_cols.append(col_idx)
                is_pokemon_row = True
        
        # ---- Detect Trainer Block ----
        if is_pokemon_row:
            trainer_name = "Unknown Trainer"
            # Scan upwards (up to 15 rows) to find the closest valid name
            for j in range(i - 1, max(-1, i - 15), -1):
                prev_row = df.iloc[j]
                found_name = False
                for c in range(min(15, len(prev_row))):
                    t_name = _val(prev_row.iloc[c])
                    if t_name and len(t_name) > 2:
                        t_name_lower = t_name.lower()
                        
                        # Strict ignore filters so we don't grab generic headers instead of names
                        exact_ignore = ['nature', 'item', 'moves', 'pokemon', 'pokémon', 'pokèmon']
                        partial_ignore = ['ai flag', 'level cap', 'key:', 'basic', 'expert', 'eval att', 'prioritize']
                        
                        is_noise = False
                        if t_name_lower in exact_ignore:
                            is_noise = True
                        for pi in partial_ignore:
                            if pi in t_name_lower:
                                is_noise = True
                        
                        if not is_noise:
                            trainer_name = t_name.strip()
                            found_name = True
                            break
                if found_name:
                    break

            # If no levels were found (e.g., empty row labeled 'pokemon'), fallback
            if not dynamic_slot_cols:
                dynamic_slot_cols = [4, 6, 8, 10, 12, 14]

            current_trainer = {
                'name':       trainer_name,
                'ai_flags':   [], 
                'pokemon':    [],
                '_slot_cols': dynamic_slot_cols # Track where the Pokemon were found
            }
            trainers.append(current_trainer)
            moves_row_count = 0

            # Parse Pokémon slots strictly from dynamic columns
            for sc in dynamic_slot_cols:
                val = _val(row.iloc[sc]) if sc < len(row) else None
                if val:
                    m = re.match(r'^Lv\.?\s*(\d+)\s+(.+?)(?:\s+[♂♀])?$', val.strip(), re.IGNORECASE)
                    if m:
                        level   = int(m.group(1))
                        species = m.group(2).strip()
                    else:
                        level   = 0
                        species = val.strip()
                    
                    species = species.split('@')[0].strip()

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
        elif row_label == 'nature' and current_trainer is not None:
            sc_list = current_trainer.get('_slot_cols', [4, 6, 8, 10, 12, 14])
            for idx, sc in enumerate(sc_list):
                if idx >= len(current_trainer['pokemon']):
                    break
                nat = _val(row.iloc[sc])     if sc     < len(row) else None
                # Abilities usually reside exactly one column to the right of the Nature
                abl = _val(row.iloc[sc + 1]) if sc + 1 < len(row) else None
                
                if nat and nat not in ('(None)', '-'):
                    current_trainer['pokemon'][idx]['nature']  = nat
                if abl and abl not in ('(None)', '-'):
                    current_trainer['pokemon'][idx]['ability'] = abl

        # ---- Item row ----
        elif row_label == 'item' and current_trainer is not None:
            sc_list = current_trainer.get('_slot_cols', [4, 6, 8, 10, 12, 14])
            for idx, sc in enumerate(sc_list):
                if idx >= len(current_trainer['pokemon']):
                    break
                item = _val(row.iloc[sc]) if sc < len(row) else None
                if item and item not in ('(None)', '-'):
                    current_trainer['pokemon'][idx]['item'] = item

        # ---- Moves rows ----
        elif (row_label == 'moves' or (current_trainer and 0 < moves_row_count < 4)):
            if row_label == 'moves':
                moves_row_count = 1
            else:
                moves_row_count += 1
            
            if current_trainer is not None:
                sc_list = current_trainer.get('_slot_cols', [4, 6, 8, 10, 12, 14])
                for idx, sc in enumerate(sc_list):
                    if idx >= len(current_trainer['pokemon']):
                        break
                    mv = _val(row.iloc[sc]) if sc < len(row) else None
                    if mv and mv not in ('(None)', '-'):
                        # ENFORCE CAP AT 4 MOVES
                        if len(current_trainer['pokemon'][idx]['moves']) < 4:
                            current_trainer['pokemon'][idx]['moves'].append(mv)

    # Clean up internal tracking data
    for t in trainers:
        t.pop('_slot_cols', None)

    return trainers


def parse_trainer_db(xl):
    raw_trainers = _build_raw_trainer_lookup(xl)
    split_groups = {}
    
    for sheet_name in BOSS_SPLITS:
        try:
            df = xl.parse(sheet_name, header=None)
            parsed = _parse_split_sheet(df)
        except Exception as e:
            print(f'  Warning: could not parse {sheet_name}: {e}')
            continue

        clean_trainers = []
        for trainer in parsed:
            name = _val(trainer.get('name'))
            if not name:
                continue
            name = re.sub(r'\s+', ' ', name).strip()
            
            # Allow generic trainer names through so we don't accidentally drop valid teams
            if name in ('AI Flag Key:',) or 'PLATINUM KAIZO' in name.upper():
                continue
            if not trainer.get('pokemon'):
                continue

            num_pokemon = len(trainer['pokemon'])
            resolved_flags = list(_flags_for_split_name(name, num_pokemon, raw_trainers))
            
            if re.search(r"\bDOUBLE\b|MULTI\s*BATTLE", name, re.IGNORECASE):
                if 'double_battle' not in resolved_flags:
                    resolved_flags.append('double_battle')

            clean_trainers.append({
                'name': name,
                'split': sheet_name,
                'ai_flags': resolved_flags,
                'pokemon': trainer['pokemon'],
            })

        split_groups[sheet_name] = clean_trainers

    return split_groups


# ---------------------------------------------------------------------------
# Phase 1e: Parse Level-Up Learnsets sheet → per-Pokémon move list
# ---------------------------------------------------------------------------

def parse_learnsets(xl):
    df = xl.parse('Level-Up Learnsets', header=0)
    learnsets = {}

    cols = df.columns.tolist()
    move_col_names = [c for c in cols if 'Move' in str(c) and 'Level' not in str(c)]

    def level_col_for(move_col):
        return move_col.replace('Move', 'Level')

    for _, row in df.iterrows():
        name = _val(row.get('Name'))
        if not name or name == '-----':
            continue

        pairs = []
        for mc in move_col_names:
            lc = level_col_for(mc)
            move_name = _val(row.get(mc))
            level_val = row.get(lc)
            if not move_name:
                continue
            try:
                lvl = int(float(level_val)) if level_val is not None and not pd.isna(level_val) else 0
            except (ValueError, TypeError):
                lvl = 0
            pairs.append({'move': move_name, 'level': lvl})

        pairs.sort(key=lambda p: p['level'])
        learnsets[name] = pairs

    return learnsets


# ---------------------------------------------------------------------------
# Phase 1f: Parse TM Learnsets sheet → per-Pokémon TM/HM move list
# ---------------------------------------------------------------------------

def parse_tm_learnsets(xl):
    df = xl.parse('TM Learnsets', header=0)
    if df.empty:
        return {}

    tm_cols = [c for c in df.columns if str(c).startswith('TM') or str(c).startswith('HM')]
    if not tm_cols:
        return {}

    mapping_row = df[df['Name'].isna()].head(1)
    if mapping_row.empty:
        return {}
    mapping_row = mapping_row.iloc[0]

    tm_to_move = {}
    for tm_col in tm_cols:
        move_name = _val(mapping_row.get(tm_col))
        if move_name:
            tm_to_move[tm_col] = move_name

    tm_learnsets = {}
    for _, row in df.iterrows():
        name = _val(row.get('Name'))
        if not name or name == '-----':
            continue

        moves = []
        for tm_col, move_name in tm_to_move.items():
            value = row.get(tm_col)
            try:
                can_learn = bool(value) and not pd.isna(value)
            except (TypeError, ValueError):
                can_learn = False
            if can_learn:
                moves.append(move_name)

        tm_learnsets[name] = sorted(set(moves))

    return tm_learnsets


# ---------------------------------------------------------------------------
# Phase 1g: Parse Evolutions sheet → evolution ancestry map
# ---------------------------------------------------------------------------

def parse_pre_evolutions(xl):
    df = xl.parse('Evolutions', header=0)
    direct_prevos = {}
    result_cols = [c for c in df.columns if str(c).startswith('Result')]

    for _, row in df.iterrows():
        src = _val(row.get('Name'))
        if not src or src == '-----':
            continue

        for rc in result_cols:
            evo = _val(row.get(rc))
            if not evo or evo == '-----':
                continue
            direct_prevos.setdefault(evo, set()).add(src)

    all_species = set(df['Name'].dropna().astype(str).tolist())
    all_species.discard('-----')
    all_species.update(direct_prevos.keys())

    pre_evolutions = {}

    def gather_ancestors(species, seen=None):
        if seen is None:
            seen = set()
        result = []
        for pre in sorted(direct_prevos.get(species, set())):
            if pre in seen:
                continue
            seen.add(pre)
            result.append(pre)
            result.extend(gather_ancestors(pre, seen))
        return result

    for species in sorted(all_species):
        ancestors = gather_ancestors(species)
        deduped = []
        seen = set()
        for mon in ancestors:
            if mon not in seen:
                deduped.append(mon)
                seen.add(mon)
        pre_evolutions[species] = deduped

    return pre_evolutions


# ---------------------------------------------------------------------------
# Phase 1h: Parse Items sheet → valid item list
# ---------------------------------------------------------------------------

def parse_items(xl):
    df = xl.parse('Items', header=0)
    items = []
    for _, row in df.iterrows():
        name = _val(row.get('Name'))
        if name and name != '-----':
            items.append(name)
    return sorted(set(items))


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

    print('Parsing Level-Up Learnsets sheet …')
    learnsets = parse_learnsets(xl)
    print(f'  → {len(learnsets)} Pokémon learnsets')

    print('Parsing TM Learnsets sheet …')
    tm_learnsets = parse_tm_learnsets(xl)
    print(f'  → {len(tm_learnsets)} Pokémon TM/HM learnsets')

    print('Parsing Evolutions sheet …')
    pre_evolutions = parse_pre_evolutions(xl)
    print(f'  → {len(pre_evolutions)} evolution ancestry entries')

    print('Parsing Items sheet …')
    items = parse_items(xl)
    print(f'  → {len(items)} items')

    kaizo_data = {
        'pokemon': pokemon,
        'moves': moves,
        'learnsets': learnsets,
        'tm_learnsets': tm_learnsets,
        'pre_evolutions': pre_evolutions,
        'items': items,
    }
    out_path = os.path.join(OUT_DIR, 'kaizo_data.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(kaizo_data, f, indent=2, ensure_ascii=False)
    print(f'Written {out_path}')

    print('Parsing trainer sheets …')
    trainer_db = parse_trainer_db(xl)
    trainer_count = sum(len(group) for group in trainer_db.values())
    print(f'  → {trainer_count} trainers across {len(trainer_db)} splits')

    out_path2 = os.path.join(OUT_DIR, 'trainer_db.json')
    with open(out_path2, 'w', encoding='utf-8') as f:
        json.dump(trainer_db, f, indent=2, ensure_ascii=False)
    print(f'Written {out_path2}')

    print('Done.')

if __name__ == '__main__':
    main()