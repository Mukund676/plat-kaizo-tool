"""
parse_save.py
Uses pythonnet to bind PKHeX.Core.dll and extract Gen 4 save-file data.

The function parse_save_bytes(raw_bytes) accepts a bytes object representing
a raw Gen 4 .sav file and returns a list of party Pokémon dictionaries.
"""

import os
import sys

DLL_PATH = os.path.join(os.path.dirname(__file__), 'PKHeX.Core.dll')

_pkhex_loaded = False


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


def parse_save_bytes(raw_bytes: bytes) -> list:
    """
    Parse a Gen 4 .sav byte array with PKHeX.Core.

    Returns a list of dicts, one per party member:
    {
        "slot":    int,
        "species": str,
        "level":   int,
        "nature":  str,
        "ability": str,
        "item":    str,
        "hp":      int,
        "max_hp":  int,
        "evs":     {"hp":int, "atk":int, "def":int, "spa":int, "spd":int, "spe":int},
        "ivs":     {"hp":int, "atk":int, "def":int, "spa":int, "spd":int, "spe":int},
        "moves":   [str, str, str, str],
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

        party = []
        for slot_idx in range(sav.PartyCount):
            pk = sav.GetPartySlot(sav.PartyBuffer, slot_idx)
            if pk is None or pk.Species == 0:
                continue

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
                str(pk.Move1_PP and pk.Move1 or ''),
                str(pk.Move2_PP and pk.Move2 or ''),
                str(pk.Move3_PP and pk.Move3 or ''),
                str(pk.Move4_PP and pk.Move4 or ''),
            ]

            party.append({
                'slot':    slot_idx,
                'species': str(pk.Species),
                'level':   int(pk.CurrentLevel),
                'nature':  str(pk.Nature),
                'ability': str(pk.Ability),
                'item':    str(pk.HeldItem),
                'hp':      int(pk.Stat_HPCurrent),
                'max_hp':  int(pk.Stat_HPMax),
                'evs':     evs,
                'ivs':     ivs,
                'moves':   moves,
            })

        return party

    except Exception as exc:
        raise RuntimeError(f'Error parsing save file: {exc}') from exc
