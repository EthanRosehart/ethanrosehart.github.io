#!/usr/bin/env python3
# =============================================================================
# build-forecast.py  —  Glidepath short-term tactical model (Meta Prophet)
#
# Runs server-side in .github/workflows/refresh-data.yml (never in the browser).
# Reads the real monthly series committed by the Node fetchers
# (data/activity.json) and fits a Meta Prophet model per airport per metric,
# with country public holidays as regressors. Writes data/forecast.json, which
# the browser renders directly — no forecasting happens client-side.
#
# Holidays come from the open-source `holidays` package (vacanza, MIT, 250
# country codes) — the same source Prophet's add_country_holidays uses. Because
# the series is monthly, each holiday date is snapped to the first of its month
# so Prophet can attribute an effect to that month. This is where movable
# feasts (Easter, etc.) earn their keep: they drift between months across years
# in a way plain yearly seasonality can't capture.
#
# Run locally:  python3 scripts/build-forecast.py
# =============================================================================
import json
import os
import sys
import warnings
from datetime import datetime, timezone

import pandas as pd

warnings.simplefilter("ignore")
# Prophet is chatty on stdout/stderr during fit; quiet it down for CI logs.
import logging
logging.getLogger("prophet").setLevel(logging.ERROR)
logging.getLogger("cmdstanpy").setLevel(logging.ERROR)

try:
    from prophet import Prophet
    import holidays as holidays_pkg
except Exception as e:  # pragma: no cover
    print(f"build-forecast: missing dependency ({e}). pip install prophet holidays", file=sys.stderr)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))
ACTIVITY = os.path.join(DATA, "activity.json")
OUT = os.path.join(DATA, "forecast.json")

HORIZON = 24            # months forecast (UI offers 12 / 24)
INTERVAL = 0.80         # prediction interval width -> P10..P90 band
MIN_MONTHS = 36         # need a few seasons before Prophet is meaningful

HOLIDAY_PRIOR = 5.0     # regularisation for public holidays (multiplicative)
# COVID is modelled as an explicit event, not deleted: one dummy per month over
# the acute window so Prophet attributes the collapse/recovery to the event
# instead of distorting yearly seasonality or inflating the trend-uncertainty
# fan. The dummies never recur, so the effect is zero across the forecast. All
# real observations stay in the fit (and on the actuals chart).
COVID_START = "2020-03"
COVID_END = "2021-12"
COVID_PRIOR = 15.0      # let the dip months take large coefficients

# The ISO 3166-1 alpha-2 country (for the holidays package / Prophet) now rides
# on each airport in activity.json ("country"); this map is only a fallback for
# any legacy entry that predates that field.
COUNTRY = {
    "YYZ": "CA", "YOW": "CA", "YHZ": "CA", "YVR": "CA", "YUL": "CA",
    "YYC": "CA", "YEG": "CA", "YWG": "CA",
    "BUR": "US", "PVU": "US", "PSP": "US", "BZN": "US",
}

# Metrics we may find in the data. Seats is intentionally absent — there is no
# free per-airport monthly source, so it is not forecast.
METRICS = ["pax", "atm", "cargo"]


def monthly_holidays(iso2, years):
    """Public holidays for a country, each snapped to the first of its month.
    Returns a Prophet-style frame (holiday, ds) plus the set of names used."""
    # every country we cover supports the 'en_US' translation; fall back to the
    # native default if a future country code doesn't.
    try:
        hs = holidays_pkg.country_holidays(iso2, years=list(years), language="en_US")
    except Exception:
        try:
            hs = holidays_pkg.country_holidays(iso2, years=list(years))
        except Exception:
            return pd.DataFrame(columns=["holiday", "ds"]), []
    rows = {}
    for d, name in hs.items():
        ds = pd.Timestamp(d.year, d.month, 1)
        rows[(name, ds)] = True            # dedupe (name, month)
    if not rows:
        return pd.DataFrame(columns=["holiday", "ds"]), []
    df = pd.DataFrame([{"holiday": n, "ds": ds, "prior_scale": HOLIDAY_PRIOR} for (n, ds) in rows.keys()])
    return df, sorted(df["holiday"].unique().tolist())


def covid_events(df):
    """One dummy event per month in the COVID window that the series covers.
    Returned in Prophet holidays format; absorbs the 2020-21 anomaly without
    dropping any observation. Empty for airports whose history starts after."""
    lo, hi = df["ds"].min(), df["ds"].max()
    start = pd.Timestamp(int(COVID_START[:4]), int(COVID_START[5:7]), 1)
    end = pd.Timestamp(int(COVID_END[:4]), int(COVID_END[5:7]), 1)
    months = pd.date_range(max(start, lo), min(end, hi), freq="MS")
    if len(months) == 0:
        return pd.DataFrame(columns=["holiday", "ds", "prior_scale"])
    return pd.DataFrame([
        {"holiday": f"covid_{ds.year}_{ds.month:02d}", "ds": ds, "prior_scale": COVID_PRIOR}
        for ds in months
    ])


def series_frame(monthly):
    """{'YYYY-MM': value} -> DataFrame(ds=month-start, y=value), sorted."""
    items = sorted((k, v) for k, v in monthly.items() if v is not None)
    if not items:
        return None
    df = pd.DataFrame(
        {"ds": [pd.Timestamp(int(k[:4]), int(k[5:7]), 1) for k, _ in items],
         "y": [float(v) for _, v in items]}
    )
    return df


def fit_predict(df, hol_df, horizon):
    """Fit Prophet (multiplicative yearly + holidays) and forecast `horizon`."""
    m = Prophet(
        growth="linear",
        yearly_seasonality=6,
        weekly_seasonality=False,
        daily_seasonality=False,
        seasonality_mode="multiplicative",
        holidays=hol_df if len(hol_df) else None,
        holidays_prior_scale=5.0,
        changepoint_prior_scale=0.05,
        interval_width=INTERVAL,
    )
    m.fit(df)
    future = m.make_future_dataframe(periods=horizon, freq="MS")
    fc = m.predict(future)
    return m, fc


def backtest_mape(df, hol_df, holdout=12):
    """Honest holdout: fit on all-but-last-`holdout`, score those months."""
    if len(df) <= holdout + 24:
        return None
    train, test = df.iloc[:-holdout], df.iloc[-holdout:]
    try:
        _, fc = fit_predict(train, hol_df, holdout)
    except Exception:
        return None
    pred = fc.set_index("ds").loc[test["ds"], "yhat"].values
    actual = test["y"].values
    mask = actual != 0
    if not mask.any():
        return None
    mape = (abs(pred[mask] - actual[mask]) / actual[mask]).mean() * 100
    return round(float(mape), 1)


def seasonal12(df):
    """Empirical multiplicative monthly index (last 3 clean years), 12 values."""
    recent = df[df["ds"] >= (df["ds"].max() - pd.DateOffset(years=3))]
    if len(recent) < 12:
        recent = df
    mean = recent["y"].mean() or 1.0
    idx = [1.0] * 12
    g = recent.groupby(recent["ds"].dt.month)["y"].mean()
    for month, val in g.items():
        idx[month - 1] = round(float(val / mean), 4)
    return idx


def top_holidays(m, fc, names, k=5):
    """Rank holidays by mean absolute contribution over the horizon."""
    cols = [c for c in names if c in fc.columns]
    if not cols:
        return []
    tail = fc.tail(HORIZON)
    scored = [(c, float(tail[c].abs().mean())) for c in cols]
    scored = [s for s in scored if s[1] > 0]
    scored.sort(key=lambda s: s[1], reverse=True)
    return [c for c, _ in scored[:k]]


def forecast_metric(iata, iso2, monthly, horizon):
    df = series_frame(monthly)
    if df is None or len(df) < MIN_MONTHS:
        return None
    start_year = int(df["ds"].min().year)
    end_year = int(df["ds"].max().year) + (horizon // 12) + 2
    hol_df, names = monthly_holidays(iso2, range(start_year, end_year + 1))

    # add COVID dummies to the fit, but keep `names` (public holidays only) so
    # the UI's holiday metrics aren't polluted by the COVID events.
    cov_df = covid_events(df)
    frames = [f for f in (hol_df, cov_df) if len(f)]
    fit_holidays = pd.concat(frames, ignore_index=True) if frames else hol_df

    m, fc = fit_predict(df, fit_holidays, horizon)
    mape = backtest_mape(df, fit_holidays)

    fut = fc.tail(horizon)
    out = []
    for _, r in fut.iterrows():
        ds = r["ds"]
        out.append({
            "date": f"{ds.year}-{ds.month:02d}",
            "y": int(ds.year),
            "m": int(ds.month) - 1,
            "v": max(0, round(float(r["yhat"]))),
            "lo": max(0, round(float(r["yhat_lower"]))),
            "hi": max(0, round(float(r["yhat_upper"]))),
        })
    return {
        "mape": mape,
        "months_history": int(len(df)),
        "latest": f"{df['ds'].max().year}-{df['ds'].max().month:02d}",
        "seasonal12": seasonal12(df),
        "holidays": top_holidays(m, fc, names),
        "holidays_total": len(names),
        "forecast": out,
    }


def main():
    with open(ACTIVITY, "r", encoding="utf-8") as f:
        activity = json.load(f)
    airports_in = activity.get("airports", {})

    airports_out = {}
    n_series = 0
    for iata, a in airports_in.items():
        iso2 = a.get("country") or COUNTRY.get(iata)
        if not iso2 or not a.get("observed"):
            continue
        metrics = {}
        for metric in METRICS:
            # activity.json may store one series under "monthly" (legacy = pax)
            # or a per-metric "series": { pax:{...}, atm:{...}, cargo:{...} }.
            monthly = None
            if isinstance(a.get("series"), dict) and metric in a["series"]:
                monthly = a["series"][metric]
            elif metric == "pax" and isinstance(a.get("monthly"), dict):
                monthly = a["monthly"]
            if not monthly:
                continue
            try:
                res = forecast_metric(iata, iso2, monthly, HORIZON)
            except Exception as e:
                print(f"  {iata}/{metric}: FAILED ({e})", file=sys.stderr)
                res = None
            if res:
                metrics[metric] = res
                n_series += 1
                print(f"  {iata}/{metric}: {res['months_history']}mo  MAPE "
                      f"{res['mape']}%  holidays[{res['holidays_total']}] "
                      f"top={res['holidays'][:3]}")
        if metrics:
            airports_out[iata] = {"country": iso2, "metrics": metrics}

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "model": "Meta Prophet (additive trend + multiplicative yearly + country holidays)",
        "library": f"prophet {__import__('prophet').__version__}, holidays {holidays_pkg.__version__}",
        "interval": INTERVAL,
        "horizon": HORIZON,
        "note": ("Short-term forecasts. Fit nightly by "
                 ".github/workflows/refresh-data.yml on the real observed series; "
                 "the browser renders these directly."),
        "airports": airports_out,
    }
    os.makedirs(DATA, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"Wrote {OUT} — {len(airports_out)} airports, {n_series} series.")


if __name__ == "__main__":
    main()
