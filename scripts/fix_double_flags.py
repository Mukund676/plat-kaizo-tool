#!/usr/bin/env python3
"""
Scan data/trainer_db.json and remove any occurrence of the "double_battle"
AI flag for trainer entries whose name does NOT indicate a double or multi
battle (i.e. the trainer name does not contain "DOUBLE" or "MULTI BATTLE").

Creates a .bak of the original file and writes back safely.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(__file__))
DB_PATH = os.path.join(ROOT, 'data', 'trainer_db.json')


def is_double_by_name(name: str) -> bool:
    if not name:
        return False
    n = name.upper()
    # Consider names containing the words DOUBLE or the phrase MULTI BATTLE
    if 'DOUBLE' in n:
        return True
    if 'MULTI BATTLE' in n:
        return True
    return False


def main():
    with open(DB_PATH, 'r', encoding='utf-8') as f:
        data = json.load(f)

    total_trainer_entries = 0
    removed_count = 0

    for split, trainers in list(data.items()):
        if not isinstance(trainers, list):
            continue
        for t in trainers:
            if not isinstance(t, dict):
                continue
            total_trainer_entries += 1
            name = t.get('name')
            flags = t.get('ai_flags')
            if not flags or 'double_battle' not in flags:
                continue
            if not is_double_by_name(name):
                # remove all occurrences of the flag
                new_flags = [f for f in flags if f != 'double_battle']
                t['ai_flags'] = new_flags
                removed_count += 1

    if removed_count == 0:
        print('No erroneous double_battle flags found.')
        return

    bak = DB_PATH + '.bak'
    tmp = DB_PATH + '.tmp'
    # create backup
    try:
        if os.path.exists(bak):
            os.remove(bak)
        os.replace(DB_PATH, bak)
    except Exception:
        # if replace failed, try copying
        import shutil
        shutil.copy2(DB_PATH, bak)

    # write updated
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DB_PATH)

    print(f'Removed {removed_count} double_battle flags from {total_trainer_entries} trainer entries. Backup saved to {bak}')


if __name__ == '__main__':
    main()
