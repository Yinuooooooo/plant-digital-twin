# 🌞 Plant A — Digital Twin Monitor
**Enerparc Challenge · Energy Hack Munich · June 2026**

> *"PR gives you one number. We give you 65 — and the full story behind each one."*

---

## 🏆 Results

| Metric | Value |
|--------|-------|
| Total identified losses (2019–2025) | **€96,517** |
| Loss channels | Degradation · Faults · Curtailment |
| Inverter models trained | **65** (one per inverter) |
| Model accuracy (mean R²) | **0.965** |
| Training data | Year 1 (2017), ~37,000 readings/inverter |
| Validation | Years 2–10 (2018–2026) |

---

## 🎯 The Problem

Solar plants are traditionally monitored using a single metric —
**Performance Ratio (PR)**. But PR averages across all inverters.
When one inverter fails, its signal gets diluted across the fleet.
A device losing 15% of output barely moves the plant-level PR.

**We go inverter-level.**

---

## 💡 What We Built

A Digital Twin that monitors every inverter individually,
detects anomalies, attributes losses to specific causes,
and surfaces maintenance patterns — all in real time.

### Three Loss Channels

**A. Quality Issues — €79,446**
- Per-inverter LightGBM models detect degradation trends
- Module Type 12 degrades fastest (−4.3%/yr)
- Module Type 2 is actually improving (PI > 1.0)

**B. Equipment Faults — 109,760h downtime**
- Error code correlation with underperformance
- Top fault: 655616 (Power unit fault, r = −0.442)
- Maintenance history linkage detects recurring failures

**C. Curtailment — €16,997**
- DV/EVU signal tracks separate curtailment from faults
- 99.6% of curtailment losses from plant operator (DV)
- Grid operator (EVU) impact: negligible (€74 total)

---

## 🖥️ Live Dashboard

**[→ Open Dashboard](https://solartttt.lovable.app)**

Features:
- 65 inverter health cards (green / yellow / red)
- Click any inverter → detailed performance panel
- Predicted vs Actual power chart with financial loss tooltip
- Maintenance history with pattern detection
- Anomaly table with real error codes
- AI Assistant for natural language queries

---

## 🏗️ Architecture

```
Raw Data (CSV/Parquet)
    ↓
Feature Engineering (pvlib irradiance correction)
    ↓
Per-Inverter LightGBM Models (trained on Year 1)
    ↓
Performance Index = Actual / Predicted
    ↓
Anomaly Detection + Financial Attribution
    ↓
FastAPI Backend → Lovable React Dashboard
```

---

## 📁 Repository Structure

```
plant-digital-twin/
├── README.md
├── requirements.txt
├── notebooks/
│   ├── 01_data_exploration.ipynb
│   ├── 02_model_training.ipynb
│   ├── 03_anomaly_detection.ipynb
│   └── 04_financial_attribution.ipynb
├── src/
│   ├── features.py        # Feature engineering, pvlib correction
│   ├── model.py           # Per-inverter LightGBM training
│   ├── anomaly.py         # Performance Index calculation
│   ├── financial.py       # Loss attribution with feed-in tariffs
│   └── api.py             # FastAPI backend
├── data/
│   └── .gitkeep           # Data not included (Enerparc confidential)
└── dashboard/
    └── README.md          # Lovable dashboard documentation
```

---

## 🚀 How to Run

### Requirements
```bash
pip install -r requirements.txt
```

### requirements.txt
```
lightgbm
pvlib
scikit-learn
pandas
numpy
matplotlib
fastapi
uvicorn
jupyter
```

### Run Analysis
```bash
# Start with data exploration
jupyter notebook notebooks/01_data_exploration.ipynb

# Train all 65 models
python src/model.py

# Run anomaly detection
python src/anomaly.py

# Start API server
uvicorn src.api:app --reload
```

---

## 📊 Model Details

### Features
| Feature | Source | Description |
|---------|--------|-------------|
| `irradiation` | Pyranometer | Primary power driver |
| `sun_altitude` | Calculated | Filters night timestamps |
| `temperature_module` | Sensor | Efficiency correction |
| `temperature_ambient` | Sensor | Secondary correction |
| `hour` | Timestamp | Intraday pattern |
| `day_of_year` | Timestamp | Seasonal pattern |

### Training Strategy
```
Train:    Year 1 (2017) — healthy baseline
Validate: Years 2–10 (2018–2026)
Filter:   Altitude > 5°, no curtailment (DV/EVU = 0)
```

### Performance
```
Mean R²:   0.965  (range: 0.945–0.980)
Mean RMSE: 1.30 kW
All 65 models exceed R² = 0.945
```

---

## 👥 Team

| Name | Role |
|------|------|
| Chih-Chi Wang | ML modeling, data analysis, financial attribution |
| Yinuo | Frontend dashboard, data visualization, AI assistant |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| ML Models | LightGBM |
| Irradiance correction | pvlib |
| Data processing | pandas, numpy |
| Backend API | FastAPI |
| Dashboard | Lovable (React) |
| Visualizations | Recharts |

---

## 📝 Data

Data provided by **Enerparc** as part of the Energy Hack Munich 2026 challenge.

- Plant A: 10 years (2017–2026), 65 inverters, 5-minute resolution
- ~1M readings per inverter
- Includes: power output, DC voltage/current, irradiation,
  temperature, error codes, service tickets, feed-in tariffs

*Raw data not included in this repository (confidential).*

---

*Built in 24 hours at Energy Hack Munich · June 2026*
