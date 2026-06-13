"""
Enerparc Hackathon – Plant A: Solar Inverter Underperformance Analysis
======================================================================
Pipeline:
  1. Load main monitoring data (column-efficient)
  2. Clean & filter (daytime, no curtailment, no outage)
  3. Train one LightGBM power model per inverter (2017 Jan–Sep)
  4. Validate on 2017 Oct–Dec
  5. Predict on 2018–2026, compute yearly Performance Index
  6. Compute financial losses using feed-in tariffs
  7. Group results by module type, generate plots

Run:
  conda activate solar
  python solar_analysis.py
"""

import os, warnings
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import seaborn as sns
import joblib
from lightgbm import LGBMRegressor
from sklearn.metrics import r2_score, mean_squared_error

warnings.filterwarnings("ignore")
BASE = os.path.dirname(os.path.abspath(__file__))

# ── paths ─────────────────────────────────────────────────────────────────────
MONITORING = os.path.join(BASE, "1. Main-monitoring-data", "main_monitoring_data.parquet")
ERRORCODES  = os.path.join(BASE, "3. Errorcodes",          "errorcodes.parquet")
SYSOVERVIEW = os.path.join(BASE, "2. Additional Data",     "System_Overview.xlsx")
TARIFFS     = os.path.join(BASE, "2. Additional Data",     "feed-in-tarrifs.xlsx")
OUT_DIR      = os.path.join(BASE, "results")
MODELS_DIR   = os.path.join(BASE, "results", "models")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(MODELS_DIR, exist_ok=True)

# ── constants ─────────────────────────────────────────────────────────────────
FEATURES = [
    "Plant / Irradiation_average (W/m²)",
    "Plant / Altitude (°)",
    "Temperature Sensor / Module (°C)",
    "Temperature Sensor / Ambient (°C)",
    "U_DC",          # placeholder, filled per inverter below
]
INTERVAL_H = 5 / 60          # 5-minute data → hours
IRR_THRESHOLD = 50            # W/m²  – below this = night
CURTAILMENT_THRESHOLD = 99    # % – EVU or DV below this = curtailed

# Operational State mapping
STATE_LABELS = {
    0: "cleared",
    1: "startup_ready",
    2: "starting",
    3: "running_alt",
    4: "running",      # ← main normal state
    5: "standby",
    6: "fault",
    262152: "anomaly", # DST clock glitch, only 2 rows total
}
NORMAL_STATES = {3, 4, 5}     # states where no real fault is occurring


# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 – SYSTEM OVERVIEW: inverter → module type mapping
# ══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("STEP 1 – Loading system overview")
print("=" * 60)

sysdf = pd.read_excel(SYSOVERVIEW, header=1)
sysdf.columns = [
    "Project", "Station", "Description", "WR_Type", "Location",
    "Row", "O", "Module_Type", "Manufacturer", "kWp_Module",
    "Modules", "PDC_kWp", "Strings", "Modules_per_String",
]
inv_meta = (
    sysdf[sysdf["WR_Type"] == "Inverter"]
    [["Description", "Module_Type", "Manufacturer", "kWp_Module", "PDC_kWp"]]
    .copy()
)
# Normalise inverter ID: "WR 01 .01 .001" → "INV 01.01.001"
# Step 1: remove "WR" prefix and all whitespace → "01.01.001"
# Step 2: prepend "INV " → "INV 01.01.001"
inv_meta["inv_id"] = (
    inv_meta["Description"]
    .str.replace(r"WR\s*", "", regex=True)   # drop WR
    .str.replace(r"\s+", "", regex=True)      # drop all spaces
    .str.replace(r"\.{2,}", ".", regex=True)  # normalise double dots
    .apply(lambda x: "INV " + x if pd.notna(x) else x)
)
# Build clean mapping dict
inv_module = inv_meta.set_index("inv_id")["Module_Type"].to_dict()
inv_pdckwp = inv_meta.set_index("inv_id")["PDC_kWp"].to_dict()

print(f"  Inverters found:   {len(inv_meta)}")
print(f"  Module types:      {inv_meta['Module_Type'].nunique()}")
print()


# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 – FEED-IN TARIFFS
# ══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("STEP 2 – Loading feed-in tariffs")
print("=" * 60)

tariff_raw = pd.read_excel(TARIFFS, header=None)
# Row 1 = dates (weekly), rows 2+ = inverter rows
dates = pd.to_datetime(tariff_raw.iloc[1, 1:].values, errors="coerce")
tariff_invs = tariff_raw.iloc[2:, 0].values
tariff_matrix = tariff_raw.iloc[2:, 1:].values.astype(float)
tariff_df = pd.DataFrame(tariff_matrix, index=tariff_invs, columns=dates)

# Melt to long format: inv_id, week_start, tariff_eurocent
tariff_long = tariff_df.stack().reset_index()
tariff_long.columns = ["inv_id", "week_start", "tariff_eurocent"]
tariff_long["year"] = tariff_long["week_start"].dt.year

# Average tariff per inverter per year
tariff_yearly = (
    tariff_long.groupby(["inv_id", "year"])["tariff_eurocent"]
    .mean()
    .reset_index()
)
print(f"  Tariff range: {tariff_yearly['tariff_eurocent'].min():.2f} – "
      f"{tariff_yearly['tariff_eurocent'].max():.2f} eurocent/kWh")
print()


# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 – LOAD MONITORING DATA (feature columns only first)
# ══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("STEP 3 – Loading monitoring features")
print("=" * 60)

SHARED_COLS = [
    "Plant / Irradiation_average (W/m²)",
    "Plant / Altitude (°)",
    "Temperature Sensor / Module (°C)",
    "Temperature Sensor / Ambient (°C)",
    "DRD11A / EVU (%)",
    "DRD11A / DV (%)",
]
shared = pd.read_parquet(MONITORING, columns=SHARED_COLS)
shared.index = pd.to_datetime(shared.index, format="mixed")
shared = shared.sort_index()

# Global daytime + no-curtailment mask
evu_ok = shared["DRD11A / EVU (%)"].fillna(100) >= CURTAILMENT_THRESHOLD
dv_ok  = shared["DRD11A / DV (%)"].fillna(100)  >= CURTAILMENT_THRESHOLD
irr_ok = shared["Plant / Irradiation_average (W/m²)"] > IRR_THRESHOLD
base_mask = irr_ok & evu_ok & dv_ok

# Fill tiny gaps in shared features (< 3 consecutive)
shared = shared.ffill(limit=2)

print(f"  Total rows:        {len(shared):>10,}")
print(f"  Daytime rows:      {irr_ok.sum():>10,}")
print(f"  After curtailment: {base_mask.sum():>10,}")
print()


# ══════════════════════════════════════════════════════════════════════════════
# STEP 4 – GET INVERTER LIST FROM PARQUET SCHEMA
# ══════════════════════════════════════════════════════════════════════════════
import pyarrow.parquet as pq
schema = pq.read_schema(MONITORING)
pac_cols = sorted([s for s in schema.names if "/ P_AC (kW)" in s and s.startswith("INV")])
inverter_ids = [c.replace(" / P_AC (kW)", "") for c in pac_cols]
print(f"  Inverters to model: {len(inverter_ids)}")
print()


# ══════════════════════════════════════════════════════════════════════════════
# STEP 5 – TRAIN & EVALUATE PER-INVERTER MODELS
# ══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("STEP 5 – Training LightGBM models (one per inverter)")
print("=" * 60)

TRAIN_YEAR = 2017       # full year as training baseline (healthy state)
VAL_YEAR   = 2018       # fully held-out year for validation (model never sees it)

models  = {}
val_metrics = {}
FORCE_RETRAIN = False   # set True to retrain even if saved models exist

feature_cols = [
    "Plant / Irradiation_average (W/m²)",
    "Plant / Altitude (°)",
    "Temperature Sensor / Module (°C)",
    "Temperature Sensor / Ambient (°C)",
    "U_DC",
]

for i, inv_id in enumerate(inverter_ids):
    pac_col = f"{inv_id} / P_AC (kW)"
    udc_col = f"{inv_id} / U_DC (V)"

    # Load just the 3 inverter-specific columns
    inv_data = pd.read_parquet(
        MONITORING, columns=[pac_col, udc_col]
    )
    inv_data.index = pd.to_datetime(inv_data.index, format="mixed")
    inv_data = inv_data.sort_index()
    # Drop duplicate timestamps if any (keeps first)
    inv_data = inv_data[~inv_data.index.duplicated(keep="first")]

    # Merge with shared features (use outer-safe concat instead of join)
    df = shared.copy()
    df[pac_col] = inv_data[pac_col]
    df["U_DC"]  = inv_data[udc_col]

    # Recompute mask entirely from df (avoids index alignment issues)
    irr_ok2 = df["Plant / Irradiation_average (W/m²)"] > IRR_THRESHOLD
    evu_ok2 = df["DRD11A / EVU (%)"].fillna(100) >= CURTAILMENT_THRESHOLD
    dv_ok2  = df["DRD11A / DV (%)"].fillna(100)  >= CURTAILMENT_THRESHOLD
    pac_ok  = df[pac_col].notna() & (df[pac_col] > 0)
    udc_ok  = df["U_DC"].notna()
    mask    = irr_ok2 & evu_ok2 & dv_ok2 & pac_ok & udc_ok

    df_clean = df[mask].copy()

    # Training set: full 2017 (all 12 months — model sees all seasons)
    train_mask = df_clean.index.year == TRAIN_YEAR
    # Validation set: full 2018 (completely held-out year, never seen during training)
    val_mask   = df_clean.index.year == VAL_YEAR

    X_train = df_clean.loc[train_mask, feature_cols]
    y_train = df_clean.loc[train_mask, pac_col]
    X_val   = df_clean.loc[val_mask, feature_cols]
    y_val   = df_clean.loc[val_mask, pac_col]

    if len(X_train) < 500:
        print(f"  [{i+1:2d}/65] {inv_id} – SKIP (only {len(X_train)} train rows)")
        continue

    model_path   = os.path.join(MODELS_DIR, f"{inv_id.replace(' ', '_').replace('.', '_')}.pkl")
    metrics_path = model_path.replace(".pkl", "_metrics.pkl")

    if os.path.exists(model_path) and not FORCE_RETRAIN:
        # Load cached model
        model = joblib.load(model_path)
        val_metrics[inv_id] = joblib.load(metrics_path)
        models[inv_id] = model
        if (i + 1) % 10 == 0 or i == 0:
            m = val_metrics[inv_id]
            print(f"  [{i+1:2d}/65] {inv_id}  [cached]  "
                  f"val_R²={m.get('r2', 0):.3f}  RMSE={m.get('rmse', 0):.2f} kW")
        continue

    model = LGBMRegressor(
        n_estimators=400,
        learning_rate=0.05,
        num_leaves=31,
        min_child_samples=20,
        n_jobs=-1,
        verbose=-1,
    )
    model.fit(X_train, y_train)
    models[inv_id] = model

    # Validation metrics
    m = {}
    if len(X_val) > 0:
        y_pred_val = model.predict(X_val)
        r2   = r2_score(y_val, y_pred_val)
        rmse = np.sqrt(mean_squared_error(y_val, y_pred_val))
        m = {"r2": r2, "rmse": rmse, "n_val": len(X_val)}
        val_metrics[inv_id] = m

    # Save model + metrics
    joblib.dump(model, model_path)
    joblib.dump(m, metrics_path)

    if (i + 1) % 10 == 0 or i == 0:
        print(f"  [{i+1:2d}/65] {inv_id}  train={len(X_train):>5}  "
              f"val_R²={m.get('r2', 0):.3f}  RMSE={m.get('rmse', 0):.2f} kW")

print(f"\n  Models trained: {len(models)}/65")

metrics_df = pd.DataFrame(val_metrics).T
print(f"\n  Validation R²  – mean={metrics_df['r2'].mean():.3f}  "
      f"min={metrics_df['r2'].min():.3f}  max={metrics_df['r2'].max():.3f}")
print(f"  Validation RMSE – mean={metrics_df['rmse'].mean():.2f} kW  "
      f"max={metrics_df['rmse'].max():.2f} kW")
print()


# ══════════════════════════════════════════════════════════════════════════════
# STEP 6 – PREDICT ON ALL YEARS, COMPUTE PERFORMANCE INDEX & LOSS
# ══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("STEP 6 – Computing yearly performance index & losses")
print("=" * 60)

# 2017 = training year (kept for sanity check: should be close to PI=1)
# 2018 = validation year (kept to show out-of-sample fit)
# 2019–2026 = degradation analysis window
ANALYSIS_YEARS = list(range(2017, 2027))

records = []   # one row per (inverter, year)

for inv_id in models:
    pac_col = f"{inv_id} / P_AC (kW)"
    udc_col = f"{inv_id} / U_DC (V)"

    inv_data = pd.read_parquet(MONITORING, columns=[pac_col, udc_col])
    inv_data.index = pd.to_datetime(inv_data.index, format="mixed")
    inv_data = inv_data.sort_index()
    inv_data = inv_data[~inv_data.index.duplicated(keep="first")]

    df = shared.copy()
    df[pac_col] = inv_data[pac_col]
    df["U_DC"]  = inv_data[udc_col]

    irr_ok2 = df["Plant / Irradiation_average (W/m²)"] > IRR_THRESHOLD
    evu_ok2 = df["DRD11A / EVU (%)"].fillna(100) >= CURTAILMENT_THRESHOLD
    dv_ok2  = df["DRD11A / DV (%)"].fillna(100)  >= CURTAILMENT_THRESHOLD
    pac_ok  = df[pac_col].notna() & (df[pac_col] >= 0)
    udc_ok  = df["U_DC"].notna()
    mask    = irr_ok2 & evu_ok2 & dv_ok2 & pac_ok & udc_ok
    df_clean = df[mask].copy()

    # Predict over all years (inc. 2017 for baseline check)
    X_all = df_clean[feature_cols]
    df_clean["P_predicted"] = models[inv_id].predict(X_all).clip(0)
    df_clean["P_actual"]    = df_clean[pac_col]
    df_clean["loss_kW"]     = (df_clean["P_predicted"] - df_clean["P_actual"]).clip(lower=0)

    for yr in ANALYSIS_YEARS:
        yr_data = df_clean[df_clean.index.year == yr]
        if len(yr_data) < 100:
            continue

        actual_kwh    = yr_data["P_actual"].sum()    * INTERVAL_H
        predicted_kwh = yr_data["P_predicted"].sum() * INTERVAL_H
        loss_kwh      = yr_data["loss_kW"].sum()     * INTERVAL_H
        pi            = actual_kwh / predicted_kwh if predicted_kwh > 0 else np.nan

        # Tariff lookup
        tariff_row = tariff_yearly[
            (tariff_yearly["inv_id"] == inv_id) & (tariff_yearly["year"] == yr)
        ]
        tariff = tariff_row["tariff_eurocent"].values[0] if len(tariff_row) > 0 else np.nan
        loss_eur = loss_kwh * tariff / 100 if not np.isnan(tariff) else np.nan

        records.append({
            "inv_id":        inv_id,
            "year":          yr,
            "actual_kWh":    actual_kwh,
            "predicted_kWh": predicted_kwh,
            "loss_kWh":      loss_kwh,
            "perf_index":    pi,
            "tariff_eurocent": tariff,
            "loss_eur":      loss_eur,
            "n_rows":        len(yr_data),
        })

results = pd.DataFrame(records)

# Add module type
results["module_type"] = results["inv_id"].map(inv_module)

# Save detailed results
results.to_csv(os.path.join(OUT_DIR, "yearly_performance.csv"), index=False)
print(f"  Saved: results/yearly_performance.csv  ({len(results)} rows)")
print()

# Quick summary
total_loss = results[results["year"] > 2017]["loss_eur"].sum()
print(f"  Total estimated loss 2018–2026: € {total_loss:,.0f}")
print()


# ══════════════════════════════════════════════════════════════════════════════
# STEP 7 – PLOTS
# ══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("STEP 7 – Generating plots")
print("=" * 60)

sns.set_theme(style="whitegrid", palette="tab10")
PLOT_YEARS = [y for y in ANALYSIS_YEARS if y >= 2019 and y <= 2025]  # exclude training(2017), validation(2018) & partial 2026

# ── Plot 1: Performance Index by module type, per year ──────────────────────
pi_by_type = (
    results[results["year"].isin(PLOT_YEARS)]
    .groupby(["module_type", "year"])["perf_index"]
    .mean()
    .reset_index()
)

fig, ax = plt.subplots(figsize=(13, 6))
module_types = sorted(pi_by_type["module_type"].dropna().unique())
palette = sns.color_palette("tab10", len(module_types))

for mt, color in zip(module_types, palette):
    d = pi_by_type[pi_by_type["module_type"] == mt].sort_values("year")
    ax.plot(d["year"], d["perf_index"], marker="o", label=mt, color=color, linewidth=1.8)

ax.axhline(1.0, color="black", linestyle="--", linewidth=0.8, label="Ideal (PI=1.0)")
ax.set_xlabel("Year", fontsize=12)
ax.set_ylabel("Performance Index  (actual / predicted)", fontsize=12)
ax.set_title("Inverter Performance Index by Module Type (2019–2025)\n"
             "PI < 1 = underperformance vs. 2017 healthy baseline", fontsize=13)
ax.legend(title="Module Type", bbox_to_anchor=(1.01, 1), loc="upper left")
ax.set_ylim(0.5, 1.1)
ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
fig.tight_layout()
fig.savefig(os.path.join(OUT_DIR, "plot1_performance_index_by_module.png"), dpi=150)
plt.close()
print("  Saved: results/plot1_performance_index_by_module.png")

# ── Plot 2: Cumulative financial loss per module type ───────────────────────
loss_by_type = (
    results[results["year"].isin(PLOT_YEARS)]
    .groupby(["module_type", "year"])["loss_eur"]
    .sum()
    .reset_index()
)
loss_by_type = loss_by_type.sort_values(["module_type", "year"])
loss_by_type["cum_loss_eur"] = loss_by_type.groupby("module_type")["loss_eur"].cumsum()

fig, ax = plt.subplots(figsize=(13, 6))
for mt, color in zip(module_types, palette):
    d = loss_by_type[loss_by_type["module_type"] == mt].sort_values("year")
    ax.plot(d["year"], d["cum_loss_eur"], marker="s", label=mt, color=color, linewidth=1.8)

ax.set_xlabel("Year", fontsize=12)
ax.set_ylabel("Cumulative Financial Loss  (€)", fontsize=12)
ax.set_title("Cumulative Estimated Financial Loss by Module Type (2019–2025)", fontsize=13)
ax.legend(title="Module Type", bbox_to_anchor=(1.01, 1), loc="upper left")
ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"€{x:,.0f}"))
ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
fig.tight_layout()
fig.savefig(os.path.join(OUT_DIR, "plot2_cumulative_loss_by_module.png"), dpi=150)
plt.close()
print("  Saved: results/plot2_cumulative_loss_by_module.png")

# ── Plot 3: Heatmap – Performance Index per inverter per year ───────────────
pi_pivot = results[results["year"].isin(PLOT_YEARS)].pivot(
    index="inv_id", columns="year", values="perf_index"
)
# Sort inverters by mean PI (worst at top)
pi_pivot = pi_pivot.loc[pi_pivot.mean(axis=1).sort_values().index]

fig, ax = plt.subplots(figsize=(14, 18))
sns.heatmap(
    pi_pivot, ax=ax,
    cmap="RdYlGn", vmin=0.6, vmax=1.0,
    linewidths=0.3, linecolor="white",
    annot=True, fmt=".2f", annot_kws={"size": 7},
    cbar_kws={"label": "Performance Index"},
)
ax.set_title("Per-Inverter Performance Index Heatmap (2019–2025)\nRed = underperforming", fontsize=13)
ax.set_xlabel("Year", fontsize=11)
ax.set_ylabel("Inverter", fontsize=11)
fig.tight_layout()
fig.savefig(os.path.join(OUT_DIR, "plot3_heatmap_inverter_year.png"), dpi=150)
plt.close()
print("  Saved: results/plot3_heatmap_inverter_year.png")

# ── Plot 4: Bar chart – Total loss per module type ───────────────────────────
total_loss_by_type = (
    results[results["year"].isin(PLOT_YEARS)]
    .groupby("module_type")["loss_eur"]
    .sum()
    .sort_values()
)

fig, ax = plt.subplots(figsize=(10, 5))
bars = ax.barh(
    total_loss_by_type.index,
    total_loss_by_type.values,
    color=[palette[module_types.index(mt)] for mt in total_loss_by_type.index],
)
ax.bar_label(bars, fmt=lambda x: f"€{x:,.0f}", padding=4, fontsize=9)
ax.set_xlabel("Total Estimated Loss 2018–2025  (€)", fontsize=11)
ax.set_title("Total Financial Loss by Module Type", fontsize=13)
ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"€{x:,.0f}"))
fig.tight_layout()
fig.savefig(os.path.join(OUT_DIR, "plot4_total_loss_by_module_type.png"), dpi=150)
plt.close()
print("  Saved: results/plot4_total_loss_by_module_type.png")

# ── Plot 5: Validation quality – R² per inverter ────────────────────────────
metrics_df_sorted = metrics_df.sort_values("r2")
fig, ax = plt.subplots(figsize=(14, 5))
ax.bar(range(len(metrics_df_sorted)), metrics_df_sorted["r2"], color="steelblue")
ax.axhline(0.95, color="red", linestyle="--", linewidth=1, label="R²=0.95 target")
ax.set_xticks(range(len(metrics_df_sorted)))
ax.set_xticklabels(
    [x.replace("INV 01.", "") for x in metrics_df_sorted.index],
    rotation=90, fontsize=7
)
ax.set_ylabel("Validation R²")
ax.set_title("Model Quality per Inverter (Validation Set: Full Year 2018)", fontsize=13)
ax.legend()
ax.set_ylim(0.8, 1.0)
fig.tight_layout()
fig.savefig(os.path.join(OUT_DIR, "plot5_model_r2_per_inverter.png"), dpi=150)
plt.close()
print("  Saved: results/plot5_model_r2_per_inverter.png")

# ── Summary table ────────────────────────────────────────────────────────────
summary = (
    results[results["year"].isin(PLOT_YEARS)]
    .groupby("module_type")
    .agg(
        n_inverters      =("inv_id",      "nunique"),
        avg_perf_index   =("perf_index",  "mean"),
        total_loss_kWh   =("loss_kWh",    "sum"),
        total_loss_eur   =("loss_eur",    "sum"),
    )
    .round({"avg_perf_index": 3, "total_loss_kWh": 0, "total_loss_eur": 0})
    .sort_values("avg_perf_index")
)
summary.to_csv(os.path.join(OUT_DIR, "summary_by_module_type.csv"))
print()
print("=" * 60)
print("SUMMARY BY MODULE TYPE (2018–2025)")
print("=" * 60)
print(summary.to_string())

print()

# ══════════════════════════════════════════════════════════════════════════════
# STEP 8 – FORECASTING: Degrade trends → project 2026-2030 losses
# ══════════════════════════════════════════════════════════════════════════════
print("=" * 60)
print("STEP 8 – Degradation trend extrapolation (2026–2030 forecast)")
print("=" * 60)

from sklearn.linear_model import LinearRegression

FORECAST_YEARS = list(range(2026, 2031))
TREND_YEARS    = list(range(2019, 2026))   # 7 years of actual data to fit trend

# Use average tariff per module type (from last observed year, 2025 or latest)
# as proxy for future tariff (conservative: no inflation)
last_tariff_year = max(yr for yr in ANALYSIS_YEARS if yr <= 2025)
avg_tariff_by_inv = (
    tariff_yearly[tariff_yearly["year"] == last_tariff_year]
    .set_index("inv_id")["tariff_eurocent"]
    .to_dict()
)

# For each inverter, fit a linear trend to its PI over TREND_YEARS
# then project to FORECAST_YEARS, compute projected annual energy and loss
forecast_records = []

for inv_id in models:
    inv_rows = results[
        (results["inv_id"] == inv_id) & (results["year"].isin(TREND_YEARS))
    ].sort_values("year").dropna(subset=["perf_index", "predicted_kWh"])

    if len(inv_rows) < 3:
        continue   # not enough history to fit a trend

    X_trend = inv_rows["year"].values.reshape(-1, 1)
    y_trend = inv_rows["perf_index"].values
    lr = LinearRegression().fit(X_trend, y_trend)
    slope = lr.coef_[0]

    # Average predicted (healthy) energy for this inverter
    avg_predicted_kwh = inv_rows["predicted_kwh"].mean() if "predicted_kwh" in inv_rows.columns \
        else inv_rows["predicted_kWh"].mean()

    # Get future tariff (use last year or default 11 cent)
    future_tariff = avg_tariff_by_inv.get(inv_id, 11.0)
    module_type   = inv_module.get(inv_id, np.nan)

    for yr in FORECAST_YEARS:
        proj_pi      = lr.predict([[yr]])[0]
        proj_pi      = max(proj_pi, 0.0)          # PI can't go negative
        proj_actual  = avg_predicted_kwh * proj_pi
        proj_loss_kwh = max(0, avg_predicted_kwh - proj_actual)
        proj_loss_eur = proj_loss_kwh * future_tariff / 100

        forecast_records.append({
            "inv_id":        inv_id,
            "module_type":   module_type,
            "year":          yr,
            "proj_pi":       proj_pi,
            "pi_slope":      slope,            # annual degradation rate
            "proj_loss_kWh": proj_loss_kwh,
            "proj_loss_eur": proj_loss_eur,
            "avg_healthy_kWh": avg_predicted_kwh,
        })

forecast_df = pd.DataFrame(forecast_records)
forecast_df.to_csv(os.path.join(OUT_DIR, "forecast_2026_2030.csv"), index=False)
print(f"  Saved: results/forecast_2026_2030.csv  ({len(forecast_df)} rows)")

total_forecast_loss = forecast_df["proj_loss_eur"].sum()
print(f"  Projected total loss 2026–2030: € {total_forecast_loss:,.0f}")

# Annual summary
annual_fc = (
    forecast_df.groupby("year")["proj_loss_eur"]
    .sum()
    .reset_index()
    .rename(columns={"proj_loss_eur": "proj_loss_eur_total"})
)
print("\n  Projected annual plant losses:")
for _, row in annual_fc.iterrows():
    print(f"    {int(row['year'])}: € {row['proj_loss_eur_total']:>10,.0f}")

# ── Plot 6: Forecast – projected annual loss 2019-2030 ──────────────────────
# Combine historical (actual) with forecast
hist_annual = (
    results[results["year"].isin(TREND_YEARS)]
    .groupby("year")["loss_eur"]
    .sum()
    .reset_index()
)
fc_annual = (
    forecast_df.groupby("year")["proj_loss_eur"]
    .sum()
    .reset_index()
    .rename(columns={"proj_loss_eur": "loss_eur"})
)

fig, ax = plt.subplots(figsize=(13, 6))
ax.bar(hist_annual["year"],  hist_annual["loss_eur"],
       color="steelblue", alpha=0.85, label="Historical loss (actual)")
ax.bar(fc_annual["year"],    fc_annual["loss_eur"],
       color="tomato",    alpha=0.75, label="Projected loss (forecast)", hatch="//")
ax.axvline(2025.5, color="grey", linestyle="--", linewidth=1.2, label="Forecast boundary")
ax.set_xlabel("Year", fontsize=12)
ax.set_ylabel("Estimated Annual Loss (€)", fontsize=12)
ax.set_title("Solar Plant Financial Loss: Historical vs. Projected (2026–2030)\n"
             "Forecast based on per-inverter PI degradation trend", fontsize=13)
ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"€{x:,.0f}"))
ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
ax.legend(fontsize=10)
fig.tight_layout()
fig.savefig(os.path.join(OUT_DIR, "plot6_forecast_annual_loss.png"), dpi=150)
plt.close()
print("\n  Saved: results/plot6_forecast_annual_loss.png")

# ── Plot 7: Projected PI by module type (2019-2030) ─────────────────────────
# Historical avg PI per module type
hist_pi = (
    results[results["year"].isin(TREND_YEARS)]
    .groupby(["module_type", "year"])["perf_index"]
    .mean()
    .reset_index()
    .rename(columns={"perf_index": "pi"})
)
# Forecast avg PI per module type
fc_pi = (
    forecast_df.groupby(["module_type", "year"])["proj_pi"]
    .mean()
    .reset_index()
    .rename(columns={"proj_pi": "pi"})
)

fig, ax = plt.subplots(figsize=(13, 6))
module_types_fc = sorted(
    set(hist_pi["module_type"].dropna()) | set(fc_pi["module_type"].dropna())
)
palette_fc = sns.color_palette("tab10", len(module_types_fc))

for mt, color in zip(module_types_fc, palette_fc):
    h = hist_pi[hist_pi["module_type"] == mt].sort_values("year")
    f = fc_pi[fc_pi["module_type"] == mt].sort_values("year")
    # Join historical last point to forecast first point for continuous line
    if len(h) > 0 and len(f) > 0:
        bridge_year = h["year"].iloc[-1]
        bridge_pi   = h["pi"].iloc[-1]
        f_ext = pd.concat([
            pd.DataFrame({"year": [bridge_year], "pi": [bridge_pi]}),
            f
        ])
        ax.plot(h["year"], h["pi"],   color=color, linewidth=2.0, marker="o",
                label=f"MT {mt}")
        ax.plot(f_ext["year"], f_ext["pi"], color=color, linewidth=1.5,
                linestyle="--", marker="x", alpha=0.8)
    elif len(h) > 0:
        ax.plot(h["year"], h["pi"],   color=color, linewidth=2.0, marker="o",
                label=f"MT {mt}")

ax.axvline(2025.5, color="grey", linestyle="--", linewidth=1.2, label="Forecast boundary")
ax.axhline(1.0, color="black", linestyle=":", linewidth=0.8, alpha=0.5)
ax.set_xlabel("Year", fontsize=12)
ax.set_ylabel("Performance Index (actual or projected)", fontsize=12)
ax.set_title("Degradation Trend & Forecast: Performance Index by Module Type (2019–2030)\n"
             "Solid = historical, dashed = projected", fontsize=13)
ax.legend(title="Module Type", bbox_to_anchor=(1.01, 1), loc="upper left", fontsize=9)
ax.set_ylim(0.4, 1.15)
ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
fig.tight_layout()
fig.savefig(os.path.join(OUT_DIR, "plot7_pi_trend_forecast_by_module.png"), dpi=150)
plt.close()
print("  Saved: results/plot7_pi_trend_forecast_by_module.png")

# ── Summary: degradation rate per module type ───────────────────────────────
deg_summary = (
    forecast_df.groupby("module_type")
    .agg(
        n_inverters     =("inv_id",         "nunique"),
        avg_pi_slope    =("pi_slope",        "mean"),    # %/year degradation
        proj_loss_5yr   =("proj_loss_eur",   "sum"),
    )
    .round({"avg_pi_slope": 4, "proj_loss_5yr": 0})
    .sort_values("avg_pi_slope")
)
deg_summary.to_csv(os.path.join(OUT_DIR, "summary_degradation_forecast.csv"))
print()
print("=" * 60)
print("DEGRADATION FORECAST SUMMARY (2026–2030)")
print("=" * 60)
print(deg_summary.to_string())

print()
print("=" * 60)
print(f"Done. All outputs in: {OUT_DIR}")
print("=" * 60)
