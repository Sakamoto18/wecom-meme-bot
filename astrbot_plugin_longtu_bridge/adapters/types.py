"""Platform-independent routing and delivery outcomes.

IDs are opaque strings. Only an implementation may turn them into numbers.
An unknown outcome must never be retried as if it were an explicit rejection.
This contract covers validated direct sends, not the legacy backend queue or
AstrBot RespondStage (whose existing delivery contracts remain unchanged).
"""
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Target:
    kind: Literal['group', 'private']
    id: str

    def __post_init__(self):
        if self.kind not in ('group', 'private') or not str(self.id).strip():
            raise ValueError('Invalid message target')
        object.__setattr__(self, 'id', str(self.id))

    @classmethod
    def from_event(cls, event):
        private = event.is_private_chat()
        return cls('private' if private else 'group',
                   event.get_sender_id() if private else event.get_group_id())


@dataclass(frozen=True)
class Capabilities:
    history: bool = True
    quotes: bool = True
    receive_forwards: bool = True
    send_forwards: bool = True
    reactions: bool = True
    native_forward: bool = True
    proactive: bool = True


@dataclass(frozen=True)
class DeliveryReceipt:
    outcome: Literal['success', 'rejected', 'unknown']
    message_id: str = ''
    reused_message_id: str = ''
    code: str = ''


class DeliveryError(RuntimeError):
    def __init__(self, operation, outcome, code=''):
        self.operation = operation
        self.outcome = outcome
        self.code = str(code)
        # Do not include upstream wording, URLs, message text or credentials.
        super().__init__(f'{operation}: {outcome}' + (f' ({self.code})' if self.code else ''))


def delivery_receipt(result, *, native_source=None, null_native_success=False):
    if isinstance(result, dict):
        if result.get('status') == 'failed' or result.get('retcode', 0) not in (0, None):
            return DeliveryReceipt('rejected', code=str(result.get('retcode', '')))
        body = result.get('data') if isinstance(result.get('data'), dict) else result
        if body.get('message_id') is not None:
            return DeliveryReceipt('success', str(body['message_id']))
    if native_source is not None and null_native_success and (
        result is None or isinstance(result, dict) and result.get('data', result) is None
    ):
        return DeliveryReceipt('success', reused_message_id=str(native_source))
    return DeliveryReceipt('unknown')
