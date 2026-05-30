import json
import subprocess
import threading
import time
import logging

logger = logging.getLogger(__name__)

# Media-class → human-readable German label + CSS color key
MEDIA_CLASS_INFO = {
    'Audio/Sink':           ('Ausgang',     'audio-sink'),
    'Audio/Source':         ('Eingang',     'audio-source'),
    'Audio/Duplex':         ('Duplex',      'audio-duplex'),
    'Stream/Output/Audio':  ('Wiedergabe',  'playback'),
    'Stream/Input/Audio':   ('Aufnahme',    'capture'),
    'Video/Source':         ('Video-Eingang','video'),
    'Video/Sink':           ('Video-Ausgang','video'),
}

def _run(cmd, timeout=3):
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def _parse_pw_dump():
    raw = _run(['pw-dump'])
    if not raw:
        return [], [], []
    try:
        objects = json.loads(raw)
    except json.JSONDecodeError:
        return [], [], []

    nodes, ports, links = [], [], []

    for obj in objects:
        otype = obj.get('type', '')
        oid = obj.get('id')
        info = obj.get('info', {})
        props = info.get('props', {})

        if otype == 'PipeWire:Interface:Node':
            media_class = props.get('media.class', '')
            name = props.get('node.name', f'node-{oid}')
            description = props.get('node.description', '') or props.get('node.nick', '') or name

            # Detect monitor sources by name convention
            label, color_key = MEDIA_CLASS_INFO.get(media_class, ('Unbekannt', 'unknown'))
            if 'monitor' in name.lower() and media_class == 'Audio/Source':
                label, color_key = 'Monitor', 'monitor'

            # Top-level category
            if media_class.startswith('Video'):
                category = 'Video'
            elif media_class.startswith('Audio') or 'Audio' in media_class:
                category = 'Audio'
            elif 'Stream' in media_class:
                category = 'Audio'
            else:
                category = ''

            # Volume extraction from params
            volume = None
            mute = False
            channel_volumes = []

            params = info.get('params', {})
            if isinstance(params, dict):
                props_param = params.get('Props', [])
                if props_param and isinstance(props_param, list):
                    p = props_param[0]
                    volume = p.get('volume')
                    mute = bool(p.get('mute', False))
                    channel_volumes = p.get('channelVolumes', [])
            elif isinstance(params, list):
                for param_item in params:
                    if isinstance(param_item, dict) and param_item.get('volume') is not None:
                        volume = param_item.get('volume')
                        mute = bool(param_item.get('mute', False))
                        channel_volumes = param_item.get('channelVolumes', [])
                        break

            nodes.append({
                'id': oid,
                'name': name,
                'description': description,
                'mediaClass': media_class,
                'label': label,
                'colorKey': color_key,
                'category': category,
                'state': info.get('state', ''),
                'volume': volume,
                'mute': mute,
                'channelVolumes': channel_volumes,
            })

        elif otype == 'PipeWire:Interface:Port':
            raw_dir = info.get('direction', props.get('port.direction', ''))
            # Normalise to short form used by the frontend
            direction = 'out' if raw_dir in ('out', 'output') else 'in'
            ports.append({
                'id': oid,
                'nodeId': int(props.get('node.id', -1)),
                'direction': direction,
                'name': props.get('port.name', f'port-{oid}'),
                'channel': props.get('audio.channel', ''),
            })

        elif otype == 'PipeWire:Interface:Link':
            state = info.get('state', '')
            links.append({
                'id': oid,
                'outputNodeId': info.get('output-node-id'),
                'outputPortId': info.get('output-port-id'),
                'inputNodeId': info.get('input-node-id'),
                'inputPortId': info.get('input-port-id'),
                'active': state == 'active',
            })

    return nodes, ports, links


def _get_pactl_volumes():
    """Returns {node_name: {volume, mute, channelVolumes}} from pactl."""
    result = {}
    for kind in ('sinks', 'sources'):
        raw = _run(['pactl', '--format=json', 'list', kind])
        if not raw:
            continue
        try:
            items = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(items, list):
            continue
        for item in items:
            name = item.get('name', '')
            if not name:
                continue
            vol_info = item.get('volume', {})
            # pactl volume values differ by version; normalise to 0.0–1.0
            channel_vols = []
            if isinstance(vol_info, dict):
                for ch_data in vol_info.values():
                    if isinstance(ch_data, dict):
                        # value_percent like "54%" or value like 0.54
                        vp = ch_data.get('value_percent', '')
                        if isinstance(vp, str) and vp.endswith('%'):
                            channel_vols.append(float(vp[:-1]) / 100.0)
                        elif 'value' in ch_data:
                            channel_vols.append(float(ch_data['value']) / 65536.0)
            avg_vol = (sum(channel_vols) / len(channel_vols)) if channel_vols else None
            result[name] = {
                'volume': avg_vol,
                'mute': bool(item.get('mute', False)),
                'channelVolumes': channel_vols,
            }
    return result


class PipewireAPI:
    def __init__(self):
        self._cache = json.dumps({'nodes': [], 'ports': [], 'links': []})
        self._running = False
        self._thread = None

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._refresh()
            except Exception as e:
                logger.warning('Refresh error: %s', e)
            time.sleep(1.0)

    def _refresh(self):
        nodes, ports, links = _parse_pw_dump()

        # Fill in missing volume data from pactl
        missing_vol = [n for n in nodes if n.get('volume') is None]
        if missing_vol:
            pactl = _get_pactl_volumes()
            for node in missing_vol:
                info = pactl.get(node['name'])
                if info:
                    node['volume'] = info['volume']
                    node['mute'] = info['mute']
                    node['channelVolumes'] = info['channelVolumes']

        self._cache = json.dumps({'nodes': nodes, 'ports': ports, 'links': links})

    # ── Public API exposed to JavaScript ──────────────────────────────────────

    def get_data(self):
        """Return the latest Pipewire data as a JSON string."""
        return self._cache
