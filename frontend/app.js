/* ─────────────────────────────────────────────────────────────────────────
   Pipewire Viewer — app.js
   All UI logic: canvas, nodes, ports, cables, drag/resize, localStorage.
   ───────────────────────────────────────────────────────────────────────── */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────
const HEADER_H   = 40;  // px – must match CSS --header-h
const BODY_PAD   = 8;   // px top padding inside body
const PORT_ROW_H = 28;  // px – must match CSS --port-row-h
const PORT_DOT_R = 5;   // radius of port circle (half of --port-dot)
const GRID_COL   = 320;
const GRID_ROW   = 400;
const CABLE_CTRL = 130; // bezier control point horizontal offset
const LS = window.localStorage;

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  data: { nodes: [], ports: [], links: [] },
  ui: {
    positions: {},   // nodeKey → {x, y}
    widths:    {},   // nodeKey → number
    names:     {},   // nodeKey → string
    collapsed: {},   // nodeKey → bool
  },
  canvas: { panX: 0, panY: 0, zoom: 1 },
  portPositions: {}, // portId → {x, y}  (canvas-space)
  portOwner: {},     // portId → nodeKey
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const viewport   = document.getElementById('viewport');
const canvas     = document.getElementById('canvas');
const svgCables  = document.getElementById('svg-cables');
const nodesLayer = document.getElementById('nodes-layer');
const infoPopup  = document.getElementById('info-popup');
const toast      = document.getElementById('toast');
let toastTimer   = null;

// ── Type color map (mirrors CSS variables) ───────────────────────────────────
const TYPE_COLORS = {
  'audio-sink':   '#3b82f6',
  'audio-source': '#14b8a6',
  'monitor':      '#6b7280',
  'audio-duplex': '#06b6d4',
  'playback':     '#6366f1',
  'capture':      '#a855f7',
  'video':        '#22c55e',
  'unknown':      '#64748b',
};

// ── LocalStorage helpers ──────────────────────────────────────────────────────
function lsGet(key, def) {
  try { const v = LS.getItem('pwv_' + key); return v === null ? def : JSON.parse(v); }
  catch { return def; }
}
function lsSet(key, val) {
  try { LS.setItem('pwv_' + key, JSON.stringify(val)); } catch {}
}

function loadUI() {
  state.ui.positions = lsGet('positions', {});
  state.ui.widths    = lsGet('widths',    {});
  state.ui.names     = lsGet('names',     {});
  state.ui.collapsed = lsGet('collapsed', {});
  const c = lsGet('canvas', { panX: 0, panY: 0, zoom: 1 });
  state.canvas = c;
  applyCanvasTransform();
}
function savePositions() { lsSet('positions', state.ui.positions); }
function saveWidths()    { lsSet('widths',    state.ui.widths); }
function saveNames()     { lsSet('names',     state.ui.names); }
function saveCollapsed() { lsSet('collapsed', state.ui.collapsed); }
function saveCanvas()    { lsSet('canvas',    state.canvas); }

// ── Canvas transform ─────────────────────────────────────────────────────────
function applyCanvasTransform() {
  const { panX, panY, zoom } = state.canvas;
  canvas.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
}

// ── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden', 'fade-out');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.classList.add('hidden'), 400);
  }, 1800);
}

// ── Auto-placement for new nodes ──────────────────────────────────────────────
function autoPlace(nodeKey) {
  const occupied = new Set(Object.values(state.ui.positions).map(p => `${p.x},${p.y}`));
  let col = 0, row = 0;
  while (true) {
    const x = 40 + col * GRID_COL;
    const y = 40 + row * GRID_ROW;
    if (!occupied.has(`${x},${y}`)) {
      state.ui.positions[nodeKey] = { x, y };
      savePositions();
      return { x, y };
    }
    col++;
    if (col > 8) { col = 0; row++; }
  }
}

// ── Node key (stable across PW restarts) ─────────────────────────────────────
function nodeKey(node) { return node.name; }

// ── Render helpers ────────────────────────────────────────────────────────────

function getNodeWidth(key) {
  return state.ui.widths[key] || 300;
}

function getNodePos(key) {
  return state.ui.positions[key] || autoPlace(key);
}

function getNodeColor(colorKey) {
  return TYPE_COLORS[colorKey] || TYPE_COLORS['unknown'];
}

// ── Build / update node DOM elements ─────────────────────────────────────────
const nodeEls = {};  // nodeKey → element

function getOrCreateNode(node) {
  const key = nodeKey(node);
  if (nodeEls[key]) return nodeEls[key];

  const el = document.createElement('div');
  el.className = 'node-card';
  el.dataset.key   = key;
  el.dataset.color = node.colorKey || 'unknown';
  el.dataset.id    = node.id;

  // ── Header ──────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'node-header';

  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'node-collapse-btn';
  collapseBtn.title = 'Minimieren / Maximieren';

  const nameWrap = document.createElement('div');
  nameWrap.className = 'node-name-wrap';

  const nameDisplay = document.createElement('span');
  nameDisplay.className = 'node-name-display';
  nameDisplay.title = 'Doppelklick zum Umbenennen';

  const nameInput = document.createElement('input');
  nameInput.className = 'node-name-input';
  nameInput.type = 'text';
  nameInput.spellcheck = false;

  nameWrap.append(nameDisplay, nameInput);

  const catBadge = document.createElement('span');
  catBadge.className = 'node-cat-badge';

  const typeBadge = document.createElement('span');
  typeBadge.className = 'node-type-badge';

  const stateDot = document.createElement('span');
  stateDot.className = 'node-state-dot';

  const infoBtn = document.createElement('button');
  infoBtn.className = 'node-info-btn';
  infoBtn.textContent = 'ℹ';
  infoBtn.title = 'Original-Info anzeigen';

  header.append(collapseBtn, nameWrap, catBadge, typeBadge, stateDot, infoBtn);

  // ── Body ────────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'node-body';

  const portsRow = document.createElement('div');
  portsRow.className = 'node-ports-row';
  const portsLeft  = document.createElement('div');
  portsLeft.className  = 'node-ports-col left';
  const portsRight = document.createElement('div');
  portsRight.className = 'node-ports-col right';
  portsRow.append(portsLeft, portsRight);

  const volSection = document.createElement('div');
  volSection.className = 'node-volume-section';

  body.append(portsRow, volSection);

  // ── Resize handle ────────────────────────────────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'node-resize-handle';

  el.append(header, body, resizeHandle);
  nodesLayer.appendChild(el);
  nodeEls[key] = el;

  // ── Wire up interactions ─────────────────────────────────────────────────
  wireDrag(el, header, key);
  wireResize(el, resizeHandle, key);
  wireCollapse(el, collapseBtn, key);
  wireNameEdit(el, nameDisplay, nameInput, key, node);
  wireInfoBtn(infoBtn, node);

  return el;
}

function updateNodeEl(el, node) {
  const key = nodeKey(node);
  const collapsed = !!state.ui.collapsed[key];
  el.classList.toggle('collapsed', collapsed);
  el.dataset.color = node.colorKey || 'unknown';

  // Position & size
  const pos = getNodePos(key);
  const w   = getNodeWidth(key);
  el.style.left  = pos.x + 'px';
  el.style.top   = pos.y + 'px';
  el.style.width = w + 'px';

  const header = el.querySelector('.node-header');

  // Collapse button
  const collapseBtn = el.querySelector('.node-collapse-btn');
  collapseBtn.textContent = collapsed ? '▸' : '▾';

  // Name
  const nameDisplay = el.querySelector('.node-name-display');
  const nameInput   = el.querySelector('.node-name-input');
  const displayName = state.ui.names[key] || node.description || node.name;
  if (!nameInput.classList.contains('visible')) {
    nameDisplay.textContent = displayName;
    nameDisplay.title = 'Doppelklick zum Umbenennen';
  }

  // Category badge
  const catBadge = el.querySelector('.node-cat-badge');
  if (node.category) {
    catBadge.textContent = node.category;
    catBadge.className = 'node-cat-badge ' + node.category.toLowerCase();
  } else {
    catBadge.textContent = '';
    catBadge.className = 'node-cat-badge';
  }

  // Type badge
  const typeBadge = el.querySelector('.node-type-badge');
  typeBadge.textContent = node.label || node.mediaClass || '';

  // State dot
  const stateDot = el.querySelector('.node-state-dot');
  stateDot.className = 'node-state-dot ' + (
    node.state === 'running' ? 'running' :
    node.state === 'idle'    ? 'idle' :
    node.state === 'error'   ? 'error' : 'other'
  );

  // Ports
  updatePorts(el, node);

  // Volume
  updateVolume(el, node);
}

function updatePorts(el, node) {
  const portsLeft  = el.querySelector('.node-ports-col.left');
  const portsRight = el.querySelector('.node-ports-col.right');
  portsLeft.innerHTML  = '';
  portsRight.innerHTML = '';

  const ports = state.data.ports.filter(p => p.nodeId === node.id);
  const inputs  = ports.filter(p => p.direction === 'in');
  const outputs = ports.filter(p => p.direction === 'out');

  inputs.forEach((p, i) => {
    const row = buildPortRow(p, 'left', i, node);
    portsLeft.appendChild(row);
  });
  outputs.forEach((p, i) => {
    const row = buildPortRow(p, 'right', i, node);
    portsRight.appendChild(row);
  });
}

function buildPortRow(port, side, idx, node) {
  const row = document.createElement('div');
  row.className = 'port-row';
  row.dataset.portId = port.id;

  const dot = document.createElement('span');
  dot.className = 'port-dot';

  const label = document.createElement('span');
  label.className = 'port-label';
  label.textContent = port.channel || port.name;

  if (side === 'left') row.append(dot, label);
  else                 row.append(label, dot);

  return row;
}

function updateVolume(el, node) {
  const volSection = el.querySelector('.node-volume-section');
  volSection.innerHTML = '';

  const volumes = [];
  if (node.channelVolumes && node.channelVolumes.length > 0) {
    node.channelVolumes.forEach((v, i) => volumes.push({ label: i === 0 ? 'L' : i === 1 ? 'R' : `Ch${i+1}`, v }));
  } else if (node.volume !== null && node.volume !== undefined) {
    volumes.push({ label: '', v: node.volume });
  }

  if (volumes.length === 0) return;

  volumes.forEach(({ label: chLabel, v }) => {
    const pct = Math.min(Math.round(v * 100), 200);
    const displayPct = Math.round(v * 100);
    const row = document.createElement('div');
    row.className = 'volume-row';

    const wrap = document.createElement('div');
    wrap.className = 'volume-bar-wrap';
    const fill = document.createElement('div');
    fill.className = 'volume-fill';
    fill.style.width = Math.min(pct, 100) + '%';
    wrap.appendChild(fill);

    const lbl = document.createElement('span');
    lbl.className = 'volume-label';
    lbl.textContent = (chLabel ? chLabel + ' ' : '') + displayPct + '%';

    const muteLbl = document.createElement('span');
    muteLbl.className = 'mute-indicator';
    if (node.mute) {
      muteLbl.textContent = '🔇';
      muteLbl.title = 'Stummgeschaltet';
      fill.style.opacity = '0.25';
    }

    row.append(wrap, lbl, muteLbl);
    volSection.appendChild(row);
  });
}

// ── Port positions (canvas-space) ─────────────────────────────────────────────
function computePortPositions() {
  state.portPositions = {};
  state.portOwner = {};

  for (const node of state.data.nodes) {
    const key = nodeKey(node);
    const pos = getNodePos(key);
    const w   = getNodeWidth(key);
    const ports = state.data.ports.filter(p => p.nodeId === node.id);
    const inputs  = ports.filter(p => p.direction === 'in');
    const outputs = ports.filter(p => p.direction === 'out');
    const collapsed = !!state.ui.collapsed[key];

    if (collapsed) {
      // All ports collapse to header center
      const cy = pos.y + HEADER_H / 2;
      inputs.forEach(p => {
        state.portPositions[p.id] = { x: pos.x, y: cy };
        state.portOwner[p.id] = key;
      });
      outputs.forEach(p => {
        state.portPositions[p.id] = { x: pos.x + w, y: cy };
        state.portOwner[p.id] = key;
      });
    } else {
      // Ports are inside body, starting after header + body-pad
      const baseY = pos.y + HEADER_H + BODY_PAD;
      const maxPorts = Math.max(inputs.length, outputs.length);

      inputs.forEach((p, i) => {
        const y = baseY + i * PORT_ROW_H + PORT_ROW_H / 2;
        state.portPositions[p.id] = { x: pos.x, y };
        state.portOwner[p.id] = key;
      });
      outputs.forEach((p, i) => {
        const y = baseY + i * PORT_ROW_H + PORT_ROW_H / 2;
        state.portPositions[p.id] = { x: pos.x + w, y };
        state.portOwner[p.id] = key;
      });
    }
  }
}

// ── Cable rendering ───────────────────────────────────────────────────────────

// Find the color for a node by its ID
function nodeColorById(nodeId) {
  const node = state.data.nodes.find(n => n.id === nodeId);
  return node ? (TYPE_COLORS[node.colorKey] || TYPE_COLORS['unknown']) : TYPE_COLORS['unknown'];
}

// Group links that share the same output-node → input-node into potential stereo pairs
function groupLinksIntoConnections() {
  // Build: nodeId pair → list of links sorted by portId
  const groups = {};
  for (const link of state.data.links) {
    const gk = `${link.outputNodeId}-${link.inputNodeId}`;
    if (!groups[gk]) groups[gk] = [];
    groups[gk].push(link);
  }
  return groups;
}

function drawCables() {
  // Clear SVG
  while (svgCables.firstChild) svgCables.removeChild(svgCables.firstChild);

  const groups = groupLinksIntoConnections();

  for (const [, links] of Object.entries(groups)) {
    const n = links.length;

    links.forEach((link, idx) => {
      const op = state.portPositions[link.outputPortId];
      const ip = state.portPositions[link.inputPortId];
      if (!op || !ip) return;

      const color = nodeColorById(link.outputNodeId);

      // For stereo pairs (n===2) shift curves slightly so they don't overlap
      const shift = n === 2 ? (idx === 0 ? -3 : 3) : 0;

      const ox = op.x, oy = op.y + shift;
      const ix = ip.x, iy = ip.y + shift;
      const cx1 = ox + CABLE_CTRL, cy1 = oy;
      const cx2 = ix - CABLE_CTRL, cy2 = iy;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${ox},${oy} C${cx1},${cy1} ${cx2},${cy2} ${ix},${iy}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', n === 2 ? '2' : '2.5');
      path.setAttribute('stroke-opacity', link.active ? '0.7' : '0.25');
      if (!link.active) path.setAttribute('stroke-dasharray', '5,4');

      svgCables.appendChild(path);
    });
  }
}

// ── Full render cycle ─────────────────────────────────────────────────────────
function render() {
  const currentKeys = new Set(state.data.nodes.map(n => nodeKey(n)));

  // Remove stale nodes
  for (const key of Object.keys(nodeEls)) {
    if (!currentKeys.has(key)) {
      nodeEls[key].remove();
      delete nodeEls[key];
    }
  }

  // Create / update nodes
  for (const node of state.data.nodes) {
    const el = getOrCreateNode(node);
    updateNodeEl(el, node);
  }

  computePortPositions();
  drawCables();
}

// ── Drag ──────────────────────────────────────────────────────────────────────
let dragging = null; // { key, startMouseX, startMouseY, startPosX, startPosY }

function wireDrag(el, header, key) {
  header.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('button,input')) return;
    e.preventDefault();
    const pos = getNodePos(key);
    dragging = {
      key,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: pos.x,
      startPosY: pos.y,
    };
    el.style.zIndex = 100;
  });
}

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const { zoom } = state.canvas;
  const dx = (e.clientX - dragging.startMouseX) / zoom;
  const dy = (e.clientY - dragging.startMouseY) / zoom;
  const x = dragging.startPosX + dx;
  const y = dragging.startPosY + dy;
  state.ui.positions[dragging.key] = { x, y };

  const el = nodeEls[dragging.key];
  if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }

  computePortPositions();
  drawCables();
});

document.addEventListener('mouseup', e => {
  if (!dragging) return;
  const el = nodeEls[dragging.key];
  if (el) el.style.zIndex = '';
  savePositions();
  dragging = null;
});

// ── Resize ────────────────────────────────────────────────────────────────────
let resizing = null; // { key, startMouseX, startW }

function wireResize(el, handle, key) {
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizing = { key, startMouseX: e.clientX, startW: getNodeWidth(key) };
  });
}

document.addEventListener('mousemove', e => {
  if (!resizing) return;
  const { zoom } = state.canvas;
  const dx = (e.clientX - resizing.startMouseX) / zoom;
  const newW = Math.max(200, Math.min(800, resizing.startW + dx));
  state.ui.widths[resizing.key] = newW;
  const el = nodeEls[resizing.key];
  if (el) el.style.width = newW + 'px';
  computePortPositions();
  drawCables();
}, { passive: true });

document.addEventListener('mouseup', () => {
  if (!resizing) return;
  saveWidths();
  resizing = null;
});

// ── Collapse ──────────────────────────────────────────────────────────────────
function wireCollapse(el, btn, key) {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    state.ui.collapsed[key] = !state.ui.collapsed[key];
    el.classList.toggle('collapsed', state.ui.collapsed[key]);
    btn.textContent = state.ui.collapsed[key] ? '▸' : '▾';
    saveCollapsed();
    computePortPositions();
    drawCables();
  });
}

// ── Name edit ─────────────────────────────────────────────────────────────────
function wireNameEdit(el, display, input, key, node) {
  display.addEventListener('dblclick', e => {
    e.stopPropagation();
    input.value = state.ui.names[key] || node.description || node.name;
    display.style.display = 'none';
    input.classList.add('visible');
    input.focus();
    input.select();
  });

  function commitEdit() {
    const val = input.value.trim();
    if (val) {
      state.ui.names[key] = val;
      saveNames();
    }
    display.textContent = state.ui.names[key] || node.description || node.name;
    display.style.display = '';
    input.classList.remove('visible');
  }

  input.addEventListener('blur', commitEdit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      input.value = '';
      display.style.display = '';
      input.classList.remove('visible');
    }
  });
}

// ── Info popup ────────────────────────────────────────────────────────────────
let popupNode = null;

function wireInfoBtn(btn, node) {
  // Keep node data reference current on each click
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const rect = btn.getBoundingClientRect();

    // Update with latest node data
    const latest = state.data.nodes.find(n => n.name === node.name) || node;
    document.getElementById('info-popup-name').textContent = latest.name;
    document.getElementById('info-popup-desc').textContent = latest.description;
    document.getElementById('info-popup-class').textContent = latest.mediaClass;

    // Position popup near button
    infoPopup.classList.remove('hidden');
    const popW = infoPopup.offsetWidth;
    const popH = infoPopup.offsetHeight;
    let left = rect.right + 8;
    let top  = rect.top;
    if (left + popW > window.innerWidth) left = rect.left - popW - 8;
    if (top + popH > window.innerHeight) top = window.innerHeight - popH - 8;
    infoPopup.style.left = Math.max(4, left) + 'px';
    infoPopup.style.top  = Math.max(4, top)  + 'px';

    popupNode = latest;
    e.stopPropagation();
  });
}

document.getElementById('info-popup-copy-name').addEventListener('click', () => {
  const txt = document.getElementById('info-popup-name').textContent;
  navigator.clipboard.writeText(txt).then(() => showToast('Name kopiert'));
});
document.getElementById('info-popup-copy-desc').addEventListener('click', () => {
  const txt = document.getElementById('info-popup-desc').textContent;
  navigator.clipboard.writeText(txt).then(() => showToast('Beschreibung kopiert'));
});

document.addEventListener('click', e => {
  if (!infoPopup.contains(e.target)) infoPopup.classList.add('hidden');
});

// ── Canvas: middle-mouse pan ──────────────────────────────────────────────────
let panning = null; // { startMouseX, startMouseY, startPanX, startPanY }

viewport.addEventListener('mousedown', e => {
  if (e.button !== 1) return;
  e.preventDefault();
  panning = {
    startMouseX: e.clientX,
    startMouseY: e.clientY,
    startPanX: state.canvas.panX,
    startPanY: state.canvas.panY,
  };
  viewport.classList.add('panning');
});

document.addEventListener('mousemove', e => {
  if (!panning) return;
  const dx = e.clientX - panning.startMouseX;
  const dy = e.clientY - panning.startMouseY;
  state.canvas.panX = panning.startPanX + dx;
  state.canvas.panY = panning.startPanY + dy;
  applyCanvasTransform();
});

document.addEventListener('mouseup', e => {
  if (e.button !== 1 || !panning) return;
  viewport.classList.remove('panning');
  saveCanvas();
  panning = null;
});

// ── Canvas: ctrl+wheel zoom ───────────────────────────────────────────────────
viewport.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();

  const { zoom, panX, panY } = state.canvas;
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.max(0.2, Math.min(3, zoom * factor));

  // Zoom towards mouse cursor
  const rect = viewport.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  state.canvas.panX = mx - (mx - panX) * (newZoom / zoom);
  state.canvas.panY = my - (my - panY) * (newZoom / zoom);
  state.canvas.zoom = newZoom;

  applyCanvasTransform();
  saveCanvas();
}, { passive: false });

// ── Data polling ──────────────────────────────────────────────────────────────
let pollTimer = null;

function poll() {
  if (typeof pywebview === 'undefined' || !pywebview.api) {
    pollTimer = setTimeout(poll, 200);
    return;
  }
  pywebview.api.get_data()
    .then(raw => {
      try {
        state.data = JSON.parse(raw);
      } catch {}
      render();
    })
    .catch(err => console.warn('get_data error:', err))
    .finally(() => {
      pollTimer = setTimeout(poll, 1000);
    });
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('pywebviewready', () => {
  loadUI();
  poll();
});

// Fallback if pywebviewready already fired (e.g. page reload)
if (typeof pywebview !== 'undefined' && pywebview.api) {
  loadUI();
  poll();
}
