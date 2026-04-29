"""
app.py
Flask API for the Platinum Kaizo VGC Calculator & Router.

Endpoints:
  POST /api/upload-save   – accept a Gen 4 .sav file (multipart/form-data)
                            and return the parsed player party as JSON.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


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
        party = parse_save_bytes(raw_bytes)
    except RuntimeError as exc:
        return jsonify({'error': str(exc)}), 500

    return jsonify({'party': party})


@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
