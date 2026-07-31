#!/usr/bin/env python3
# =============================================================================
# test_build_forecast.py — tests for build-forecast.py's pure-logic helpers
#
# Mostly covers the functions that don't require an actual Prophet fit
# (series_frame, seasonal12, covid_events, monthly_holidays,
# gdp_monthly_series, prune_stale, load_airport_series), since fitting Prophet
# per test would make this suite slow and non-deterministic-ish.
#
# Three tests DO fit for real, on small synthetic series: one through
# rolling_backtest and two through forecast_metric — the entry point the
# nightly actually calls. Those earn their runtime because the refresh
# workflow runs build-forecast.py continue-on-error, so a break there is
# silent: forecasts just quietly stop updating.
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


# ---- MASE + the two closed-form candidates -----------------------------------

def test_mase_of_scales_by_the_in_sample_seasonal_naive_error(bf):
    # MAE of 10 against a scale of 20 -> 0.5: the model made half the error a
    # seasonal naive made on its own training data.
    assert bf.mase_of([110, 90], [100, 100], 20.0) == pytest.approx(0.5)
    assert bf.mase_of([100], [100], 20.0) == pytest.approx(0.0)
    # no usable scale means no score, never a division by zero
    assert bf.mase_of([110], [100], 0.0) is None
    assert bf.mase_of([110], [100], None) is None
    assert bf.mase_of([], [], 20.0) is None


def test_mase_scores_a_zero_actual_that_mape_has_to_throw_away(bf):
    # THE reason MASE drives selection. A month that came in at zero is real
    # information (a closed airport, a month with no freighter rotations) — MAPE
    # cannot score it at all, MASE scores it like any other month.
    assert bf.mape_of([50], [0]) is None
    assert bf.mase_of([50], [0], 100.0) == pytest.approx(0.5)


def test_seasonal_naive_scale_uses_training_months_only(bf):
    # a series with a known constant year-over-year step scales by that step
    stepped = bf.series_frame({**{f"2023-{m:02d}": 100 for m in range(1, 13)},
                               **{f"2024-{m:02d}": 130 for m in range(1, 13)}})
    assert bf.seasonal_naive_scale(stepped) == pytest.approx(30.0)
    # nothing with a year-ago counterpart at all
    assert bf.seasonal_naive_scale(bf.series_frame({"2024-01": 100})) is None
    # a flat series HAS year-ago counterparts, they're just all identical -> 0.
    # That's the honest answer from this function; mase_of() is what refuses to
    # divide by it, and choose_model() ranks on MAE instead.
    flat = bf.series_frame({f"{y}-{m:02d}": 100 for y in (2023, 2024) for m in range(1, 13)})
    assert bf.seasonal_naive_scale(flat) == pytest.approx(0.0)
    assert bf.mase_of([110], [100], bf.seasonal_naive_scale(flat)) is None


def test_snaive_path_repeats_the_year_ago_month_and_widens_by_cycle(bf):
    train = bf.series_frame({f"2023-{m:02d}": 100 + m for m in range(1, 13)})
    target = [pd.Timestamp(2024, 1, 1), pd.Timestamp(2024, 6, 1)]
    path = bf.snaive_path(train, target)
    assert path[target[0]][0] == pytest.approx(101.0)   # Jan 2023
    assert path[target[1]][0] == pytest.approx(106.0)   # Jun 2023
    lo, hi = path[target[0]][1], path[target[0]][2]
    assert lo <= 101.0 <= hi


def test_snaive_path_repeats_the_last_cycle_past_twelve_months(bf):
    # beyond one year there is no "12 months ago" inside the training data, so
    # the last observed seasonal cycle has to repeat rather than the month
    # dropping out of the forecast entirely. Two training years, so the band's
    # sigma (the sd of the year-over-year steps) is actually defined.
    train = bf.series_frame({**{f"2022-{m:02d}": 50 + m for m in range(1, 13)},
                             **{f"2023-{m:02d}": 100 + m for m in range(1, 13)}})
    far = pd.Timestamp(2025, 3, 1)                       # 24 months past 2023-03
    path = bf.snaive_path(train, [far])
    assert path[far][0] == pytest.approx(103.0), "must take the MOST RECENT March, not the older one"
    # ...and its band is wider than the first cycle's, since it is two cycles out
    near = pd.Timestamp(2024, 3, 1)
    near_path = bf.snaive_path(train, [near])
    assert (path[far][2] - path[far][1]) > (near_path[near][2] - near_path[near][1])


def test_snaive_path_skips_a_month_with_no_anchor_at_all(bf):
    train = bf.series_frame({"2023-06": 100})
    assert bf.snaive_path(train, [pd.Timestamp(2024, 1, 1)]) == {}


def test_contiguous_tail_cuts_at_the_last_gap(bf):
    monthly = {f"2023-{m:02d}": 100 for m in range(1, 13)}
    monthly.update({f"2024-{m:02d}": 100 for m in range(4, 13)})   # 2024-01..03 missing
    tail = bf.contiguous_tail(bf.series_frame(monthly))
    assert len(tail) == 9
    assert tail["ds"].iloc[0] == pd.Timestamp(2024, 4, 1)


def test_ets_damping_flattens_a_trend_the_undamped_fit_compounds(bf):
    # the failure mode damping exists for: a series whose recent slope is steep.
    # Projected far out, phi < 1 must land BELOW the undamped projection.
    df = bf.series_frame({f"{2020 + i // 12}-{i % 12 + 1:02d}": 1000 + 50 * i for i in range(48)})
    undamped = bf.ets_fit(df, 0.3, 0.1, 0.1, 1.0)
    damped = bf.ets_fit(df, 0.3, 0.1, 0.1, 0.85)
    assert undamped and damped
    target = [df["ds"].max() + pd.DateOffset(months=24)]

    def project(fit):
        damp = 0.0
        for h in range(1, 25):
            damp += fit["phi"] ** h
        return fit["level"] + damp * fit["trend"]

    assert project(damped) < project(undamped)


def test_ets_fit_needs_two_seasons_and_indexes_by_real_calendar_month(bf):
    assert bf.ets_fit(bf.series_frame({f"2024-{m:02d}": 100 for m in range(1, 13)}),
                      0.3, 0.05, 0.1, 1.0) is None, "one season can't initialise the seasonal state"
    # a series STARTING IN JULY with a known December spike must put that spike
    # in the December slot, not in slot 5 (which a t % 12 index would do)
    monthly = {}
    for i in range(36):
        y, m = 2022 + (6 + i) // 12, (6 + i) % 12 + 1
        monthly[f"{y}-{m:02d}"] = 300 if m == 12 else 100
    fit = bf.ets_fit(bf.series_frame(monthly), 0.3, 0.05, 0.1, 1.0)
    assert fit["seas"].index(max(fit["seas"])) == 11, "December is slot 11"


def test_ets_keeps_a_collapsing_series_from_inverting_its_band(bf):
    """BMA: passengers collapse, the multiplicative level crosses zero, y/level
    flips sign and the September seasonal index fits at -9.4. That made the point
    forecast negative and inverted the band around it (v=0, lo=17217, hi=0 once
    each field was clamped independently). validate-data rejects lo > hi as a
    HARD GATE, so this one series would have failed the nightly and frozen
    last-good forecasts for all 446 airports."""
    # a steep collapse to near-zero with one erratic spike month — the shape that
    # drives the level negative under a multiplicative seasonal fit
    monthly = {}
    for i in range(60):
        y, m = 2021 + i // 12, i % 12 + 1
        base = max(5.0, 40000 * (0.90 ** i))
        monthly[f"{y}-{m:02d}"] = round(base * (14 if m == 9 else 1))
    df = bf.series_frame(monthly)
    fit = bf.ets_best_fit(bf.contiguous_tail(df))
    assert fit is not None
    assert all(v >= 0 for v in fit["seas"]), f"multiplicative seasonal indices must stay >= 0, got {fit['seas']}"
    assert fit["level"] >= 0, "the level of a multiplicative model must not go negative"

    target = [df["ds"].max() + pd.DateOffset(months=h) for h in range(1, 25)]
    for ds, (v, lo, hi) in bf.ets_path(df, target).items():
        assert 0 <= lo <= v <= hi, f"{ds}: inverted band v={v} lo={lo} hi={hi}"


def test_forecast_rows_restores_ordering_rather_than_freezing_the_nightly(bf):
    # Last-resort invariant. Whatever a band source does, a row must never ship
    # with lo > hi: validate-data is a hard gate, so one bad row keeps last-good
    # for the entire catalogue rather than just that series.
    ds = pd.Timestamp(2026, 9, 1)
    rows = bf.forecast_rows({ds: (0.0, 17217.0, 0.0)}, [ds])
    assert len(rows) == 1
    r = rows[0]
    assert 0 <= r["lo"] <= r["v"] <= r["hi"], f"ordering not restored: {r}"


def test_ets_path_produces_a_coherent_band_for_every_requested_month(bf):
    monthly = {}
    for i in range(48):
        y, m = 2021 + i // 12, i % 12 + 1
        monthly[f"{y}-{m:02d}"] = round(100000 * (1.003 ** i) * (1.3 if m in (7, 8) else 1.0))
    df = bf.series_frame(monthly)
    target = [df["ds"].max() + pd.DateOffset(months=h) for h in range(1, 13)]
    path = bf.ets_path(df, target)
    assert len(path) == 12
    for ds in target:
        v, lo, hi = path[ds]
        assert 0 <= lo <= v <= hi
    # the seasonal shape survives into the projection
    july = next(ds for ds in target if ds.month == 7)
    april = next(ds for ds in target if ds.month == 4)
    assert path[july][0] > path[april][0]


# ---- model selection ---------------------------------------------------------

def test_choose_model_takes_the_lowest_score_with_no_handicap(bf):
    # SELECT_MARGIN is 0: the best score wins outright, even by 3%. (Under the
    # old 5% margin this case went to the naive.)
    chosen, reason = bf.choose_model({"snaive": {"mase": 1.00}, "prophet": {"mase": 0.97}})
    assert chosen == "prophet"
    assert "simplicity margin" not in reason


def test_choose_model_gives_an_exact_tie_to_the_simpler_model(bf):
    # the one residual bias: candidates are walked simplest-first and the
    # comparison is strictly less-than, so an exact tie never unseats.
    chosen, _ = bf.choose_model({"snaive": {"mase": 0.50}, "ets": {"mase": 0.50}, "prophet": {"mase": 0.50}})
    assert chosen == "snaive"


def test_choose_model_switches_when_a_complex_candidate_clearly_wins(bf):
    chosen, _ = bf.choose_model({"snaive": {"mase": 1.00}, "prophet": {"mase": 0.50}})
    assert chosen == "prophet"


def test_choose_model_lets_a_marginal_win_take_over(bf):
    # with no margin, prophet's 0.49 beats ETS's 0.50 and takes it. Under the old
    # 5% handicap the middle candidate held.
    chosen, _ = bf.choose_model({"snaive": {"mase": 1.00}, "ets": {"mase": 0.50}, "prophet": {"mase": 0.49}})
    assert chosen == "prophet"


def test_choose_model_ignores_unscored_candidates_and_reports_when_none_scored(bf):
    chosen, _ = bf.choose_model({"snaive": {"mase": None}, "prophet": {"mase": 0.8}})
    assert chosen == "prophet"
    chosen, reason = bf.choose_model({"snaive": {"mase": None}, "prophet": {"mase": None}})
    assert chosen is None and "no candidate" in reason


def test_choose_model_falls_back_to_mae_when_the_mase_scale_degenerates(bf):
    # A series with no year-over-year movement gives MASE a zero denominator, so
    # no candidate can be scaled. Ranking must NOT fall through to a default:
    # that series is exactly the one the seasonal naive nails, so a default to
    # the most complex candidate would be backwards. Rank on raw MAE instead.
    chosen, reason = bf.choose_model({
        "snaive": {"mase": None, "mae": 0.0},
        "ets": {"mase": None, "mae": 0.0},
        "prophet": {"mase": None, "mae": 187.2},
    })
    assert chosen == "snaive"
    assert "MAE" in reason and "no year-over-year variation" in reason
    # MASE still wins when it's available for anyone at all
    chosen, reason = bf.choose_model({
        "snaive": {"mase": 1.0, "mae": 500.0},
        "prophet": {"mase": 0.4, "mae": 900.0},
    })
    assert chosen == "prophet" and "MASE" in reason


# ---- band calibration -------------------------------------------------------

def test_quantile_interpolates_and_handles_degenerate_inputs(bf):
    assert bf.quantile([1, 2, 3, 4, 5], 0.0) == pytest.approx(1.0)
    assert bf.quantile([1, 2, 3, 4, 5], 1.0) == pytest.approx(5.0)
    assert bf.quantile([1, 2, 3, 4, 5], 0.5) == pytest.approx(3.0)
    assert bf.quantile([0, 10], 0.8) == pytest.approx(8.0)     # interpolated
    assert bf.quantile([7], 0.8) == pytest.approx(7.0)
    assert bf.quantile([], 0.8) is None


def test_band_scale_widens_a_band_that_was_too_narrow(bf):
    # every held-out month landed ~2x outside its own band -> the band needs
    # roughly doubling to cover what it claims
    assert bf.band_scale_of([2.0] * 20) == pytest.approx(2.0)


def test_band_scale_tightens_a_band_that_was_too_wide(bf):
    # errors all well inside the band (a nominal 80% covering 100%) -> tighten
    scale = bf.band_scale_of([0.3] * 20)
    assert scale is not None and scale < 1.0


def test_band_scale_is_clamped_at_both_ends(bf):
    # a handful of held-out months can throw an extreme quantile; a 30x band is
    # less useful than an honestly-wrong one
    assert bf.band_scale_of([50.0] * 20) == pytest.approx(bf.BAND_SCALE_MAX)
    assert bf.band_scale_of([0.0001] * 20) == pytest.approx(bf.BAND_SCALE_MIN)
    assert bf.band_scale_of([]) is None
    assert bf.band_scale_of([0.0, 0.0]) is None, "a perfect fit gives no scale to apply"


def test_apply_band_scale_preserves_asymmetry_and_the_point_forecast(bf):
    # Prophet's posterior isn't symmetric around yhat and a naive band clamps at
    # zero, so scaling must stretch each side about v independently
    v, lo, hi = bf.apply_band_scale(100.0, 90.0, 130.0, 2.0)
    assert v == 100.0, "the point forecast must never move"
    assert lo == pytest.approx(80.0)    # 10 below -> 20 below
    assert hi == pytest.approx(160.0)   # 30 above -> 60 above
    assert bf.apply_band_scale(100.0, 90.0, 130.0, None) == (100.0, 90.0, 130.0)


def test_rolling_backtest_reports_a_calibration_that_actually_lands_near_nominal(bf):
    monthly = {}
    for i in range(60):
        y, m = 2020 + i // 12, i % 12 + 1
        seasonal = 1.0 + 0.3 * (1 if m in (6, 7, 8) else -0.2 if m in (1, 2) else 0)
        monthly[f"{y}-{m:02d}"] = round(100000 * (1.004 ** i) * seasonal)
    bt = bf.rolling_backtest(bf.series_frame(monthly), pd.DataFrame(columns=["holiday", "ds"]), folds=1)
    for name, c in bt.items():
        assert c["band_scale"] is None or c["band_scale"] > 0, f"{name}: a non-positive scale would invert the band"
        if c["coverage_cal"] is not None and c["band_scale"] not in (bf.BAND_SCALE_MIN, bf.BAND_SCALE_MAX):
            # unclamped, the calibrated band should sit near the nominal interval.
            # Expressed RELATIVE to INTERVAL so retargeting the band (0.80 -> 0.50)
            # doesn't silently invalidate the assertion.
            target = bf.INTERVAL * 100
            assert target - 20 <= c["coverage_cal"] <= 100, \
                f"{name}: calibrated coverage {c['coverage_cal']}% against a {target:.0f}% target"


def test_forecast_metric_calibrates_the_forward_band_but_not_the_backtest_rows(bf):
    # The forward band ships calibrated. The held-out rows deliberately keep
    # their RAW band: the factor was fitted on exactly those months, so widening
    # them would flatter the model on its own training data.
    monthly = {}
    for i in range(72):
        y, m = 2019 + i // 12, i % 12 + 1
        seasonal = 1.0 + 0.3 * (1 if m in (6, 7, 8) else -0.2 if m in (1, 2) else 0)
        monthly[f"{y}-{m:02d}"] = round(100000 * (1.004 ** i) * seasonal)
    res = bf.forecast_metric("ES", monthly, 24)
    assert res is not None
    assert "band_scale" in res and "coverage_cal" in res

    raw = bf.rolling_backtest(bf.series_frame(monthly), pd.DataFrame(columns=["holiday", "ds"]))
    scale = res["band_scale"]
    if scale and abs(scale - 1.0) > 0.05:
        chosen_raw = raw[res["chosen"]]["backtest"]
        assert res["backtest"] == chosen_raw, "held-out rows must keep the band the model actually claimed"
        # and the forward rows must reflect the scale
        widened = [r for r in res["forecast"] if r["hi"] > r["v"]]
        assert widened, "a scaled band still has to have width"
    for r in res["forecast"]:
        assert 0 <= r["lo"] <= r["v"] <= r["hi"], "calibration must not invert or negate a band"


def test_rolling_backtest_returns_none_when_history_is_too_short(bf):
    df = bf.series_frame({f"2024-{m:02d}": 100 for m in range(1, 13)})  # 12 months
    assert bf.rolling_backtest(df, pd.DataFrame(columns=["holiday", "ds"])) is None


def test_rolling_backtest_scores_every_candidate_on_the_same_fold(bf):
    # One real (small) Prophet fit so a prophet/pandas version bump that breaks
    # the fitting path fails CI instead of the 03:17 UTC nightly. 60 months of
    # a clean multiplicative-seasonal series with mild growth. Every candidate
    # must come back scored on the SAME held-out months — the comparison that
    # picks the published model is worthless otherwise.
    monthly = {}
    for i in range(60):
        y, m = 2020 + i // 12, i % 12 + 1
        seasonal = 1.0 + 0.3 * (1 if m in (6, 7, 8) else -0.2 if m in (1, 2) else 0)
        monthly[f"{y}-{m:02d}"] = round(100000 * (1.004 ** i) * seasonal)
    df = bf.series_frame(monthly)
    bt = bf.rolling_backtest(df, pd.DataFrame(columns=["holiday", "ds"]), folds=1)
    assert bt is not None
    assert set(bt) == set(bf.CANDIDATES), "all three candidates must be scored, not just Prophet"
    for name, c in bt.items():
        assert c["mase"] is not None, f"{name} produced no MASE"
        assert c["mape"] is not None and c["mape"] < 30, f"{name} MAPE implausible on a clean series"
        assert len(c["mase_folds"]) == 1 and len(c["mape_folds"]) == 1
        assert c["coverage"] is None or 0 <= c["coverage"] <= 100
        assert len(c["backtest"]) == 12, f"{name} must report its own held-out detail"
        row = c["backtest"][0]
        assert set(row) == {"date", "v", "lo", "hi", "actual"}
        assert row["lo"] <= row["v"] <= row["hi"]
    # identical folds: same held-out months, same actuals, for every candidate
    months = [[r["date"] for r in c["backtest"]] for c in bt.values()]
    actuals = [[r["actual"] for r in c["backtest"]] for c in bt.values()]
    assert all(m == months[0] for m in months), "candidates were scored on different months"
    assert all(a == actuals[0] for a in actuals)


def test_forecast_metric_produces_the_payload_the_browser_reads(bf):
    # forecast_metric() is what the nightly actually calls per airport per
    # metric, and the refresh workflow runs it continue-on-error — so a
    # signature or shape break there is SILENT (forecasts just quietly go
    # stale). One real end-to-end call, with holidays on, so it fails here
    # instead. Also the only coverage of top_holidays().
    monthly = {}
    for i in range(72):
        y, m = 2019 + i // 12, i % 12 + 1
        seasonal = 1.0 + 0.3 * (1 if m in (6, 7, 8) else -0.2 if m in (1, 2) else 0)
        monthly[f"{y}-{m:02d}"] = round(100000 * (1.004 ** i) * seasonal)

    res = bf.forecast_metric("ES", monthly, 24)
    assert res is not None

    # the fields data.jsx's forecastFor() destructures
    for k in ("chosen", "chosen_reason", "candidates", "mase", "mase_folds",
              "mape", "mape_folds", "naive_mape", "naive_mase", "skill", "coverage",
              "backtest", "months_history", "latest", "seasonal12", "holidays",
              "holidays_total", "gdpRegressor", "gdpForecast", "forecast"):
        assert k in res, f"missing {k} — data.jsx reads it"

    assert res["months_history"] == 72
    assert res["latest"] == "2024-12"
    assert len(res["seasonal12"]) == 12
    assert len(res["forecast"]) == 24
    # validate-data.mjs gates on exactly these invariants before committing
    for r in res["forecast"]:
        assert set(r) == {"date", "y", "m", "v", "lo", "hi"}
        assert r["lo"] <= r["v"] <= r["hi"]
        assert r["lo"] >= 0 and r["v"] >= 0
    assert res["forecast"][0]["date"] == "2025-01"
    assert res["forecast"][0]["m"] == 0, "month is 0-indexed for MONTHS[] on the client"

    # the candidate block behind the UI's model toggle
    assert res["chosen"] in bf.CANDIDATES
    assert res["chosen"] in res["candidates"]
    assert res["mase"] == res["candidates"][res["chosen"]]["mase"], "top level must mirror the winner"
    for name, c in res["candidates"].items():
        assert name in bf.CANDIDATES
        if name == res["chosen"]:
            # deliberately NOT duplicated — the winner's rows live at the top
            # level, and duplicating them triples the nightly commit
            assert "forecast" not in c
        else:
            assert len(c["forecast"]) == 24, f"{name} must ship a switchable forecast"
            for r in c["forecast"]:
                assert set(r) == {"date", "y", "m", "v", "lo", "hi"}
                assert 0 <= r["lo"] <= r["v"] <= r["hi"]
            assert c["forecast"][0]["date"] == "2025-01", "alternatives must cover the same months"


def test_forecast_metric_picks_the_naive_over_prophet_on_a_pure_repeat(bf):
    # A series that repeats EXACTLY year over year is the seasonal naive's home
    # turf — it is perfect by construction there. Prophet cannot beat perfect, so
    # selection must publish the naive. Guards the whole point of the exercise:
    # 68% of the real catalogue looks more like this than like a clean trend.
    monthly = {}
    for i in range(72):
        y, m = 2019 + i // 12, i % 12 + 1
        monthly[f"{y}-{m:02d}"] = 100000 + 5000 * m       # identical every year
    res = bf.forecast_metric("ES", monthly, 24)
    assert res is not None
    assert res["chosen"] == "snaive", f"expected the naive to win, got {res['chosen']}"
    # a perfectly periodic series leaves MASE with a zero denominator, so the
    # published MASE is honestly null and selection ran on MAE — the reason
    # string has to say that rather than implying a scaled score
    assert res["mase"] is None
    assert "MAE" in res["chosen_reason"]
    assert res["candidates"]["snaive"]["mae"] == pytest.approx(0.0, abs=1e-6)
    # and its forecast really is the repeated cycle
    assert res["forecast"][0]["v"] == 100000 + 5000 * 1   # Jan
    assert res["forecast"][6]["v"] == 100000 + 5000 * 7   # Jul

    # holidays: Spain has them, top_holidays ranks a subset of the names used
    assert res["holidays_total"] > 0
    assert len(res["holidays"]) <= 5
    assert set(res["holidays"]) <= set(bf.monthly_holidays("ES", range(2019, 2028))[1])
    # no GDP series was passed, so both disclosure flags must read false
    assert res["gdpRegressor"] is False and res["gdpForecast"] is False


def test_forecast_metric_skips_a_series_below_the_history_floor(bf):
    short = {f"2024-{m:02d}": 100 for m in range(1, 13)}   # 12 months < MIN_MONTHS
    assert bf.forecast_metric("ES", short, 24) is None


def test_forecast_metric_survives_gaps_inside_the_backtest_window(bf):
    # Feeds do skip months (LIN carries three such holes today). The backtest
    # holds out a count of OBSERVED rows while Prophet predicts CONTIGUOUS
    # months, so a gap in the held-out span used to push the tail of the
    # window past what was forecast and raise KeyError — which main() swallows
    # per metric, leaving that airport with no short-term forecast at all.
    monthly = {}
    for i in range(72):
        y, m = 2019 + i // 12, i % 12 + 1
        if (y, m) in {(2024, 5), (2024, 9), (2024, 11)}:   # holes inside fold 1
            continue
        seasonal = 1.0 + 0.3 * (1 if m in (6, 7, 8) else -0.2 if m in (1, 2) else 0)
        monthly[f"{y}-{m:02d}"] = round(100000 * (1.004 ** i) * seasonal)

    res = bf.forecast_metric("ES", monthly, 24)
    assert res is not None, "a gappy series must still produce a forecast"
    assert res["mape"] is not None, "and must still be backtested, not just fit"
    assert len(res["forecast"]) == 24
    # every held-out row reported must be one the model actually predicted
    for r in res["backtest"]:
        assert r["lo"] <= r["v"] <= r["hi"]
