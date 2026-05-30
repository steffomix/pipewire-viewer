# pipewire-viewer

A desktop GUI for visualizing PipeWire audio/video graphs. Shows nodes, ports, and connections as interactive cards with live data refreshed every second from `pw-dump`.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

---

## Features

- Live node graph from PipeWire (refreshed every second)
- Draggable, resizable, and collapsible node cards
- SVG bezier cables connecting ports (stereo-aware, drawn behind nodes)
- Outputs on the right, inputs on the left
- Volume bars with per-channel levels and mute state
- Custom node names (double-click to rename, original name accessible via popup)
- Middle-mouse pan, scroll-wheel zoom
- German type labels with color coding per audio/video category
- Persistent layout saved to `~/.config/pipewire-viewer/state.json`

---

## Requirements

### System

- Linux with [PipeWire](https://pipewire.org/) running (`pw-dump` must be in `PATH`)
- Python 3.10+
- GTK 3 + WebKit2GTK (required by pywebview on Linux)

Install WebKit2GTK on Debian/Ubuntu:

```bash
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.0
```

On Arch/Manjaro:

```bash
sudo pacman -S python-gobject webkit2gtk
```

### Python

```bash
pip install -r requirements.txt
```

> On system-managed Python installs (Ubuntu 23.04+) you may need:
> ```bash
> pip install --break-system-packages -r requirements.txt
> ```

---

## Installation

```bash
git clone https://github.com/youruser/pipewire-viewer.git
cd pipewire-viewer
pip install -r requirements.txt
```

---

## Usage

```bash
python main.py
```

### Controls

| Action | Input |
|---|---|
| Drag node | Click and drag anywhere on the card |
| Resize node | Drag the right edge of a card |
| Collapse/expand node | Click the arrow button in the header |
| Rename node | Double-click the node name |
| Show original name / media class | Click the info button (ⓘ) in the header |
| Copy text to clipboard | Click the copy icon in the info popup |
| Pan canvas | Middle-mouse button drag |
| Zoom canvas | Scroll wheel |

---

## Project Structure

```
pipewire-viewer/
├── main.py              # Entry point, creates the pywebview window
├── pipewire_api.py      # Background thread polling pw-dump; Python API exposed to JS
├── requirements.txt     # Python dependencies
└── frontend/
    ├── index.html       # HTML shell
    ├── style.css        # Dark theme, node card layout, type colors
    └── app.js           # All UI logic (drag, zoom, cables, persistence)
```

---

## Persistent State

Layout positions, custom names, collapsed states, and canvas pan/zoom are saved automatically to:

```
~/.config/pipewire-viewer/state.json
```

To reset to defaults, delete that file.

---

## Type Labels & Colors

| Label | Media Class | Color |
|---|---|---|
| Wiedergabe | Audio/Sink | Blue |
| Aufnahme | Audio/Source | Teal |
| Monitor | Audio/Source (monitor) | Gray |
| Duplex | Audio/Duplex | Cyan |
| Stream (Wiedergabe) | Stream/Output/Audio | Indigo |
| Stream (Aufnahme) | Stream/Input/Audio | Purple |
| Video | Video/* | Green |

---

## License

MIT — see [LICENSE](LICENSE)
