"""Official group delivery policy, independent of private chats and OneBot."""


def group_enabled(config):
    # Existing deployments keep working until the operator explicitly opts out.
    return config.get('official_group_enabled', True) is not False


def event_enabled(config, event):
    return event.is_private_chat() or group_enabled(config)
