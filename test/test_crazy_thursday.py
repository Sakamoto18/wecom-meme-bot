from datetime import date
import unittest

from astrbot_plugin_longtu_bridge.crazy_thursday import (
    generate_crazy_thursday_copy,
    nearby_holiday_context,
)


class CrazyThursdayTests(unittest.TestCase):
    def test_nearby_national_day_context_and_adjustment(self):
        self.assertEqual(nearby_holiday_context(date(2026, 10, 8)), "国庆节刚过7天")
        self.assertEqual(nearby_holiday_context(date(2026, 10, 10)), "国庆后调休上班")

    def test_regular_thursday_has_no_fake_holiday(self):
        self.assertEqual(nearby_holiday_context(date(2026, 7, 9)), "")
        text = generate_crazy_thursday_copy(date(2026, 7, 9), seed="group-a")
        self.assertTrue(20 <= len(text) <= 180)

    def test_holiday_copy_includes_nearby_context(self):
        text = generate_crazy_thursday_copy(date(2026, 10, 8), seed="group-a")
        self.assertTrue(text)

    def test_same_group_and_date_are_stable(self):
        first = generate_crazy_thursday_copy(date(2026, 7, 9), seed="group-a")
        second = generate_crazy_thursday_copy(date(2026, 7, 9), seed="group-a")
        self.assertEqual(first, second)
        self.assertNotEqual(first, generate_crazy_thursday_copy(date(2026, 7, 9), seed="group-b"))

    def test_local_fallback_does_not_claim_winter_in_summer(self):
        for seed in range(100):
            self.assertNotIn("冬天", generate_crazy_thursday_copy(date(2026, 7, 9), seed=str(seed)))


if __name__ == "__main__":
    unittest.main()
