"""
parse_save.py
Uses pythonnet to bind PKHeX.Core.dll and extract Gen 4 save-file data.

The function parse_save_bytes(raw_bytes) accepts a bytes object representing
a raw Gen 4 .sav file and returns a dict with party and box Pokémon lists.
"""

import os
import json

DLL_PATH = os.path.join(os.path.dirname(__file__), 'PKHeX.Core.dll')
KAIZO_DATA_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'kaizo_data.json')

_pkhex_loaded = False
_move_id_to_name: dict | None = None


def _load_pkhex():
    global _pkhex_loaded
    if _pkhex_loaded:
        return
    try:
        import clr  # type: ignore  # provided by pythonnet
        clr.AddReference(DLL_PATH)
        _pkhex_loaded = True
    except Exception as exc:
        raise RuntimeError(
            f'Failed to load PKHeX.Core.dll from {DLL_PATH}: {exc}'
        ) from exc


def _get_move_id_map() -> dict:
    """Build a move-ID → move-name lookup from kaizo_data.json."""
    global _move_id_to_name
    if _move_id_to_name is not None:
        return _move_id_to_name
    try:
        with open(KAIZO_DATA_PATH, encoding='utf-8') as f:
            kaizo = json.load(f)
        mapping = {}
        for name, data in kaizo.get('moves', {}).items():
            mid = data.get('id')
            if mid is not None:
                mapping[int(mid)] = name
        _move_id_to_name = mapping
    except Exception:
        _move_id_to_name = {}
    return _move_id_to_name


def _resolve_move(move_id: int) -> str:
    """Convert a raw move ID to a human-readable move name."""
    if move_id == 0:
        return ''
    # Try PKHeX GameInfo strings first (covers standard Gen 4 moves)
    try:
        from PKHeX.Core import GameInfo  # type: ignore
        strings = GameInfo.GetStrings('en')
        name = str(strings.Move[move_id])
        if name and name != '0':
            return name
    except Exception:
        pass
    # Fall back to the Kaizo move-ID map
    return _get_move_id_map().get(move_id, str(move_id))


def _pk_to_dict(pk, source: str, box: int | None, slot_idx: int) -> dict:
    """Convert a PKM object to a serialisable dict."""
    evs = {
        'hp':  int(pk.EV_HP),
        'atk': int(pk.EV_ATK),
        'def': int(pk.EV_DEF),
        'spa': int(pk.EV_SPA),
        'spd': int(pk.EV_SPD),
        'spe': int(pk.EV_SPE),
    }
    ivs = {
        'hp':  int(pk.IV_HP),
        'atk': int(pk.IV_ATK),
        'def': int(pk.IV_DEF),
        'spa': int(pk.IV_SPA),
        'spd': int(pk.IV_SPD),
        'spe': int(pk.IV_SPE),
    }
    moves = [
        _resolve_move(int(pk.Move1)),
        _resolve_move(int(pk.Move2)),
        _resolve_move(int(pk.Move3)),
        _resolve_move(int(pk.Move4)),
    ]

    entry = {
        'source':  source,           # 'party' or 'box'
        'slot':    slot_idx,
        'species': str(pk.Species),
        'level':   int(pk.CurrentLevel),
        'nature':  str(pk.Nature),
        'ability': str(pk.Ability),
        'item':    str(pk.HeldItem),
        'evs':     evs,
        'ivs':     ivs,
        'moves':   [m for m in moves if m],
    }
    if source == 'party':
        entry['hp'] = int(pk.Stat_HPCurrent)
        entry['max_hp'] = int(pk.Stat_HPMax)
    if box is not None:
        entry['box'] = box
    return entry


def parse_save_bytes(raw_bytes: bytes) -> dict:
    """
    Parse a Gen 4 .sav byte array with PKHeX.Core.

    Returns:
    {
        "party": [ <pokemon dict>, … ],   # up to 6 party members
        "boxes":  [ <pokemon dict>, … ],  # all non-empty PC box slots
    }

    Each Pokémon dict contains:
    {
        "source":  "party" | "box",
        "slot":    int,
        "box":     int,          # only present for box Pokémon
        "species": str,
        "level":   int,
        "nature":  str,
        "ability": str,
        "item":    str,
        "hp":      int,          # only present for party Pokémon
        "max_hp":  int,          # only present for party Pokémon
        "evs":     { … },
        "ivs":     { … },
        "moves":   [str, …],
    }
    """
    _load_pkhex()

    try:
        from PKHeX.Core import SaveUtil  # type: ignore
        import System  # type: ignore

        net_bytes = System.Array[System.Byte](list(raw_bytes))
        sav = SaveUtil.GetVariantSAV(net_bytes)
        if sav is None:
            raise ValueError('PKHeX could not recognise this save file.')

        # ── Party ──────────────────────────────────────────────────────────
        party = []
        for slot_idx in range(sav.PartyCount):
            pk = sav.GetPartySlot(sav.PartyBuffer, slot_idx)
            if pk is None or pk.Species == 0:
                continue
            party.append(_pk_to_dict(pk, 'party', None, slot_idx))

        # ── Boxes ──────────────────────────────────────────────────────────
        boxes = []
        box_count = int(sav.BoxCount)
        box_slot_count = int(sav.BoxSlotCount)
        for box_idx in range(box_count):
            for slot_idx in range(box_slot_count):
                abs_idx = box_idx * box_slot_count + slot_idx
                try:
                    pk = sav.GetBoxSlotAtIndex(abs_idx)
                except Exception:
                    break  # API not available, stop box parsing
                if pk is None or pk.Species == 0:
                    continue
                boxes.append(_pk_to_dict(pk, 'box', box_idx, slot_idx))

        return {'party': party, 'boxes': boxes}

    except Exception as exc:
        raise RuntimeError(f'Error parsing save file: {exc}') from exc
