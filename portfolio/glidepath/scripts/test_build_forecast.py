#!/usr/bin/env python3
# =============================================================================
# test_build_forecast.py — tests for build-forecast.py's pure-logic helpers
#
# Covers the functions that don't require an actual Prophet fit (series_frame,
# seasonal12, covid_events, monthly_holidays, gdp_monthly_series, prune_stale,
# load_airport_series) — the model-fitting path (fit_predict/backtest_mape/
# forecast_metric) is
# exercised by the nightly CI run against real data instead, since fitting
# Prophet per test would make this suite slow and non-deterministic-ish.
#
# Run:  pytest scripts/test_build_forecast.py
#       (needs: pip install prophet holidays pandas pytest)
# =============================================================================
import importlib.util
import json
import os
import sys

import pandas as pd
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_module():
    """build-forecast.py has a hyphen in its name, so it can't be imported
    with a normal `import` statement — load it by file path instead."""
    spec = importlib.util.spec_from_file_location("build_forecast", os.path.join(HERE, "build-forecast.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def bf():
    return _load_module()


def test_series_frame_sorts_and_drops_nulls(bf):
    df = bf.series_frame({"2024-03": 300, "2024-01": 100, "2024-02": None})
    assert list(df["ds"]) == [pd.Timestamp(2024, 1, 1), pd.Timestamp(2024, 3, 1)]
    assert list(df["y"]) == [100.0, 300.0]


def test_series_frame_empty_or_all_null_returns_none(bf):
    assert bf.series_frame({}) is None
    assert bf.series_frame({"2024-01": None, "2024-02": None}) is None


def test_gdp_monthly_series_interpolates_between_known_years(bf):
    # 5% flat annual growth, anchored at July 1 of each year -> the midpoint
    # between two anchors (Jan 1) should land exactly halfway.
    levels = {2022: 100.0, 2023: 105.0, 2024: 110.25}
    months = [pd.Timestamp(2023, 1, 1), pd.Timestamp(2022, 7, 1), pd.Timestamp(2024, 7, 1)]
    out = bf.gdp_monthly_series(levels, 5.0, months)
    assert out[0] == pytest.approx(102.5)   # halfway between the 2022 and 2023 anchors
    assert out[1] == pytest.approx(100.0)   # exact anchor
    assert out[2] == pytest.approx(110.25)  # exact anchor


def test_gdp_monthly_series_extrapolates_past_the_known_years(bf):
    # World Bank publishes no GDP forecast — extrapolation past the last
    # known year has to compound the given trailing growth rate, not just
    # flat-line or error out.
    levels = {2022: 100.0, 2023: 105.0, 2024: 110.25}
    out = bf.gdp_monthly_series(levels, 5.0, [pd.Timestamp(2025, 7, 1), pd.Timestamp(2021, 7, 1)])
    assert out[0] == pytest.approx(110.25 * 1.05, rel=1e-6)  # one year past the last anchor
    assert out[1] == pytest.approx(100.0 / 1.05, rel=1e-6)   # one year before the first anchor


def test_gdp_monthly_series_prefers_real_future_rates_over_the_trailing_average(bf):
    # A real per-year forecast (e.g. IMF WEO) should drive the extrapolated
    # year it covers, not the flat trailing rate — that's the whole point of
    # having it. 2025 has a real 8% rate on file; 2026 doesn't, so it must
    # fall back to the 5% trailing rate for that year only.
    levels = {2024: 100.0}
    out = bf.gdp_monthly_series(levels, 5.0, [pd.Timestamp(2025, 7, 1), pd.Timestamp(2026, 7, 1)],
                                 future_annual_rates={2025: 8.0})
    assert out[0] == pytest.approx(108.0, rel=1e-6)          # 100 * 1.08 (real rate)
    assert out[1] == pytest.approx(108.0 * 1.05, rel=1e-6)   # 108 * 1.05 (trailing fallback, 2026 not covered)


def test_gdp_monthly_series_interpolates_within_an_extrapolated_year(bf):
    # a month partway through a synthetic future year should land partway
    # between that year's July anchor and the next, not jump discretely.
    levels = {2024: 100.0}
    out = bf.gdp_monthly_series(levels, 0.0, [pd.Timestamp(2025, 1, 1)], future_annual_rates={2025: 10.0})
    assert 100.0 < out[0] < 110.0


def test_gdp_monthly_series_returns_none_when_no_levels_available(bf):
    assert bf.gdp_monthly_series({}, 5.0, [pd.Timestamp(2024, 1, 1)]) is None
    assert bf.gdp_monthly_series(None, 5.0, [pd.Timestamp(2024, 1, 1)]) is None


def test_gdp_monthly_series_returns_none_for_an_empty_month_list_instead_of_crashing(bf):
    # max() over an empty generator raises ValueError — nothing currently
    # calls this with an empty month_starts, but it's a public-ish helper
    # now (fit_predict takes gdp_levels as a param), so a future direct call
    # with no requested months shouldn't crash the whole build.
    assert bf.gdp_monthly_series({2024: 100.0}, 5.0, []) is None


def test_gdp_monthly_series_treats_a_missing_growth_rate_as_flat(bf):
    # a country can have real levels but no trailing-rate summary (e.g. a
    # brand new entry) — extrapolation should hold flat, not crash.
    out = bf.gdp_monthly_series({2023: 100.0}, None, [pd.Timestamp(2025, 7, 1)])
    assert out[0] == pytest.approx(100.0)


def test_seasonal12_returns_twelve_values_reflecting_the_pattern(bf):
    # January always 2x every other month's value -> index[0] should be ~2x
    # the other months, and the whole thing should average out around 1.0.
    rows = []
    for year in (2022, 2023, 2024):
        for month in range(1, 13):
            v = 200 if month == 1 else 100
            rows.append({"ds": pd.Timestamp(year, month, 1), "y": v})
    df = pd.DataFrame(rows)
    idx = bf.seasonal12(df)
    assert len(idx) == 12
    assert idx[0] > 1.5   # January over-indexes
    assert idx[5] < 1.2   # a normal month sits near 1.0


def test_seasonal12_falls_back_to_full_history_when_recent_window_is_thin(bf):
    # under a year of data -> the "last 3 years" filter would leave < 12 rows,
    # so it must fall back to using everything rather than erroring.
    df = pd.DataFrame([{"ds": pd.Timestamp(2024, m, 1), "y": 100} for m in range(1, 7)])
    idx = bf.seasonal12(df)
    assert len(idx) == 12


def test_covid_events_covers_the_acute_window_when_the_series_spans_it(bf):
    df = pd.DataFrame([{"ds": pd.Timestamp(2019, 1, 1) + pd.DateOffset(months=i), "y": 100} for i in range(48)])  # 2019-01..2022-12
    events = bf.covid_events(df)
    # COVID_START/COVID_END = 2020-03..2021-12 inclusive = 22 months
    assert len(events) == 22
    assert events["ds"].min() == pd.Timestamp(2020, 3, 1)
    assert events["ds"].max() == pd.Timestamp(2021, 12, 1)
    assert all(events["holiday"].str.startswith("covid_"))


def test_covid_events_empty_when_series_is_entirely_outside_the_window(bf):
    df = pd.DataFrame([{"ds": pd.Timestamp(2022, m, 1), "y": 100} for m in range(1, 13)])
    events = bf.covid_events(df)
    assert len(events) == 0


def test_monthly_holidays_snaps_dates_to_the_first_of_the_month(bf):
    hol_df, names = bf.monthly_holidays("CA", [2024])
    assert len(hol_df) > 0
    assert len(names) > 0
    assert all(d.day == 1 for d in hol_df["ds"])
    assert set(hol_df.columns) >= {"holiday", "ds"}


def test_monthly_holidays_falls_back_gracefully_for_an_unknown_country(bf):
    hol_df, names = bf.monthly_holidays("ZZ", [2024])
    assert list(hol_df.columns) == ["holiday", "ds"]
    assert len(hol_df) == 0
    assert names == []


def test_load_airport_series_reads_and_returns_none_when_missing(bf, tmp_path, monkeypatch):
    monkeypatch.setattr(bf, "SERIES_DIR", str(tmp_path))
    (tmp_path / "TST.json").write_text(json.dumps({"series": {"pax": {"2024-01": 1000}}}))
    assert bf.load_airport_series("TST") == {"pax": {"2024-01": 1000}}
    assert bf.load_airport_series("NOPE") is None


def test_prune_stale_removes_only_files_outside_the_keep_set(bf, tmp_path, monkeypatch):
    for code in ("AAA", "BBB", "CCC"):
        (tmp_path / f"{code}.json").write_text("{}")
    bf.prune_stale(str(tmp_path), ["AAA", "CCC"])
    remaining = sorted(p.name for p in tmp_path.iterdir())
    assert remaining == ["AAA.json", "CCC.json"]


# ---- rolling-origin backtest (Phase 1) --------------------------------------

def test_mape_of_scores_pairs_and_skips_zero_actuals(bf):
    assert bf.mape_of([110, 90], [100, 100]) == pytest.approx(10.0)
    assert bf.mape_of([5, 110], [0, 100]) == pytest.approx(10.0)  # zero actual skipped
    assert bf.mape_of([], []) is None
    assert bf.mape_of([5], [0]) is None


def test_seasonal_naive_preds_uses_the_year_ago_month(bf):
    train = bf.series_frame({f"2023-{m:02d}": 100 + m for m in range(1, 13)})
    test = bf.series_frame({f"2024-{m:02d}": 200 + m for m in range(1, 4)})
    preds, actuals = bf.seasonal_naive_preds(train, test)
    assert preds == [101.0, 102.0, 103.0]   # Jan-Mar 2023 values
    assert actuals == [201.0, 202.0, 203.0]


def test_seasonal_naive_preds_skips_months_without_a_year_ago_anchor(bf):
    train = bf.series_frame({"2023-06": 100})
    test = bf.series_frame({"2024-01": 50})
    preds, actuals = bf.seasonal_naive_preds(train, test)
    assert preds == [] and actuals == []


def test_rolling_backtest_returns_none_when_history_is_too_short(bf):
    df = bf.series_frame({f"2024-{m:02d}": 100 for m in range(1, 13)})  # 12 months
    assert bf.rolling_backtest(df, pd.DataFrame(columns=["holiday", "ds"])) is None


def test_rolling_backtest_real_fit_on_a_clean_seasonal_series(bf):
    # One real (small) Prophet fit so a prophet/pandas version bump that breaks
    # the fitting path fails CI instead of the 03:17 UTC nightly. 60 months of
    # a clean multiplicative-seasonal series with mild growth: the model should
    # beat seasonal-naive-level error comfortably, and the fields the UI relies
    # on must all be present and coherent.
    monthly = {}
    for i in range(60):
        y, m = 2020 + i // 12, i % 12 + 1
        seasonal = 1.0 + 0.3 * (1 if m in (6, 7, 8) else -0.2 if m in (1, 2) else 0)
        monthly[f"{y}-{m:02d}"] = round(100000 * (1.004 ** i) * seasonal)
    df = bf.series_frame(monthly)
    bt = bf.rolling_backtest(df, pd.DataFrame(columns=["holiday", "ds"]), folds=1)
    assert bt is not None
    assert bt["mape"] is not None and bt["mape"] < 10
    assert len(bt["mape_folds"]) == 1
    assert bt["naive_mape"] is not None
    assert bt["coverage"] is None or 0 <= bt["coverage"] <= 100
    assert len(bt["backtest"]) == 12
    row = bt["backtest"][0]
    assert set(row) == {"date", "v", "lo", "hi", "actual"}
    assert row["lo"] <= row["v"] <= row["hi"]
