# Platinum Kaizo VGC Calculator & AI Predictor

A mathematically precise, full-stack Damage Calculator and AI Move Predictor built specifically for the **Pokémon Platinum Kaizo** ROM hack.

Unlike standard damage calculators, this tool features an authentic, meticulously reverse-engineered Generation 4 AI Engine. It doesn't just tell you how much damage a move will do—it runs 10,000-iteration Monte Carlo simulations to predict *exactly* what the opponent's AI will do, taking into account specific Gen 4 engine quirks, AI flags, and Kaizo-specific boss behavior.

## 🌟 Core Features

### 🧠 Authentic Gen 4 AI Engine

* **Monte Carlo Probabilities:** Instead of flawed "expected value" math, the AI engine runs 10,000 simulated turns per calculation. It rolls RNG against active AI Flags (e.g., *Evaluate Attack*, *Expert*, *Risky*) to give you mathematically perfect probability percentages for the opponent's next move.
* **Flawless Switch AI:** Replicates the complex, two-phase Generation 4 switch-in logic. It correctly handles Phase 1 (Super Effective scoring) and Phase 2 (Highest Damaging Move), fully preserving authentic engine anomalies like the **8-bit damage overflow bug** and the +8 score wrap-around bug.
* **Kaizo-Specific Logic:** Fully implements exact AI behaviors, including Turn 1 weather setups, priority KO bonuses (+4 score), and strict "Fake Out" rules (scoring +2 on Turn 1 via Expert flag, and penalized by -10 on subsequent turns).
* **Doubles Support:** Includes comprehensive *Tag Strategy* logic for VGC formats, allowing the AI to correctly evaluate partner interactions (e.g., avoiding Earthquake if the partner lacks Levitate, or utilizing Skill Swap on Truant/Slow Start).

### 📊 Automated Database Compilation

* **Direct from the Docs:** A robust Python backend pipeline (`build_database.py`) parses the official *Platinum Kaizo Docs.xlsx* spreadsheet directly.
* **Dynamic Trainer Injection:** Automatically maps complex boss splits (e.g., Roark, Cynthia) to their internal RAW TRAINER DATA flags, handling edge cases, generic name overwrites, and missing boolean values to ensure perfect AI profiles.

### 🖥️ High-Performance UI

* **React + Vite Dashboard:** A highly responsive, component-based dashboard utilizing a unified Slate/Blue professional aesthetic.
* **Decoupled Architecture:** Built to prevent global re-renders. Stat matrices, move selections, and field conditions operate independently, ensuring a lag-free experience even during massive calculations.

---

## 🏗️ Project Architecture

This is a monorepo consisting of a Python backend and a React/TypeScript frontend.

* **`/backend`**: Houses the `build_database.py` script for parsing the Kaizo Excel document into JSON datasets (`kaizo_data.json`, `trainer_db.json`). Also includes `parse_save.py` which utilizes `PKHeX.Core.dll` for reading `.sav` files to directly import your team state.
* **`/frontend`**: A Vite + React application. Contains the complex UI components and the `/src/engine/` directory, which holds the core `aiPredictor.ts` and `switchAI.ts` prediction algorithms.

---

## 🚀 Installation & Setup

### Prerequisites

* **Node.js** (v18+ recommended)
* **Python** (3.10+ recommended)
* **Platinum Kaizo Docs.xlsx** (Must be placed in the `/data` directory)

### 1. Backend Setup & Database Build

First, set up the Python environment and compile the game database.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Run the database builder to parse the Excel document
python build_database.py

```

*Note: This will generate `kaizo_data.json` and `trainer_db.json` in the `/data` directory.*

### 2. Frontend Setup

```bash
cd ../frontend
npm install

```

### 3. Running the Application

You can run the full stack simultaneously using the provided scripts from the root directory:

**Windows:**

```powershell
./scripts/run-dev.ps1

```

**Mac/Linux:**

```bash
chmod +x scripts/run-dev.sh
./scripts/run-dev.sh

```

The frontend will be available at `http://localhost:5173`.

---

## ⚙️ How the Prediction Engine Works

When an enemy is loaded, the tool checks `trainer_db.json` for their specific AI flags.

1. **Base Initialization:** All available moves start with a base score of 100.
2. **Flag Evaluation:** The engine passes the moves through every active flag (Basic, Eval Attack, Expert, Prioritize Status, etc.).
3. **Gen 4 Emulation:** Specific routines are executed. For instance, if the *Evaluate Attack* flag is active, the engine checks raw damage rolls. If a move guarantees a KO, it receives a +4 score modifier.
4. **Simulation:** Because some flags only trigger a percentage of the time (e.g., 80% chance to penalize a risky move), the system simulates the interaction 10,000 times, rolling the dice on the percentages, resolving the highest score, and tallying the winner. The final output on the UI represents the exact statistical likelihood of each move being chosen by the in-game engine.
