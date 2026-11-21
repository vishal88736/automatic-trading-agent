import datetime
import unittest

import pytz

from tradingagents.market_hours import get_next_market_datetime, is_market_open


class MarketHoursTests(unittest.TestCase):
    def test_naive_datetime_is_treated_as_eastern_wall_clock(self):
        is_open, reason = is_market_open(datetime.datetime(2025, 1, 6, 10, 0))
        self.assertTrue(is_open, reason)

    def test_aware_utc_datetime_is_converted_to_eastern(self):
        is_open, reason = is_market_open(datetime.datetime(2025, 1, 6, 15, 0, tzinfo=pytz.utc))
        self.assertTrue(is_open, reason)

    def test_2026_nyse_holiday_is_closed(self):
        eastern = pytz.timezone("US/Eastern")
        is_open, reason = is_market_open(eastern.localize(datetime.datetime(2026, 7, 3, 10, 0)))
        self.assertFalse(is_open)
        self.assertIn("holiday", reason.lower())

    def test_next_market_datetime_uses_eastern_schedule_from_aware_input(self):
        start = datetime.datetime(2025, 1, 6, 17, 30, tzinfo=pytz.utc)  # Monday 12:30 PM ET
        next_dt = get_next_market_datetime(11, start)
        self.assertEqual(next_dt.strftime("%Y-%m-%d %H:%M %Z"), "2025-01-07 11:00 EST")


if __name__ == "__main__":
    unittest.main()
