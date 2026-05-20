"""
app.py
Flask API for the Platinum Kaizo VGC Calculator & Router.

Endpoints:
  POST /api/upload-save   – accept a Gen 4 .sav file (multipart/form-data)
                            and return the parsed player party as JSON.
  POST /api/save-trainer-flags – save AI flags for a specific trainer to trainer_db.json
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
import shutil

app = Flask(__name__)
CORS(app)

# Path to trainer_db.json
TRAINER_DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'trainer_db.json')


@app.route('/api/upload-save', methods=['POST'])
def upload_save():
    """
    Accept a raw Gen 4 .sav file uploaded as multipart/form-data under the
    key 'save'.  Parse it entirely in memory (no disk writes) and return the
    active party roster as JSON.
    """
    if 'save' not in request.files:
        return jsonify({'error': 'No file provided. Send the .sav under key "save".'}), 400

    file = request.files['save']
    raw_bytes = file.read()  # read entirely into memory – never saved to disk

    try:
        from parse_save import parse_save_bytes
        result = parse_save_bytes(raw_bytes)
    except RuntimeError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify(result)


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


@app.route('/api/save-trainer-flags', methods=['POST'])
def save_trainer_flags():
    """
    Save AI flags for a specific trainer to trainer_db.json
    
    Expected JSON body:
    {
      "trainerName": string,
      "trainerSplit": string,
      "aiFlags": string[]
    }
    """
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No JSON body provided'}), 400

        trainer_name = data.get('trainerName')
        trainer_split = data.get('trainerSplit')
        ai_flags = data.get('aiFlags', [])

        if not trainer_name or not trainer_split:
            return jsonify({'error': 'Missing trainerName or trainerSplit'}), 400

        # Load trainer_db.json
        if not os.path.exists(TRAINER_DB_PATH):
            return jsonify({'error': f'trainer_db.json not found at {TRAINER_DB_PATH}'}), 404

        # Read using UTF-8 to avoid Windows default 'charmap' decoding errors
        try:
            with open(TRAINER_DB_PATH, 'r', encoding='utf-8') as f:
                trainer_db = json.load(f)
        except UnicodeDecodeError as ude:
            return jsonify({'error': f'Failed to read trainer_db.json due to encoding error: {ude}'}), 500

        # Find the trainer by split and name
        split_key = f"{trainer_split} Split"
        if split_key not in trainer_db:
            # Try without " Split" suffix
            matching_keys = [k for k in trainer_db.keys() if trainer_split in k]
            if matching_keys:
                split_key = matching_keys[0]
            else:
                return jsonify({'error': f'Split "{trainer_split}" not found in trainer_db'}), 404

        trainers_in_split = trainer_db[split_key]
        if not isinstance(trainers_in_split, list):
            return jsonify({'error': f'Invalid trainer_db structure for split "{split_key}"'}), 500

        # Find trainer by name
        trainer_idx = None
        for idx, trainer in enumerate(trainers_in_split):
            if trainer.get('name') == trainer_name:
                trainer_idx = idx
                break

        if trainer_idx is None:
            return jsonify({'error': f'Trainer "{trainer_name}" not found in split "{trainer_split}"'}), 404

        # Update the trainer's ai_flags
        trainers_in_split[trainer_idx]['ai_flags'] = ai_flags

        # Write back to trainer_db.json safely: backup + atomic replace, using UTF-8
        try:
            backup_path = TRAINER_DB_PATH + '.bak'
            shutil.copyfile(TRAINER_DB_PATH, backup_path)
        except Exception:
            # non-fatal if backup fails; proceed to attempt write
            pass

        tmp_path = TRAINER_DB_PATH + '.tmp'
        try:
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(trainer_db, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, TRAINER_DB_PATH)
        except Exception as write_exc:
            # Attempt to restore backup if available
            try:
                if os.path.exists(backup_path):
                    shutil.copyfile(backup_path, TRAINER_DB_PATH)
            except Exception:
                pass
            return jsonify({'error': f'Failed to write trainer_db.json: {write_exc}'}), 500

        return jsonify({
            'status': 'success',
            'message': f'Saved {len(ai_flags)} AI flags for {trainer_name}',
            'trainer': {
                'name': trainer_name,
                'split': trainer_split,
                'ai_flags': ai_flags,
            }
        }), 200

    except json.JSONDecodeError:
        return jsonify({'error': 'Invalid JSON'}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
