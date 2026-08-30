"""
indicators.py
حساب مؤشرات فنية حقيقية من بيانات OHLC فعلية (عبر yfinance) — تحل محل الثوابت المزيّفة
(cci=25.0, smcStructure="Bullish_BOS", fibHigh=price*1.25... إلخ) في fetch_data.py الأصلي.

تنبيه: تصنيف SMC هنا تقريب آلي مبسّط مبني على نقاط الانعكاس (swing points)، وليس بديلاً
عن قراءة يدوية لمناطق السيولة وOrder Blocks كما يفعلها متداول SMC محترف.
"""
import pandas as pd
import numpy as np


def compute_sma(close: pd.Series, period: int):
    if len(close) < period:
        return None
    return round(float(close.rolling(period).mean().iloc[-1]), 4)


def compute_atr(df: pd.DataFrame, period: int = 14):
    high, low, close = df['High'], df['Low'], df['Close']
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs()
    ], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1/period, adjust=False, min_periods=period).mean()  # تنعيم Wilder
    val = atr.iloc[-1]
    return round(float(val), 4) if pd.notna(val) else None


def compute_cci(df: pd.DataFrame, period: int = 20):
    tp = (df['High'] + df['Low'] + df['Close']) / 3
    sma_tp = tp.rolling(period).mean()
    mean_dev = tp.rolling(period).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    cci = (tp - sma_tp) / (0.015 * mean_dev)
    val = cci.iloc[-1]
    return round(float(val), 2) if pd.notna(val) else None


def compute_fib_levels(df: pd.DataFrame, lookback: int = 90):
    """يستخدم أعلى قمة وأدنى قاع فعليَّين خلال فترة الرصد كأساس فايبوناتشي، بدل نسبة ثابتة حول السعر الحالي."""
    recent = df.tail(lookback)
    return round(float(recent['High'].max()), 4), round(float(recent['Low'].min()), 4)


def _detect_swings(df: pd.DataFrame, window: int = 3):
    highs = df['High'].values
    lows = df['Low'].values
    n = len(df)
    swing_high = [False] * n
    swing_low = [False] * n
    for i in range(window, n - window):
        seg_h = highs[i - window: i + window + 1]
        seg_l = lows[i - window: i + window + 1]
        if highs[i] == seg_h.max():
            swing_high[i] = True
        if lows[i] == seg_l.min():
            swing_low[i] = True
    return swing_high, swing_low


def classify_smc_structure(df: pd.DataFrame, window: int = 3, lookback: int = 90):
    """تصنيف مبسّط: Bullish/Bearish BOS (استمرار الاتجاه) أو CHoCH (تغيّر الطابع) استناداً لتتابع
    القمم/القيعان الفعلية وكسر آخر قمة/قاع مؤكَّد."""
    recent = df.tail(lookback).reset_index(drop=True)
    if len(recent) < window * 2 + 4:
        return "Insufficient_Data"

    swing_high, swing_low = _detect_swings(recent, window)
    pivots = []
    for i in range(len(recent)):
        if swing_high[i]:
            pivots.append(('H', i, recent['High'].iloc[i]))
        if swing_low[i]:
            pivots.append(('L', i, recent['Low'].iloc[i]))
    pivots.sort(key=lambda p: p[1])

    sh = [p for p in pivots if p[0] == 'H']
    sl = [p for p in pivots if p[0] == 'L']
    if len(sh) < 2 or len(sl) < 2:
        return "Insufficient_Data"

    last_close = recent['Close'].iloc[-1]
    prev_sh, last_sh = sh[-2][2], sh[-1][2]
    prev_sl, last_sl = sl[-2][2], sl[-1][2]

    higher_highs = last_sh > prev_sh
    higher_lows = last_sl > prev_sl
    lower_highs = last_sh < prev_sh
    lower_lows = last_sl < prev_sl

    broke_above = last_close > last_sh
    broke_below = last_close < last_sl

    if higher_highs and higher_lows and broke_above:
        return "Bullish_BOS"
    if (lower_highs or lower_lows) and broke_above:
        return "Bullish_CHoCH"
    if lower_highs and lower_lows and broke_below:
        return "Bearish_BOS"
    if (higher_highs or higher_lows) and broke_below:
        return "Bearish_CHoCH"
    return "Neutral_Ranging"


def compute_atr_bands(df: pd.DataFrame, price: float, multiplier: float = 1.5, period: int = 14):
    atr = compute_atr(df, period)
    if atr is None:
        return None, None
    return round(price - atr * multiplier, 4), round(price + atr * multiplier, 4)


def bullish_engulfing(df: pd.DataFrame) -> bool:
    if len(df) < 2:
        return False
    prev, curr = df.iloc[-2], df.iloc[-1]
    prev_bearish = prev['Close'] < prev['Open']
    curr_bullish = curr['Close'] > curr['Open']
    engulfs = curr['Open'] <= prev['Close'] and curr['Close'] >= prev['Open']
    return bool(prev_bearish and curr_bullish and engulfs)


def bearish_engulfing(df: pd.DataFrame) -> bool:
    if len(df) < 2:
        return False
    prev, curr = df.iloc[-2], df.iloc[-1]
    prev_bullish = prev['Close'] > prev['Open']
    curr_bearish = curr['Close'] < curr['Open']
    engulfs = curr['Open'] >= prev['Close'] and curr['Close'] <= prev['Open']
    return bool(prev_bullish and curr_bearish and engulfs)


def hammer(df: pd.DataFrame) -> bool:
    if len(df) < 1:
        return False
    c = df.iloc[-1]
    body = abs(c['Close'] - c['Open'])
    total_range = c['High'] - c['Low']
    if total_range == 0:
        return False
    lower_shadow = min(c['Close'], c['Open']) - c['Low']
    upper_shadow = c['High'] - max(c['Close'], c['Open'])
    return bool(body > 0 and lower_shadow >= 2 * body and upper_shadow <= body * 0.5 and body / total_range < 0.35)


def shooting_star(df: pd.DataFrame) -> bool:
    if len(df) < 1:
        return False
    c = df.iloc[-1]
    body = abs(c['Close'] - c['Open'])
    total_range = c['High'] - c['Low']
    if total_range == 0:
        return False
    upper_shadow = c['High'] - max(c['Close'], c['Open'])
    lower_shadow = min(c['Close'], c['Open']) - c['Low']
    return bool(body > 0 and upper_shadow >= 2 * body and lower_shadow <= body * 0.5 and body / total_range < 0.35)


def bullish_candle_signal(df: pd.DataFrame) -> bool:
    """Engulfing صاعد أو Hammer على آخر شمعة يومية مكتملة."""
    return bullish_engulfing(df) or hammer(df)


def bearish_candle_signal(df: pd.DataFrame) -> bool:
    """Engulfing هابط أو Shooting Star على آخر شمعة يومية مكتملة."""
    return bearish_engulfing(df) or shooting_star(df)


def compute_all(df: pd.DataFrame):
    """يُستدعى مرة واحدة لكل سهم بعد جلب تاريخه عبر yfinance."""
    price = float(df['Close'].iloc[-1])
    fib_high, fib_low = compute_fib_levels(df)
    atr_lower, atr_upper = compute_atr_bands(df, price)
    return {
        "sma20": compute_sma(df['Close'], 20),
        "sma50": compute_sma(df['Close'], 50),
        "cci": compute_cci(df),
        "atrBandLower": atr_lower,
        "atrBandUpper": atr_upper,
        "smcStructure": classify_smc_structure(df),
        "fibHigh": fib_high,
        "fibLow": fib_low,
        "bullishCandle": bullish_candle_signal(df),
        "bearishCandle": bearish_candle_signal(df),
    }

