"""Transport boundary; importing this package does not require AstrBot."""
from .onebot import LegacyOneBotAdapter, OneBotAdapter, select_platform, transport_for
from .types import Capabilities, DeliveryError, DeliveryReceipt, Target

__all__ = [
    'Capabilities', 'DeliveryError', 'DeliveryReceipt', 'Target',
    'LegacyOneBotAdapter', 'OneBotAdapter', 'select_platform', 'transport_for',
]
