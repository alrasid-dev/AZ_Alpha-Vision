import os
os.environ['SUPABASE_URL'] = 'https://example.supabase.co'
os.environ['SUPABASE_SERVICE_ROLE_KEY'] = 'test'
import pandas as pd
import numpy as np
from fetch_market_data import _download_with_fallback

class FakeYF:
    def __init__(self):
        self.calls = []
    def download(self, chunk, **kwargs):
        tickers = list(chunk) if isinstance(chunk, (list, tuple)) else [chunk]
        self.calls.append(tickers)
        # Simulate a provider returning only the first symbol from a multi-symbol request.
        chosen = tickers[:1]
        idx = pd.date_range('2024-01-01', periods=220, freq='D')
        frames = {}
        for ticker in chosen:
            base = np.linspace(10, 20, len(idx))
            frames[ticker] = pd.DataFrame({
                'Open': base, 'High': base + 1, 'Low': base - 1,
                'Close': base, 'Adj Close': base, 'Volume': [1_000_000] * len(idx)
            }, index=idx)
        if len(chosen) == 1:
            return frames[chosen[0]]
        return pd.concat(frames, axis=1)

fake = FakeYF()
frames = _download_with_fallback(fake, ['AAA', 'BBB', 'CCC'], '2y')
found = [ticker for ticker, _ in frames]
assert found == ['AAA', 'BBB', 'CCC'], found
print({'found': found, 'calls': fake.calls})
