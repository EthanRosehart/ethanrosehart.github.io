#!/usr/bin/env python3
# =============================================================================
# build-forecast.py  —  Glidepath short-term tactical model (auto-selected)
#
# Runs server-side in .github/workflows/refresh-data.yml (never in the browser).
# Reads the real monthly series committed by the Node fetchers — the airport
# catalogue in data/activity-index.json plus each airport's own
# data/series/<IATA>.json — and fits THREE candidate models per airport per
# metric, scores them on identical rolling-origin folds, and publishes the
# winner along with every candidate's forecast so the browser can switch
# between them. Writes one data/forecasts/<IATA>.json per airport (fetched by
# the browser only once that gateway is selected) plus a small shared
# data/forecast-meta.json (generatedAt/model/library/interval/horizon).
#
# WHY THREE CANDIDATES. Prophet is a good default and a bad universal: fit
# across the whole catalogue it loses to a seasonal naive on most series, and
# on short or structurally-broken histories (an airport that lost its traffic,
# a cargo feed running at single-digit tonnes) it confidently extrapolates the
# break. Publishing whichever model actually won its own backtest is strictly
# more honest than publishing Prophet and reporting that it lost. The
# candidates are deliberately ordered simplest-first:
#
#   snaive   every month repeats the most recent observed value for that
#            calendar month. The benchmark, promoted to a competitor.
#   ets      Holt-Winters, damped additive trend + multiplicative monthly
#            seasonality. Damping is the point: where Prophet compounds a
#            structural break, phi < 1 flattens it out.
#   prophet  trend + annual Fourier seasonality (order 2 — tuned, see
#            fit_predict) + country holidays + COVID events + a GDP/capita
#            regressor where one exists.
#
# WHY MASE, NOT MAPE. MAPE divides by the actual, so it explodes toward
# infinity as a series approaches zero — ISL scored 22,949% not because the
# model is that bad but because Ataturk closed to commercial traffic and
# monthly movements fell from 33,486 to a few hundred. MASE divides by the
# in-sample seasonal-naive MAE instead: finite at zero, comparable across
# airports, and MASE < 1 literally reads "beat a seasonal naive". Model
# selection runs on MASE (falling back to unscaled MAE only on a series with no
# year-over-year variation to scale by — see choose_model). MAPE is still
# published because it is what planners recognise, but it never decides.
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
# Prediction interval width. A 50% band says "half the months land in here" —
# deliberately NARROW. A wider band is not a safer one: the raw uncalibrated
# bands covered a median 97% of held-out months, which is the weather forecast
# that says "between -40 and +50" and is never wrong and never useful. A tight
# band that misses often but stays close is the more decision-useful object, and
# the measured coverage published next to it is what keeps it honest.
INTERVAL = 0.50
Z_INTERVAL = 0.6745     # two-sided normal quantile for INTERVAL — the two must
                        # move together (only the closed-form ets/snaive bands
                        # need it; Prophet samples its own posterior)
MIN_MONTHS = 36         # need a few seasons before Prophet is meaningful
BACKTEST_FOLDS = 3      # rolling-origin evaluation: up to N folds...
BACKTEST_H = 12         # ...each holding out the next 12 months

# Candidate models, ORDERED SIMPLEST-FIRST — the order is load-bearing, see
# choose_model(): the seasonal naive is the incumbent every fitted model has to
# unseat, not a footnote it gets compared against.
CANDIDATES = ("snaive", "ets", "prophet")
# Relative margin a more complex candidate must beat the incumbent by to take
# over. Set to 0: the best-scoring model wins outright, no handicap. Candidates
# are still walked simplest-first and the comparison is strictly less-than, so an
# exact tie still goes to the simpler model — but nothing else does. The cost of
# 0 is churn: the published model can now flip between nightly runs on ordinary
# fold noise, so a forecast can change without the underlying data changing.
SELECT_MARGIN = 0.0

# Bounds on the band calibration factor (see band_scale_of). A few held-out
# months can throw an extreme quantile, and a 30x-wide band is less useful than
# an honestly-wrong one.
BAND_SCALE_MIN, BAND_SCALE_MAX = 0.25, 4.0

# ETS grid, scored on in-sample one-step error. This spans the three Holt-Winters
# trend types rather than assuming one:
#   trend=False           no trend at all (Holt-Winters "N") — the right model for
#                         a flat series, where fitting a slope is pure variance
#   trend=True,  phi=1.0  undamped additive trend ("A")
#   trend=True,  phi<1.0  damped additive trend ("Ad")
# When trend is off, beta and phi are meaningless, so those combinations are
# skipped instead of refitting the same model 9 times: 16 + 144 = 160 fits per
# call, ~11% more than the previous 144 and still ~50ms.
ETS_GRID = {
    "alpha": (0.1, 0.2, 0.3, 0.5),
    "beta": (0.01, 0.05, 0.1),
    "gamma": (0.05, 0.1, 0.2, 0.3),
    "phi": (0.85, 0.95, 1.0),
    "trend": (True, False),
}

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
        # Fourier order for the annual cycle. NOT "predict yearly" — the period
        # is one year and the data is monthly, so this IS the month-to-month
        # seasonal shape; 2 harmonics describe it with 4 parameters instead of
        # 12. Measured head-to-head on 164 series (fourier 2 vs 6, identical
        # folds): median MASE 0.857 -> 0.809, mean 1.710 -> 1.402, and p90
        # 3.501 -> 2.100 with catastrophic fits (MASE > 2) down from 27 to 19.
        # The gain is almost entirely in the TAIL, which is the signature of
        # overfitting: 6 harmonics has enough freedom to interpolate a 12-point
        # annual cycle, so it fits noise on the short histories this catalogue
        # is full of.
        yearly_seasonality=2,
        weekly_seasonality=False,
        daily_seasonality=False,
        seasonality_mode="multiplicative",
        holidays=hol_df if len(hol_df) else None,
        holidays_prior_scale=HOLIDAY_PRIOR,   # same constant the per-row prior uses
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


def month_span(a, b):
    """Whole calendar months from month-start `a` to month-start `b`."""
    return (b.year - a.year) * 12 + (b.month - a.month)


def mape_of(preds, actuals):
    """Mean absolute percentage error over pairs with a non-zero actual;
    None when nothing is scoreable. Published for recognisability only —
    see the header on why it never drives model selection."""
    pairs = [(float(p), float(a)) for p, a in zip(preds, actuals) if a]
    if not pairs:
        return None
    return sum(abs(p - a) / a for p, a in pairs) / len(pairs) * 100


def quantile(vals, q):
    """Empirical q-quantile, linearly interpolated. None on an empty list."""
    if not vals:
        return None
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def band_scale_of(abs_z):
    """How much a candidate's own prediction band has to be stretched (or
    shrunk) for it to actually cover what it claims.

    Each held-out month contributes |actual − forecast| divided by that month's
    own one-sided band half-width, so `abs_z` is in units of "claimed bands".
    The INTERVAL-th quantile of that is the factor which would have put exactly
    INTERVAL of the held-out months inside the band. > 1 widens a band that was
    too narrow, < 1 tightens one that was too wide.

    This is needed because the three candidates derive their bands three
    incompatible ways — Prophet samples a posterior, ETS grows from in-sample
    residuals, the seasonal naive uses a seasonal-random-walk sigma — and
    measured coverage of a nominal 80% band ran at a median 39% for Prophet and
    100% for the naive. A published "80% interval" that covers 39% (or 100%) of
    held-out months is simply mislabelled, whichever direction it errs in.

    Clamped: a handful of held-out months can produce an absurd quantile, and a
    30x band is less useful than an honestly-wrong one. None when nothing
    scoreable."""
    scale = quantile([z for z in abs_z if z is not None], INTERVAL)
    if scale is None or scale <= 0:
        return None
    return round(min(BAND_SCALE_MAX, max(BAND_SCALE_MIN, scale)), 3)


def apply_band_scale(v, lo, hi, scale):
    """Stretch a band around its own point forecast, keeping any asymmetry
    (Prophet's posterior is not symmetric, and a naive band clamps at zero)."""
    if not scale:
        return v, lo, hi
    return v, v - (v - lo) * scale, v + (hi - v) * scale


def mae_of(preds, actuals):
    """Plain mean absolute error, in the series' own units. Only used to rank
    candidates when MASE is undefined for all of them — see choose_model()."""
    pairs = [(float(p), float(a)) for p, a in zip(preds, actuals)]
    if not pairs:
        return None
    return sum(abs(p - a) for p, a in pairs) / len(pairs)


def mase_of(preds, actuals, scale):
    """Mean absolute SCALED error: MAE over the held-out months divided by
    `scale`, the in-sample seasonal-naive MAE. Every pair counts — unlike MAPE
    there is no division by the actual, so a month that came in at zero is
    scored rather than skipped, and a series hovering near zero doesn't blow
    the metric up. 1.0 means "no better than a seasonal naive was on its own
    training data"; below 1 is a genuine win.

    None when `scale` is zero or missing, which is not a failure but a real
    case: a series with no year-over-year movement at all (a flat feed, or one
    that repeats exactly) has nothing to scale by, because the seasonal naive
    already reproduces its training data perfectly. choose_model() ranks on
    plain MAE there rather than inventing a scaled number."""
    if not scale or scale <= 0:
        return None
    mae = mae_of(preds, actuals)
    return None if mae is None else mae / scale


def seasonal_naive_errors(train):
    """y_t − y_{t−12} over the training months that have a year-ago
    counterpart. The raw material for both MASE's scale (their mean absolute
    value) and the seasonal-naive prediction band (their sd). Computed on the
    TRAINING rows only, never the holdout, so the scale can't leak the answer
    into the score it normalises."""
    by_ds = {ds: float(y) for ds, y in zip(train["ds"], train["y"])}
    out = []
    for ds, y in by_ds.items():
        prev = ds - pd.DateOffset(years=1)
        if prev in by_ds:
            out.append(y - by_ds[prev])
    return out


def seasonal_naive_scale(train):
    """MASE's denominator: mean |y_t − y_{t−12}| over the training months.
    None when no month has a year-ago counterpart (nothing to scale by)."""
    errs = seasonal_naive_errors(train)
    return (sum(abs(e) for e in errs) / len(errs)) if errs else None


def snaive_path(train, target_ds):
    """Candidate 1 — seasonal naive. Each target month takes the most recent
    observed value for that same calendar month, stepping back a whole year at
    a time; for horizons within 12 months that is the textbook seasonal naive,
    and beyond it the last observed seasonal cycle simply repeats.

    The band is the seasonal random walk's: sigma × sqrt(k) where sigma is the
    sd of the in-sample year-over-year steps and k counts the whole seasonal
    cycles the horizon spans. An honest closed form, not a posterior.

    Returns {ds: (v, lo, hi)}, skipping any target with no year-ago anchor."""
    by_ds = {ds: float(y) for ds, y in zip(train["ds"], train["y"])}
    if not by_ds:
        return {}
    first, last = min(by_ds), max(by_ds)
    errs = seasonal_naive_errors(train)
    sigma = (sum(e * e for e in errs) / len(errs)) ** 0.5 if errs else 0.0
    out = {}
    for ds in target_ds:
        probe, v = ds - pd.DateOffset(years=1), None
        while probe >= first:
            if probe in by_ds:
                v = by_ds[probe]
                break
            probe -= pd.DateOffset(years=1)
        if v is None:
            continue
        cycles = max(1, (max(0, month_span(last, ds)) - 1) // 12 + 1)
        w = Z_INTERVAL * sigma * (cycles ** 0.5)
        out[ds] = (v, max(0.0, v - w), v + w)
    return out


def contiguous_tail(df):
    """The longest gap-free monthly run ending at the latest observation. ETS
    carries state forward one month at a time, so a hole mid-series would be
    silently treated as a single step — the tail is what it can honestly fit."""
    ds = list(df["ds"])
    start = len(ds) - 1
    while start > 0 and month_span(ds[start - 1], ds[start]) == 1:
        start -= 1
    return df.iloc[start:]


def ets_fit(df, alpha, beta, gamma, phi, trend_on=True, P=12):
    """Holt-Winters with an additive DAMPED trend and multiplicative monthly
    seasonality, over a gap-free frame. Seasonal slots are indexed by real
    calendar month, so the fit doesn't assume the series starts in January.
    Returns the end state, the one-step relative residuals (the band's raw
    material) and the mean squared error the grid search ranks on. None when
    there aren't two full seasons to initialise from."""
    ys = [float(v) for v in df["y"]]
    ms = [int(d.month) - 1 for d in df["ds"]]
    n = len(ys)
    if n < 2 * P:
        return None
    overall = (sum(ys[:2 * P]) / (2 * P)) or 1.0
    sums, counts = [0.0] * P, [0] * P
    for i in range(2 * P):
        sums[ms[i]] += ys[i] / overall
        counts[ms[i]] += 1
    seas = [(sums[i] / counts[i]) if counts[i] else 1.0 for i in range(P)]
    mean_seas = (sum(seas) / P) or 1.0
    seas = [s / mean_seas for s in seas]
    y1, y2 = sum(ys[:P]) / P, sum(ys[P:2 * P]) / P
    # trend_on=False pins the slope at zero for the whole fit — a level-only
    # model, which is what a flat or erratic series actually wants
    level, trend = y1, ((y2 - y1) / P if trend_on else 0.0)
    # A MULTIPLICATIVE seasonal model has no meaning at or below zero. On a
    # collapsing series the level crosses zero, y/level flips sign, and the
    # seasonal index goes negative — BMA fitted September at -9.428, which made
    # the point forecast negative and inverted every band derived from it
    # (v=0, lo=17217, hi=0 after clamping). validate-data is a HARD GATE in the
    # nightly, so one such series fails the run and freezes last-good forecasts
    # for the whole catalogue. Floor both states at a hair above zero, scaled to
    # the series so it stays numerically harmless.
    floor = max(1e-9, 1e-6 * (sum(ys) / n))
    resid, sse, scored = [], 0.0, 0
    for t in range(n):
        mi = ms[t]
        f = (level + phi * trend) * (seas[mi] or 1.0)
        if t >= P:                       # first season initialised the state
            sse += (ys[t] - f) ** 2
            scored += 1
            if f > 0:
                resid.append(ys[t] / f - 1)
        prev = level
        level = max(floor, alpha * (ys[t] / (seas[mi] or floor)) + (1 - alpha) * (level + phi * trend))
        if trend_on:
            trend = beta * (level - prev) + (1 - beta) * phi * trend
        seas[mi] = max(floor, gamma * (ys[t] / (level or floor)) + (1 - gamma) * seas[mi])
    return {"level": level, "trend": trend, "phi": phi, "trend_on": trend_on, "seas": seas,
            "resid": resid, "mse": (sse / scored) if scored else float("inf")}


def ets_best_fit(df):
    """Coarse grid search over the smoothing constants and the damping factor,
    ranked on in-sample one-step MSE."""
    best = None
    for alpha in ETS_GRID["alpha"]:
        for gamma in ETS_GRID["gamma"]:
            for trend_on in ETS_GRID["trend"]:
                # beta/phi only exist when there is a trend to smooth and damp
                betas = ETS_GRID["beta"] if trend_on else (0.0,)
                phis = ETS_GRID["phi"] if trend_on else (1.0,)
                for beta in betas:
                    for phi in phis:
                        f = ets_fit(df, alpha, beta, gamma, phi, trend_on)
                        if f and (best is None or f["mse"] < best["mse"]):
                            best = f
    return best


def ets_path(train, target_ds):
    """Candidate 2 — damped Holt-Winters. The trend contributes
    phi + phi^2 + ... + phi^h, so phi < 1 flattens the projection instead of
    compounding whatever slope the last few months happened to show; that is
    exactly the failure mode on a short or broken series. The band grows from
    the relative one-step residuals — an approximation, disclosed on the model
    card. Returns {ds: (v, lo, hi)}."""
    if not len(target_ds):
        return {}
    tail = contiguous_tail(train)
    fit = ets_best_fit(tail)
    if not fit:
        return {}
    last = tail["ds"].iloc[-1]
    horizon = month_span(last, max(target_ds))
    if horizon < 1:
        return {}
    rr = fit["resid"][-36:]
    sd = (sum(x * x for x in rr) / len(rr)) ** 0.5 if rr else 0.08
    out, damp = {}, 0.0
    for h in range(1, horizon + 1):
        damp += fit["phi"] ** h
        ds = last + pd.DateOffset(months=h)
        # clamp the product, not the level: a negative seasonal factor would
        # otherwise turn a clamped-positive level into a negative forecast
        v = max(0.0, (fit["level"] + damp * fit["trend"]) * (fit["seas"][ds.month - 1] or 1.0))
        w = Z_INTERVAL * sd * (h ** 0.5)
        out[ds] = (v, max(0.0, v * (1 - w)), max(0.0, v * (1 + w)))
    return {ds: out[ds] for ds in target_ds if ds in out}


def prophet_path(train, hol_df, target_ds, gdp_levels=None, gdp_growth=None,
                 gdp_future_rates=None):
    """Candidate 3 — Prophet, through the same fit_predict() the final forecast
    uses. Sized by CALENDAR distance to the last target, not by the number of
    held-out rows: Prophet predicts contiguous months, so on a gappy series a
    row count would leave the tail of the window unpredicted. Returns
    {ds: (v, lo, hi)}, empty if the fit raises (a candidate that can't fit is
    simply out of the running rather than taking the whole metric down)."""
    if not len(target_ds):
        return {}
    horizon = month_span(train["ds"].iloc[-1], max(target_ds))
    if horizon < 1:
        return {}
    try:
        _, fc = fit_predict(train, hol_df, horizon, gdp_levels, gdp_growth, gdp_future_rates)
    except Exception:
        return {}
    return path_from_prophet(fc, target_ds)


def path_from_prophet(fc, target_ds):
    """{ds: (yhat, lower, upper)} for the requested months of a Prophet
    prediction frame, dropping any month it didn't predict."""
    fx = fc.set_index("ds")
    out = {}
    for ds in target_ds:
        if ds in fx.index:
            out[ds] = (float(fx.at[ds, "yhat"]),
                       float(fx.at[ds, "yhat_lower"]),
                       float(fx.at[ds, "yhat_upper"]))
    return out


def choose_model(scores):
    """Which candidate to publish: the lowest error, full stop. Candidates are
    walked simplest-first and the comparison is strictly less-than, so an exact
    tie goes to the simpler model; SELECT_MARGIN (0) adds no further handicap.

    Ranks on MASE. When MASE is undefined for every candidate — a series with no
    year-over-year movement to scale by — it ranks on plain MAE instead. That
    case must not fall through to a default: the series where the scale
    degenerates is precisely the series the seasonal naive fits perfectly, so
    defaulting to the most complex model would get it exactly backwards.

    Returns (name, reason); name is None only when nothing scored at all."""
    for key, label in (("mase", "MASE"), ("mae", "MAE")):
        ranked = [(n, scores[n]) for n in CANDIDATES
                  if n in scores and scores[n].get(key) is not None]
        if not ranked:
            continue
        best, best_score = ranked[0][0], ranked[0][1][key]
        for name, s in ranked[1:]:
            if s[key] < best_score * (1 - SELECT_MARGIN):
                best, best_score = name, s[key]
        detail = ", ".join(f"{n} {s[key]}" for n, s in ranked)
        note = ("" if key == "mase" else
                " — ranked on unscaled MAE because the series has no "
                "year-over-year variation for MASE to scale by")
        margin = (f" with a {round(SELECT_MARGIN * 100)}% simplicity margin"
                  if SELECT_MARGIN else "")
        return best, f"lowest backtest {label}{margin} ({detail}){note}"
    return None, "no candidate could be scored"


def rolling_backtest(df, hol_df, folds=BACKTEST_FOLDS, holdout=BACKTEST_H,
                     gdp_levels=None, gdp_growth=None, gdp_future_rates=None):
    """Rolling-origin evaluation of EVERY candidate on IDENTICAL folds: up to
    `folds` refits, each trained on the series truncated a further `holdout`
    months back and scored on the next `holdout` months no candidate saw. Every
    model faces the same training data and the same held-out months, which is
    the only way the MASE comparison that picks the winner means anything.

    Returns name -> {
      mase        mean across folds — the number model selection runs on
      mase_folds  per-fold values, so a lucky single holdout can't hide
      mape        mean across folds (published for recognisability)
      mape_folds  per-fold values
      coverage    % of held-out months inside that candidate's claimed band
      backtest    the most recent fold's month-by-month predicted-vs-actual,
                  shipped so the UI can show what the model got wrong
    }, omitting any candidate that never scored. None when even one fold can't
    be formed (needs 24 training months)."""
    acc = {n: {"mase": [], "mape": [], "mae": [], "abs_z": [], "hits": 0, "n_int": 0, "detail": None}
           for n in CANDIDATES}
    scored_any = False
    for i in range(1, folds + 1):
        cut = len(df) - holdout * i
        if cut < 24:
            break
        train, test = df.iloc[:cut], df.iloc[cut:cut + holdout]
        target = list(test["ds"])
        actual = {ds: float(y) for ds, y in zip(test["ds"], test["y"])}
        scale = seasonal_naive_scale(train)
        paths = {
            "snaive": snaive_path(train, target),
            "ets": ets_path(train, target),
            "prophet": prophet_path(train, hol_df, target, gdp_levels, gdp_growth, gdp_future_rates),
        }
        for name in CANDIDATES:
            path = paths.get(name) or {}
            months = [ds for ds in target if ds in path]
            if not months:
                continue
            preds = [path[ds][0] for ds in months]
            acts = [actual[ds] for ds in months]
            a = acc[name]
            mase = mase_of(preds, acts, scale)
            mape = mape_of(preds, acts)
            mae = mae_of(preds, acts)
            if mase is not None:
                a["mase"].append(mase)
            if mape is not None:
                a["mape"].append(mape)
            if mae is not None:
                a["mae"].append(mae)
            if mase is None and mape is None and mae is None:
                continue
            scored_any = True
            for ds in months:
                v, lo, hi = path[ds]
                a["n_int"] += 1
                if lo <= actual[ds] <= hi:
                    a["hits"] += 1
                # distance to the actual in units of this month's own band, on
                # the side the error actually fell — the raw material for the
                # band calibration below
                half = (hi - v) if actual[ds] > v else (v - lo)
                if half > 0:
                    a["abs_z"].append(abs(actual[ds] - v) / half)
            if i == 1:
                a["detail"] = [
                    {"date": f"{ds.year}-{ds.month:02d}",
                     "v": max(0, round(path[ds][0])),
                     "lo": max(0, round(path[ds][1])),
                     "hi": max(0, round(path[ds][2])),
                     "actual": round(actual[ds])}
                    for ds in months
                ]
    if not scored_any:
        return None
    out = {}
    for name in CANDIDATES:
        a = acc[name]
        if not a["mase"] and not a["mape"] and not a["mae"]:
            continue
        scale = band_scale_of(a["abs_z"])
        out[name] = {
            "mase": round(sum(a["mase"]) / len(a["mase"]), 3) if a["mase"] else None,
            "mase_folds": [round(m, 3) for m in a["mase"]],
            "mape": round(sum(a["mape"]) / len(a["mape"]), 1) if a["mape"] else None,
            "mape_folds": [round(m, 1) for m in a["mape"]],
            # only load-bearing when MASE degenerates (see choose_model)
            "mae": round(sum(a["mae"]) / len(a["mae"]), 1) if a["mae"] else None,
            # coverage of the model's RAW band, measured out-of-sample. Stays
            # the honest headline number; the calibration below is fitted on
            # these same months, so its coverage can't claim to be out-of-sample.
            "coverage": round(a["hits"] / a["n_int"] * 100) if a["n_int"] else None,
            "band_scale": scale,
            "coverage_cal": (round(sum(1 for z in a["abs_z"] if z <= scale) / len(a["abs_z"]) * 100)
                             if (scale and a["abs_z"]) else None),
            "backtest": a["detail"] or [],
        }
    return out or None


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


def top_holidays(fc, names, k=5):
    """Rank holidays by mean absolute contribution over the horizon.
    Reads the per-holiday component columns off the prediction frame; the
    fitted model itself isn't needed."""
    cols = [c for c in names if c in fc.columns]
    if not cols:
        return []
    tail = fc.tail(HORIZON)
    scored = [(c, float(tail[c].abs().mean())) for c in cols]
    scored = [s for s in scored if s[1] > 0]
    scored.sort(key=lambda s: s[1], reverse=True)
    return [c for c, _ in scored[:k]]


def forecast_rows(path, target_ds, band_scale=None):
    """{ds: (v, lo, hi)} -> the row shape the browser reads, with the band
    stretched by this candidate's measured calibration factor (see
    band_scale_of). Rounding is monotonic and clamped the same way for all
    three, so lo <= v <= hi and lo >= 0 survive — validate-data.mjs gates on
    exactly that."""
    rows = []
    for ds in target_ds:
        if ds not in path:
            continue
        v, lo, hi = apply_band_scale(*path[ds], band_scale)
        # Last-resort ordering guarantee. validate-data rejects lo > hi as a hard
        # gate, which would keep last-good for EVERY airport, so a single
        # pathological series must not be able to freeze the refresh. Ordering is
        # restored rather than the row dropped, so the failure stays visible in
        # the numbers instead of becoming a silent gap.
        lo, hi = min(lo, v, hi), max(lo, v, hi)
        rows.append({
            "date": f"{ds.year}-{ds.month:02d}",
            "y": int(ds.year),
            "m": int(ds.month) - 1,
            "v": max(0, round(v)),
            "lo": max(0, round(lo)),
            "hi": max(0, round(hi)),
        })
    return rows


def forecast_metric(iso2, monthly, horizon, gdp_levels=None, gdp_growth=None, gdp_future_rates=None):
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

    _, fc = fit_predict(df, fit_holidays, horizon, gdp_levels=gdp_levels, gdp_growth=gdp_growth, gdp_future_rates=gdp_future_rates)
    scores = rolling_backtest(df, fit_holidays, gdp_levels=gdp_levels, gdp_growth=gdp_growth, gdp_future_rates=gdp_future_rates) or {}

    # every candidate's forward forecast, over the same months. Prophet reuses
    # the fit above (it also feeds seasonal12/top_holidays); the other two are
    # cheap closed forms over the full series.
    last_ds = df["ds"].max()
    target = [last_ds + pd.DateOffset(months=h) for h in range(1, horizon + 1)]
    paths = {
        "snaive": snaive_path(df, target),
        "ets": ets_path(df, target),
        "prophet": path_from_prophet(fc, target),
    }
    candidates = {}
    for name in CANDIDATES:
        c = dict(scores.get(name) or {})
        # the published forward band is calibrated; the backtest rows shipped
        # for the accountability chart deliberately are NOT, because the
        # calibration was fitted on exactly those months — showing them
        # widened would flatter the model on its own training data
        rows = forecast_rows(paths.get(name) or {}, target, c.get("band_scale"))
        if not rows:
            continue
        c["forecast"] = rows
        candidates[name] = c
    if not candidates:
        return None

    chosen, reason = choose_model(candidates)
    if chosen not in candidates:
        # No fold could be scored at all. Fall back to the SIMPLEST candidate
        # available, not the most capable: with no evidence either way, the
        # burden of proof stays on the complex model. Say so, rather than
        # implying a backtest picked it.
        chosen = next((n for n in CANDIDATES if n in candidates), None)
        reason = f"{reason}; defaulted to the simplest candidate ({chosen})"
    top = candidates[chosen]

    # the chosen candidate's arrays live at the TOP LEVEL (unchanged shape, so
    # an older client and the validator still read it); `candidates` carries
    # every candidate's scores plus the ALTERNATIVES' arrays, which is what the
    # browser's model toggle switches to. The winner's arrays are deliberately
    # not duplicated inside `candidates` — it's ~2.5 KB a metric across 446
    # airports, committed nightly.
    published = {}
    for name, c in candidates.items():
        entry = {k: c.get(k) for k in ("mase", "mase_folds", "mape", "mape_folds", "mae",
                                       "coverage", "band_scale", "coverage_cal")}
        if name != chosen:
            entry["forecast"] = c["forecast"]
            entry["backtest"] = c.get("backtest") or []
        published[name] = entry

    naive_mape = (candidates.get("snaive") or {}).get("mape")
    mape = top.get("mape")
    return {
        "chosen": chosen,
        "chosen_reason": reason,
        "candidates": published,
        "mase": top.get("mase"),
        "mase_folds": top.get("mase_folds") or [],
        "mape": mape,
        "mape_folds": top.get("mape_folds") or [],
        "naive_mape": naive_mape,
        "naive_mase": (candidates.get("snaive") or {}).get("mase"),
        "skill": (round(1 - mape / naive_mape, 2)
                  if (mape is not None and naive_mape) else None),
        "coverage": top.get("coverage"),
        "band_scale": top.get("band_scale"),
        "coverage_cal": top.get("coverage_cal"),
        "backtest": top.get("backtest") or [],
        "months_history": int(len(df)),
        "latest": f"{df['ds'].max().year}-{df['ds'].max().month:02d}",
        "seasonal12": seasonal12(df),
        "holidays": top_holidays(fc, names),
        "holidays_total": len(names),
        "gdpRegressor": bool(gdp_levels),
        "gdpForecast": bool(gdp_future_rates),
        "forecast": top["forecast"],
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
    chosen_counts = {}
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
                res = forecast_metric(iso2, monthly, HORIZON, gdp_levels, gdp_growth, gdp_future_rates)
            except Exception as e:
                print(f"  {iata}/{metric}: FAILED ({e})", file=sys.stderr)
                res = None
            if res:
                metrics[metric] = res
                n_series += 1
                chosen_counts[res["chosen"]] = chosen_counts.get(res["chosen"], 0) + 1
                alts = "  ".join(
                    f"{n}{'*' if n == res['chosen'] else ''} MASE {c.get('mase')}"
                    for n, c in res["candidates"].items())
                print(f"  {iata}/{metric}: {res['months_history']}mo  {alts}"
                      f"  MAPE {res['mape']}%  holidays[{res['holidays_total']}]")
        if metrics:
            with open(os.path.join(FORECASTS_DIR, f"{iata}.json"), "w", encoding="utf-8") as f:
                json.dump(metrics, f, separators=(",", ":"))
                f.write("\n")
            airports_written.append(iata)

    if not only:
        prune_stale(FORECASTS_DIR, airports_written)

    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "model": "auto-selected per series by backtest MASE",
        "models": {
            "snaive": "Seasonal naive — each month repeats the most recent observed value for that calendar month",
            "ets": "Holt-Winters — damped additive trend + multiplicative monthly seasonality, smoothing grid-searched on one-step error",
            "prophet": "Meta Prophet — additive trend + multiplicative yearly + country holidays + COVID 2020-21 events + GDP/capita regressor where available",
        },
        "selection": (f"lowest mean MASE over the backtest folds — the best-scoring model wins outright. "
                      f"Candidates are tried simplest-first so an exact tie goes to the simpler model; "
                      f"no other handicap is applied (SELECT_MARGIN={SELECT_MARGIN}). MASE scales by the in-sample "
                      f"seasonal-naive MAE, so it stays finite on series that approach zero — which MAPE "
                      f"does not, and why MAPE is published but never decides."),
        "chosenCounts": chosen_counts,
        "library": f"prophet {__import__('prophet').__version__}, holidays {holidays_pkg.__version__}",
        "interval": INTERVAL,
        "horizon": HORIZON,
        "backtest": f"rolling-origin, up to {BACKTEST_FOLDS} folds x {BACKTEST_H}mo holdouts; every candidate scored on identical folds; {round(INTERVAL * 100)}% interval coverage measured on the same held-out months",
        "bands": (f"each candidate's raw interval is rescaled by the {round(INTERVAL * 100)}th percentile of its "
                  f"held-out error measured in units of its own band half-width, clamped to "
                  f"[{BAND_SCALE_MIN}, {BAND_SCALE_MAX}]. Raw coverage of a nominal {round(INTERVAL * 100)}% band ran "
                  f"at a median 39% for Prophet and 100% for the seasonal naive, so the label was wrong in both "
                  f"directions. `coverage` stays the raw out-of-sample number; `coverage_cal` is the scaled band on "
                  f"the same months and is therefore in-sample. Applied to the forward forecast only - the shipped "
                  f"backtest rows keep the band the model actually claimed."),
        "note": ("Short-term forecasts. Fit nightly by .github/workflows/refresh-data.yml "
                 "on the real observed series. Per-airport output lives in "
                 "data/forecasts/<IATA>.json, fetched by the browser once that gateway "
                 "is selected; each metric carries the chosen model at the top level plus "
                 "every candidate's scores (and the alternatives' forecasts) under "
                 "`candidates`, which is what the model toggle in the UI switches between. "
                 "This file only carries the shared model metadata."),
    }
    with open(META_OUT, "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"))
        f.write("\n")
    picks = "  ".join(f"{n}={chosen_counts.get(n, 0)}" for n in CANDIDATES)
    print(f"Wrote {FORECASTS_DIR}/ — {len(airports_written)} airports, {n_series} series "
          f"(chosen: {picks}). Wrote {META_OUT}.")


if __name__ == "__main__":
    main()
