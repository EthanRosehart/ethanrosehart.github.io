#!/usr/bin/env python3
# =============================================================================
# build-forecast.py  —  Glidepath short-term tactical model (Meta Prophet)
#
# Runs server-side in .github/workflows/refresh-data.yml (never in the browser).
# Reads the real monthly series committed by the Node fetchers — the airport
# catalogue in data/activity-index.json plus each airport's own
# data/series/<IATA>.json — and fits a Meta Prophet model per airport per
# metric, with country public holidays as regressors. Writes one
# data/forecasts/<IATA>.json per airport (fetched by the browser only once
# that gateway is selected) plus a small shared data/forecast-meta.json
# (generatedAt/model/library/interval/horizon). No forecasting happens
# client-side — the browser renders these directly.
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
ACTIVITY = os.path.join(DATA, "activity-index.json")
SERIES_DIR = os.path.join(DATA, "series")
FORECASTS_DIR = os.path.join(DATA, "forecasts")
META_OUT = os.path.join(DATA, "forecast-meta.json")
MACRO = os.path.join(DATA, "macro.json")
IMF_WEO = os.path.join(DATA, "imf-weo.json")

HORIZON = 24            # months forecast (UI offers 12 / 24)
INTERVAL = 0.80         # prediction interval width -> P10..P90 band
MIN_MONTHS = 36         # need a few seasons before Prophet is meaningful
BACKTEST_FOLDS = 3      # rolling-origin evaluation: up to N folds...
BACKTEST_H = 12         # ...each holding out the next 12 months

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


def gdp_monthly_series(annual_levels, trailing_growth_pct, month_starts, future_annual_rates=None):
    """Real annual GDP/capita levels -> a monthly value for each of
    `month_starts` (a Prophet extra_regressor needs one for every ds, both
    historical and forecast). Real annual levels are each anchored at that
    year's midpoint and linearly interpolated between anchors. Beyond the
    last observed year, `future_annual_rates` (e.g. real IMF WEO growth
    forecasts, {year:int -> pct:float}) is used one real year at a time
    where available; any year it doesn't cover — including every year when
    it's omitted entirely — falls back to compounding `trailing_growth_pct`
    (the same trailing 5-yr mean used as the long-term model's GDP lever
    default). World Bank alone publishes no GDP forecast product, so
    without `future_annual_rates` this is honest about what it is: a
    disclosed extrapolation of real data, not a third-party forecast.

    `annual_levels`: {year:int -> level:float}. Returns None if empty.
    """
    if not annual_levels or not month_starts:
        return None
    future_annual_rates = future_annual_rates or {}
    anchors = sorted((int(y), float(v)) for y, v in annual_levels.items())
    monthly_rate = (1 + (trailing_growth_pct or 0) / 100.0) ** (1 / 12) - 1

    # extend the anchor list forward one real year at a time, past the last
    # observed level, far enough to cover every month requested — using a
    # real per-year rate where available and the trailing rate otherwise.
    last_year, last_val = anchors[-1]
    needed_year = max(d.year for d in month_starts)
    y, v = last_year, last_val
    while y < needed_year:
        y += 1
        pct = future_annual_rates.get(y)
        v = v * (1 + pct / 100.0) if pct is not None else v * (1 + monthly_rate) ** 12
        anchors.append((y, v))

    anchor_ts = [(pd.Timestamp(yr, 7, 1), val) for yr, val in anchors]
    first_ts, first_val = anchor_ts[0]
    last_ts, last_val = anchor_ts[-1]

    def months_between(a, b):
        return (b.year - a.year) * 12 + (b.month - a.month)

    out = []
    for d in month_starts:
        if d <= first_ts:
            out.append(first_val * (1 + monthly_rate) ** months_between(first_ts, d))
        elif d >= last_ts:
            out.append(last_val * (1 + monthly_rate) ** months_between(last_ts, d))
        else:
            ta, va = first_ts, first_val
            for tb, vb in anchor_ts[1:]:
                if d <= tb:
                    frac = months_between(ta, d) / months_between(ta, tb)
                    out.append(va + (vb - va) * frac)
                    break
                ta, va = tb, vb
    return out


def fit_predict(df, hol_df, horizon, gdp_levels=None, gdp_growth=None, gdp_future_rates=None):
    """Fit Prophet (multiplicative yearly + holidays) and forecast `horizon`.
    When `gdp_levels` (real WB annual GDP/capita) is available for this
    airport's country, GDP/capita rides along as an extra_regressor —
    Prophet needs a value for every ds, historical and future, which is
    exactly what gdp_monthly_series() builds. `gdp_future_rates` (real IMF
    WEO per-year growth forecasts, when available) drives the years it
    covers instead of the flat trailing-rate extrapolation."""
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
    use_gdp = bool(gdp_levels)
    if use_gdp:
        m.add_regressor("gdp_percap", standardize=True)
        df = df.copy()
        df["gdp_percap"] = gdp_monthly_series(gdp_levels, gdp_growth, list(df["ds"]), gdp_future_rates)
    m.fit(df)
    future = m.make_future_dataframe(periods=horizon, freq="MS")
    if use_gdp:
        future["gdp_percap"] = gdp_monthly_series(gdp_levels, gdp_growth, list(future["ds"]), gdp_future_rates)
    fc = m.predict(future)
    return m, fc


def mape_of(preds, actuals):
    """Mean absolute percentage error over pairs with a non-zero actual;
    None when nothing is scoreable."""
    pairs = [(float(p), float(a)) for p, a in zip(preds, actuals) if a]
    if not pairs:
        return None
    return sum(abs(p - a) / a for p, a in pairs) / len(pairs) * 100


def seasonal_naive_preds(train, test):
    """The benchmark every model must beat: month t forecast by the observed
    value 12 months earlier. Returns (preds, actuals) over the test months
    where the year-ago month exists in train."""
    by_ds = {ds: float(y) for ds, y in zip(train["ds"], train["y"])}
    preds, actuals = [], []
    for ds, y in zip(test["ds"], test["y"]):
        prev = ds - pd.DateOffset(years=1)
        if prev in by_ds:
            preds.append(by_ds[prev])
            actuals.append(float(y))
    return preds, actuals


def rolling_backtest(df, hol_df, folds=BACKTEST_FOLDS, holdout=BACKTEST_H,
                     gdp_levels=None, gdp_growth=None, gdp_future_rates=None):
    """Rolling-origin evaluation: up to `folds` refits, each trained on the
    series truncated a further `holdout` months back and scored on the next
    `holdout` months it never saw. Reports:
      mape        mean across folds (the headline the UI shows)
      mape_folds  per-fold values, so a lucky single holdout can't hide
      naive_mape  seasonal-naïve benchmark over the same held-out months
      skill       1 - mape/naive_mape (positive = beats the benchmark)
      coverage    % of held-out months inside the claimed 80% interval
      backtest    the most recent fold's month-by-month predicted-vs-actual,
                  shipped so the UI can show what the model got wrong
    None when even one fold can't be formed (needs 24 training months)."""
    fold_mapes, naive_p, naive_a = [], [], []
    hits = n_int = 0
    detail = None
    for i in range(1, folds + 1):
        cut = len(df) - holdout * i
        if cut < 24:
            break
        train, test = df.iloc[:cut], df.iloc[cut:cut + holdout]
        try:
            _, fc = fit_predict(train, hol_df, holdout, gdp_levels, gdp_growth, gdp_future_rates)
        except Exception:
            continue
        fx = fc.set_index("ds").loc[test["ds"]]
        m = mape_of(fx["yhat"], test["y"])
        if m is None:
            continue
        fold_mapes.append(m)
        for lo, hi, a in zip(fx["yhat_lower"], fx["yhat_upper"], test["y"]):
            n_int += 1
            if lo <= a <= hi:
                hits += 1
        p, a = seasonal_naive_preds(train, test)
        naive_p += p
        naive_a += a
        if i == 1:
            detail = [
                {"date": f"{ds.year}-{ds.month:02d}",
                 "v": max(0, round(float(v))), "lo": max(0, round(float(lo))),
                 "hi": max(0, round(float(hi))), "actual": round(float(act))}
                for ds, v, lo, hi, act in zip(test["ds"], fx["yhat"], fx["yhat_lower"], fx["yhat_upper"], test["y"])
            ]
    if not fold_mapes:
        return None
    naive = mape_of(naive_p, naive_a)
    mape = round(sum(fold_mapes) / len(fold_mapes), 1)
    return {
        "mape": mape,
        "mape_folds": [round(m, 1) for m in fold_mapes],
        "naive_mape": round(naive, 1) if naive is not None else None,
        "skill": round(1 - mape / naive, 2) if naive else None,
        "coverage": round(hits / n_int * 100) if n_int else None,
        "backtest": detail or [],
    }


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


def forecast_metric(iata, iso2, monthly, horizon, gdp_levels=None, gdp_growth=None, gdp_future_rates=None):
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

    m, fc = fit_predict(df, fit_holidays, horizon, gdp_levels=gdp_levels, gdp_growth=gdp_growth, gdp_future_rates=gdp_future_rates)
    bt = rolling_backtest(df, fit_holidays, gdp_levels=gdp_levels, gdp_growth=gdp_growth, gdp_future_rates=gdp_future_rates)

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
        "mape": bt["mape"] if bt else None,
        "mape_folds": bt["mape_folds"] if bt else [],
        "naive_mape": bt["naive_mape"] if bt else None,
        "skill": bt["skill"] if bt else None,
        "coverage": bt["coverage"] if bt else None,
        "backtest": bt["backtest"] if bt else [],
        "months_history": int(len(df)),
        "latest": f"{df['ds'].max().year}-{df['ds'].max().month:02d}",
        "seasonal12": seasonal12(df),
        "holidays": top_holidays(m, fc, names),
        "holidays_total": len(names),
        "gdpRegressor": bool(gdp_levels),
        "gdpForecast": bool(gdp_future_rates),
        "forecast": out,
    }


def load_airport_series(iata):
    """{ series: {...}, paxSeg?: {...} } from data/series/<IATA>.json, or None."""
    path = os.path.join(SERIES_DIR, f"{iata}.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    series = doc.get("series")
    return series if isinstance(series, dict) else None


def load_imf_future_rates():
    """cc (ISO3) -> {year:int -> pct:float}, from data/imf-weo.json (real
    IMF WEO forward growth forecasts — see scripts/fetch-imf.mjs). Missing
    or unreadable file just means every country falls back to the trailing-
    rate extrapolation in gdp_monthly_series(); never a hard failure."""
    try:
        with open(IMF_WEO, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for cc, c in (doc.get("countries") or {}).items():
        years = c.get("years") or []
        if years:
            out[cc] = {int(r["year"]): float(r["pct"]) for r in years if r.get("year") is not None}
    return out


def load_gdp_by_country():
    """cc (ISO3) -> (annual GDP/capita levels {year:int -> value}, trailing
    growth rate %, real future per-year rates {year:int -> pct:float} or
    None), from data/macro.json (World Bank actuals — the same file the
    browser's long-term model reads) plus data/imf-weo.json (real IMF WEO
    forecast, when available). Missing/unreadable files, or a country with
    no gdpcapSeries, just means that country's forecasts skip the
    regressor (see forecast_metric); never a hard failure."""
    try:
        with open(MACRO, "r", encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    imf_rates = load_imf_future_rates()
    out = {}
    for cc, c in (doc.get("countries") or {}).items():
        series = c.get("gdpcapSeries")
        if series:
            out[cc] = ({int(y): float(v) for y, v in series.items()}, c.get("gdpcap"), imf_rates.get(cc))
    return out


def prune_stale(dir_path, keep_iatas):
    """Delete any <IATA>.json in dir_path not in keep_iatas."""
    if not os.path.isdir(dir_path):
        return
    keep = set(keep_iatas)
    for fname in os.listdir(dir_path):
        if fname.endswith(".json") and fname[:-5] not in keep:
            try:
                os.remove(os.path.join(dir_path, fname))
            except OSError:
                pass


def main():
    with open(ACTIVITY, "r", encoding="utf-8") as f:
        activity = json.load(f)
    airports_in = activity.get("airports", {})
    # local-dev subset: GLIDEPATH_ONLY="AMS,YYZ" fits just those airports
    # (and skips pruning, so the other committed forecasts survive the run)
    only = {s.strip().upper() for s in os.environ.get("GLIDEPATH_ONLY", "").split(",") if s.strip()}
    gdp_by_country = load_gdp_by_country()
    n_with_forecast = sum(1 for _, _, r in gdp_by_country.values() if r)
    print(f"GDP/capita regressor available for {len(gdp_by_country)} countries "
          f"({n_with_forecast} with a real IMF WEO forecast, rest trailing-rate extrapolation).")

    os.makedirs(FORECASTS_DIR, exist_ok=True)

    airports_written = []
    n_series = 0
    for iata, a in airports_in.items():
        if only and iata not in only:
            continue
        iso2 = a.get("country") or COUNTRY.get(iata)
        if not iso2 or not a.get("observed"):
            continue
        series = load_airport_series(iata)
        if not series:
            print(f"  {iata}: no data/series/{iata}.json — skipped", file=sys.stderr)
            continue
        gdp_levels, gdp_growth, gdp_future_rates = gdp_by_country.get(a.get("cc"), (None, None, None))
        metrics = {}
        for metric in METRICS:
            monthly = series.get(metric)
            if not monthly:
                continue
            try:
                res = forecast_metric(iata, iso2, monthly, HORIZON, gdp_levels, gdp_growth, gdp_future_rates)
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
            with open(os.path.join(FORECASTS_DIR, f"{iata}.json"), "w", encoding="utf-8") as f:
                json.dump(metrics, f, separators=(",", ":"))
                f.write("\n")
            airports_written.append(iata)

    if not only:
        prune_stale(FORECASTS_DIR, airports_written)

    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "model": "Meta Prophet (additive trend + multiplicative yearly + country holidays + COVID 2020-21 events + GDP/capita regressor where available)",
        "library": f"prophet {__import__('prophet').__version__}, holidays {holidays_pkg.__version__}",
        "interval": INTERVAL,
        "horizon": HORIZON,
        "backtest": f"rolling-origin, up to {BACKTEST_FOLDS} folds x {BACKTEST_H}mo holdouts, scored against a seasonal-naive benchmark; 80% interval coverage measured on the same held-out months",
        "note": ("Short-term forecasts. Fit nightly by .github/workflows/refresh-data.yml "
                 "on the real observed series. Per-airport output lives in "
                 "data/forecasts/<IATA>.json, fetched by the browser once that gateway "
                 "is selected; this file only carries the shared model metadata."),
    }
    with open(META_OUT, "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"))
        f.write("\n")
    print(f"Wrote {FORECASTS_DIR}/ — {len(airports_written)} airports, {n_series} series. Wrote {META_OUT}.")


if __name__ == "__main__":
    main()
