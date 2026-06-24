import React, { useState, useEffect, useCallback } from 'react';
import { toPng, toJpeg, toSvg } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { CATEGORY_CONFIG, resolveRenderType } from './deviceRenderConfig';
import {
  isPowerDevice, isPassiveItem, isUps, getPowerLabel, flattenOutlets, verticalPdusForUps, listPowerSources,
  getPowerSourceLabel,
} from '../../utils/power';
import { layoutVerticalPdus, computeChannelBoxes, cordPathD, DEFAULT_U_HEIGHT, STRIP_WIDTH, CHANNEL_PADDING } from './verticalPduLayout';
import './ExportModal.css';

const EXPORT_SCALE = Math.max(window.devicePixelRatio || 1, 3);
const PREVIEW_SCALE = 1;
const PDF_DPI = 150;
const PREVIEW_DEBOUNCE = 150;

// Human-readable names for each device render type key
const TYPE_LABELS = {
  switch:                'Switch',
  firewall:              'Firewall / Router',
  server:                'Server',
  'blade-chassis':       'Blade Chassis',
  storage:               'Storage / NAS',
  'tape-library':        'Tape Library',
  'san-switch':          'SAN Switch',
  ups:                   'UPS',
  pdu:                   'PDU',
  'pdu-vertical':        'PDU (Vertical)',
  ats:                   'ATS',
  transformer:           'Stepdown Transformer',
  ebm:                   'Battery Module',
  'patch-panel':         'Patch Panel',
  'patch-panel-copper':  'Patch Panel (Copper)',
  'patch-panel-fiber':   'Patch Panel (Fiber)',
  'cable-manager':       'Cable Mgmt',
  keystone:              'Keystone Panel',
  blank:                 'Blank Panel',
  kvm:                   'KVM',
  'console-server':      'Console Server',
  oob:                   'OOB Mgmt',
  ap:                    'Access Point',
  'wireless-controller': 'Wireless Controller',
  'load-balancer':       'Load Balancer',
  amplifier:             'Amplifier',
  'media-player':        'Media Player',
  'display-controller':  'Display Controller',
  shelf:                 'Shelf',
  drawer:                'Drawer',
  other:                 'Device',
};

// ─── Canvas helpers ───────────────────────────────────────────────────────────

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Truncates text with an ellipsis so it fits maxWidthPx under ctx's current font.
function truncateToWidth(ctx, text, maxWidthPx) {
  let result = text;
  while (result.length > 1 && ctx.measureText(result).width > maxWidthPx) result = result.slice(0, -1);
  if (result !== text) result = `${result.slice(0, -1)}…`;
  return result;
}

function captureFnFor(format) {
  if (format === 'jpeg') return toJpeg;
  if (format === 'svg')  return toSvg;
  return toPng;
}

function bgFor(theme) {
  return theme === 'light' ? '#f0f2f5' : '#0a0a0f';
}

function rackFilename(name) {
  return (name || 'rack').trim().toLowerCase().replace(/\s+/g, '-');
}

function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.download = filename;
  a.href = url;
  a.click();
}

// Page size is derived from the diagram's *unscaled* CSS dimensions at a
// fixed reference density (PDF_DPI), not from how many actual pixels the
// capture has — sizing the page off the scaled pixel count would make the
// page itself grow with `scale` while the dots-per-inch stayed pinned at
// PDF_DPI no matter what, silently throwing away the extra resolution from
// a higher capture pixelRatio. Keeping the page pinned to the diagram's
// natural size means a higher-resolution capture packs more image pixels
// into the same page area instead, which is what actually makes text look
// sharper at 100% zoom in a PDF viewer.
function makePdf(pages, filename) {
  const toPt = (px) => (px / PDF_DPI) * 72;
  const [first, ...rest] = pages;
  const pdfW = toPt(first.cssW);
  const pdfH = toPt(first.cssH);
  const pdf = new jsPDF({ orientation: pdfW >= pdfH ? 'landscape' : 'portrait', unit: 'pt', format: [pdfW, pdfH] });
  pdf.addImage(first.dataUrl, 'PNG', 0, 0, pdfW, pdfH);
  for (const page of rest) {
    const pw = toPt(page.cssW);
    const ph = toPt(page.cssH);
    // Orientation must be passed explicitly — jsPDF's addPage defaults to
    // portrait and silently swaps a landscape-shaped [w, h] array (as the
    // power summary page often is: wide outlet-block grid, short table)
    // to match, leaving the image stretched into the wrong box.
    pdf.addPage([pw, ph], pw >= ph ? 'landscape' : 'portrait');
    pdf.addImage(page.dataUrl, 'PNG', 0, 0, pw, ph);
  }
  pdf.save(filename);
}

// Rewrites every floating vertical-PDU strip and its power cord in the
// off-screen clone to the position it belongs at given the clone's own
// (possibly just-changed) frame width — e.g. narrower after Front Only/
// Rear Only removed a whole panel, or wider after Side-by-Side forced
// Rear back on when the canvas had it off. The clone still has whatever
// pixel positions got baked in from the live render at clone time, which
// is wrong the instant the column composition differs from that, since
// there's no React/observer of its own to ever recompute them. Reuses the
// exact same layout formula live rendering uses (see verticalPduLayout) —
// called unconditionally for every view, since when nothing about the
// column composition actually changed this just reproduces the same
// values live rendering already had. Every PDU is included — a vertical
// PDU is bolted to the rack's own frame rail, visible from whichever face
// you're looking at it from, not "inside" just one of them.
function relayoutPdus(clone, rack, verticalPdus, uSlots, view) {
  const frame = clone.querySelector('.rack-dual-frame');
  if (!frame) return;
  const frameHeight = frame.offsetHeight;
  // Both PDUs anchor to Front specifically, never Rear — see
  // verticalPduLayout.pduLeftPx. Rear Only has no Front panel in the
  // clone at all (it was removed entirely, not just hidden), so this
  // falls back to the frame's own width — which at that point *is* just
  // Rear's width, the same "single visible column" fallback Front Only/
  // Rear Only already used before Front/Rear became distinguishable.
  const frontPanel = frame.querySelector('.rack-panel-frame-front');
  const frontWidth = frontPanel ? frontPanel.offsetWidth : frame.offsetWidth;
  const hasGap = view === 'side-by-side';

  const layout = layoutVerticalPdus({
    verticalPdus, uSlots, rack, uHeight: DEFAULT_U_HEIGHT, frontWidth, frameHeight, hasGap,
  });
  const byId = new Map([...layout].map(([id, v]) => [String(id), v]));

  for (const el of clone.querySelectorAll('.rack-vertical-pdu[data-pdu-id]')) {
    const entry = byId.get(el.dataset.pduId);
    if (!entry) continue;
    el.style.left = `${entry.leftPx - CHANNEL_PADDING}px`;
    el.style.top = `${entry.top}px`;
    el.style.height = `${entry.height}px`;
    el.classList.remove('rack-vertical-pdu-left', 'rack-vertical-pdu-right');
    el.classList.add(`rack-vertical-pdu-${entry.side}`);
  }

  // Side rail channels are positioned off the exact same frontWidth/hasGap
  // inputs as the PDU strips above, so they go stale the same way when the
  // clone's column composition differs from the live render's.
  const channelBoxes = computeChannelBoxes({ verticalPdus, frontWidth, frameHeight, hasGap });
  for (const side of ['left', 'right']) {
    const el = clone.querySelector(`.rack-pdu-channel-${side}`);
    if (!el) continue;
    const box = channelBoxes[side];
    el.style.left = `${box.leftPx - CHANNEL_PADDING}px`;
    el.style.top = `${box.top}px`;
    el.style.height = `${box.height}px`;
    el.style.width = `${STRIP_WIDTH + CHANNEL_PADDING * 2}px`;
  }

  const svg = clone.querySelector('.rack-power-cords');
  if (!svg) return;

  const cords = [];
  for (const g of svg.querySelectorAll('g[data-pdu-id]')) {
    const entry = byId.get(g.dataset.pduId);
    if (!entry || !entry.cord) { g.remove(); continue; }
    cords.push({ g, side: entry.side, cord: entry.cord });
  }
  if (cords.length === 0) { svg.remove(); return; }

  // Re-derive the svg's own bounding box for the new coordinates — see the
  // matching comment in RackEnclosure.js for why this has to stay within
  // its declared [left, left+width] box rather than relying on overflow.
  const xs = cords.flatMap(({ cord }) => [cord.upsX, cord.c1x, cord.c2x, cord.pduX]);
  const svgLeft = Math.min(0, ...xs);
  const svgWidth = Math.max(frame.offsetWidth, ...xs) - svgLeft;
  svg.style.left = `${svgLeft}px`;
  svg.setAttribute('width', svgWidth);

  for (const { g, side, cord } of cords) {
    g.setAttribute('class', `rack-power-cord rack-power-cord-${side}`);
    const d = cordPathD(cord, svgLeft);
    // Every <path> in the group (the glow and the line) shares this same
    // single path, and every animateMotion (the lead pulse and its
    // comet-tail dots) rides it too, just phase-shifted by its own
    // `begin`.
    g.querySelectorAll('path').forEach((p) => p.setAttribute('d', d));
    g.querySelectorAll('animateMotion').forEach((anim) => anim.setAttribute('path', d));
  }
}

// Vertical PDUs float outside the dual-frame's own box (negative `left`,
// or beyond its right edge — see computeVerticalPduPositions). offsetLeft/
// offsetWidth are used instead of getBoundingClientRect because they're
// unaffected by the canvas's pan/zoom transform.
function measurePduOverflow(frame) {
  let left = 0;
  let right = 0;
  // Channels are included too — they're always rendered (even empty), and
  // their padding box reaches slightly further out than the strip placed
  // inside them ever would (see CHANNEL_PADDING), so a rack with no
  // vertical PDUs at all still needs this to avoid clipping the bare rail.
  for (const el of frame.querySelectorAll('.rack-vertical-pdu, .rack-pdu-channel')) {
    if (el.offsetParent !== frame) continue;
    left = Math.max(left, -el.offsetLeft);
    right = Math.max(right, el.offsetLeft + el.offsetWidth - frame.offsetWidth);
  }
  // The bezier cord path's outward-reach control points extend further from
  // the rack than the PDU strip edge itself (up to ~40 px beyond). Include
  // the SVG's full declared bounding box — already set by relayoutPdus just
  // before this call — so the margin/width expansion covers the entire cable
  // arc, not just the strip, and prevents html-to-image from clipping the
  // path mid-curve.
  const cordsSvg = frame.querySelector('.rack-power-cords');
  if (cordsSvg) {
    const svgLeft = parseFloat(cordsSvg.style.left) || 0;
    const svgWidth = parseFloat(cordsSvg.getAttribute('width')) || 0;
    if (svgLeft < 0) left = Math.max(left, Math.ceil(-svgLeft));
    const svgRight = svgLeft + svgWidth;
    if (svgRight > frame.offsetWidth) right = Math.max(right, Math.ceil(svgRight - frame.offsetWidth));
  }
  return { left: Math.max(0, left), right: Math.max(0, right) };
}

// Builds a detached, off-screen clone of the rack matching exactly the
// requested view — Front Only and Rear Only physically remove the other
// panel from the *clone* (not hide it via CSS on the live, on-screen rack),
// so the result is naturally sized to only the surviving column with no
// leftover blank space where the other one used to be, and the live canvas
// is never touched at all. The clone is appended to the document (off-
// screen) so it actually lays out/renders — a detached node has no box to
// measure or capture. Caller must remove `wrapper` from the DOM once done.
function buildOffscreenRack(rackId, rack, allSlots, view, theme) {
  const live = document.getElementById(`rack-${rackId}`);
  if (!live) return null;

  const clone = live.cloneNode(true);
  clone.removeAttribute('id');
  // Keep the rack name label so it appears in the export; remove only the
  // editable input (not relevant outside edit mode) and the U counter.
  clone.querySelectorAll('.rack-name-input, .rack-u-counter').forEach((el) => el.remove());
  if (theme === 'light') clone.classList.add('rack-capture-light');

  const frame = clone.querySelector('.rack-dual-frame');
  if (!frame) return null;

  // The export's view selection is completely independent of the canvas's
  // own "Show Rear Panel" toggle — Side-by-Side and Rear Only must render
  // Rear even when it's hidden on screen. RackEnclosure always renders
  // both panels now (Rear's own on-screen visibility is just a plain CSS
  // display toggle carried over onto this clone from the live render), so
  // forcing it back on is just overriding that one style — on the clone
  // only; the live, on-screen rack is never touched.
  const rearPanel = frame.querySelector('.rack-panel-frame-rear');
  if (view !== 'front-only' && rearPanel) rearPanel.style.display = '';

  if (view !== 'side-by-side') {
    const deadFace = view === 'front-only' ? 'rear' : 'front';
    const deadPanel = frame.querySelector(`.rack-panel-frame-${deadFace}`);
    if (deadPanel) deadPanel.remove();
    // Matches the live single-column rack mode's own wider unit column
    // (Rear permanently hidden) rather than a one-off magic width.
    clone.classList.add('rack-enclosure-single');
  } else {
    // The opposite case: if Rear was off on the canvas, the live clone
    // carries this class sized for Front alone — forcing Rear back on
    // for Side-by-Side needs the normal two-column width instead.
    clone.classList.remove('rack-enclosure-single');
  }

  // A detached node tree has no layout box at all — offsetWidth/offsetLeft/
  // offsetParent are all 0/null until it's actually attached to the
  // document, so every measurement below (the PDU relayout, and the
  // overflow-bleed sizing) has to happen *after* this, not before.
  const wrapper = document.createElement('div');
  wrapper.style.position = 'fixed';
  wrapper.style.left = '-100000px';
  wrapper.style.top = '0';
  wrapper.style.pointerEvents = 'none';
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  const verticalPdus = allSlots.filter((s) => s.rack_id === rack.id && s.item_type === 'vertical-pdu');
  const uSlots = allSlots.filter((s) => s.rack_id === rack.id && s.item_type !== 'vertical-pdu');
  relayoutPdus(clone, rack, verticalPdus, uSlots, view);

  // Expand the clone's own box (not .rack-dual-frame's — see below) to fit
  // any vertical PDU strip floating outside the frame's normal bounds.
  // align-self:flex-start decouples the frame from .rack-enclosure's
  // flex-column stretch, so widening the *enclosure* leaves the extra
  // space empty to its right instead of stretching the frame's own panels
  // (which are flex:1) to fill it.
  const { left, right } = measurePduOverflow(frame);
  if (left > 0) frame.style.marginLeft = `${left}px`;
  frame.style.alignSelf = 'flex-start';
  if (right > 0) clone.style.width = `${clone.offsetWidth + right}px`;

  return wrapper;
}

// ─── Capture a single rack in the requested view/theme ────────────────────────
// Returns { dataUrl, cssW, cssH, pduOverflowLeft, frameOffsetTop, frontWidth, verticalPdus, pduLayout }
// The extra fields let compositeRacks draw cross-rack cables onto the composite.
async function captureSingle(rackId, rack, allSlots, { format, view, theme, scale }) {
  const wrapper = buildOffscreenRack(rackId, rack, allSlots, view, theme);
  if (!wrapper) return null;

  try {
    const clone = wrapper.firstChild;
    const capFn = captureFnFor(format);
    const bg = bgFor(theme);
    const w = clone.offsetWidth;
    const h = clone.offsetHeight;

    // Capture layout metadata while the clone is still attached and has a real
    // layout box.  compositeRacks uses this to draw cross-rack cables.
    const frame = clone.querySelector('.rack-dual-frame');
    const frontPanel = frame && frame.querySelector('.rack-panel-frame-front');
    const frontWidth = frontPanel ? frontPanel.offsetWidth : (frame ? frame.offsetWidth : 0);
    const frameHeight = frame ? frame.offsetHeight : 0;
    const frameOffsetTop = frame ? frame.offsetTop : 0;
    const hasGap = view === 'side-by-side';
    const pduOverflowLeft = frame ? (parseFloat(frame.style.marginLeft) || 0) : 0;
    const verticalPdus = allSlots.filter((s) => s.rack_id === rackId && s.item_type === 'vertical-pdu');
    const uSlotsForLayout = allSlots.filter((s) => s.rack_id === rackId && s.item_type !== 'vertical-pdu');
    const pduLayout = layoutVerticalPdus({
      verticalPdus, uSlots: uSlotsForLayout, rack, uHeight: DEFAULT_U_HEIGHT, frontWidth, frameHeight, hasGap,
    });

    const dataUrl = await capFn(clone, { backgroundColor: bg, pixelRatio: scale });
    return { dataUrl, cssW: w, cssH: h, pduOverflowLeft, frameOffsetTop, frontWidth, verticalPdus, pduLayout };
  } finally {
    wrapper.remove();
  }
}

// ─── Cross-rack cable drawing ─────────────────────────────────────────────────

// Frame-local y of the bottom edge of a device slot (16px = rack-top-blank
// height + its margin-bottom). Matches verticalPduLayout.bottomY exactly.
function upsBottomY(rack, u_position, u_size) {
  const top = 16 + (rack.u_height - (u_position + u_size - 1)) * DEFAULT_U_HEIGHT;
  return top + u_size * DEFAULT_U_HEIGHT;
}

// Draws cross-rack power-cord beziers onto a composite canvas that already
// has each rack image painted at the positions described by `rackPositions`.
// Coordinates are in CSS pixel space (ctx has already been scaled).
function drawCrossRackCablesOnCanvas(ctx, captures, targetRacks, rackPositions, allSlots) {
  // Build a lookup from rack id → { rack, capture, pos } for both directions
  const byRackId = new Map();
  for (let i = 0; i < captures.length; i++) {
    if (captures[i] && targetRacks[i]) {
      byRackId.set(targetRacks[i].id, { rack: targetRacks[i], capture: captures[i], pos: rackPositions[i] });
    }
  }

  for (const { rack, capture, pos } of byRackId.values()) {
    if (!capture.verticalPdus || !capture.pduLayout) continue;

    for (const pdu of capture.verticalPdus) {
      if (!pdu.power_source_slot_id) continue;
      const ups = allSlots.find((s) => s.id === pdu.power_source_slot_id);
      // Same-rack connections are already drawn by each rack's own .rack-power-cords SVG.
      if (!ups || ups.rack_id === pdu.rack_id) continue;

      const upsEntry = byRackId.get(ups.rack_id);
      if (!upsEntry) continue; // UPS's rack not included in this export set

      const pduEntry = capture.pduLayout.get(pdu.id);
      if (!pduEntry) continue;

      // PDU anchor: bottom-center of its floating strip in composite CSS-px space
      const pduX = pos.x + capture.pduOverflowLeft + pduEntry.leftPx + STRIP_WIDTH / 2;
      const pduY = pos.y + capture.frameOffsetTop + pduEntry.top + pduEntry.height;

      // UPS anchor: the frame edge of the UPS's rack that faces the PDU's rack.
      // Mirrors same-rack cord logic: upsX = 0 (left edge of Front) or frontWidth
      // (right edge of Front) — both in frame-local coords → shifted by pduOverflowLeft.
      const { capture: upsCap, pos: upsPos, rack: upsRack } = upsEntry;
      const upsFrameLeft  = upsPos.x + upsCap.pduOverflowLeft;
      const upsFrameRight = upsFrameLeft + upsCap.frontWidth;
      const pduIsLeft = pduX < (upsFrameLeft + upsCap.frontWidth / 2);
      const upsX = pduIsLeft ? upsFrameLeft : upsFrameRight;
      const upsY = upsPos.y + upsCap.frameOffsetTop + upsBottomY(upsRack, ups.u_position, ups.u_size);

      // Bezier control points — identical formula to CrossRackPowerOverlay / buildCordCurve
      const outward = pduIsLeft ? -1 : 1;
      const dist = Math.hypot(pduX - upsX, pduY - upsY);
      const reach = Math.max(10, Math.min(40, dist * 0.3));
      const droop = Math.max(16, Math.min(48, dist * 0.24));
      const lowY  = Math.max(upsY, pduY) + droop;
      const c1x = upsX + outward * reach * 0.4;
      const c1y = (upsY + lowY) / 2;
      const c2x = pduX + outward * reach;
      const c2y = lowY;

      // Glow: wide, blurred, low-opacity stroke
      ctx.save();
      ctx.filter = 'blur(2px)';
      ctx.beginPath();
      ctx.moveTo(upsX, upsY);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, pduX, pduY);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 7;
      ctx.globalAlpha = 0.28;
      ctx.stroke();
      ctx.restore();

      // Cord: solid amber line
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(upsX, upsY);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, pduX, pduY);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 1;
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ─── Composite multiple rack captures side-by-side ────────────────────────────
// Returns { dataUrl, cssW, cssH }
// targetRacks and allSlots are optional; when provided, cross-rack power cables
// are drawn on top of the composite after the rack images are placed.
async function compositeRacks(captures, targetRacks, allSlots, { theme, scale, format }) {
  // Keep original rack→capture pairing when filtering nulls, so indices stay aligned.
  const validPairs = captures
    .map((c, i) => ({ capture: c, rack: targetRacks ? targetRacks[i] : null }))
    .filter(({ capture }) => capture != null);

  if (validPairs.length === 0) return null;
  if (validPairs.length === 1) return validPairs[0].capture;

  const GAP = 48;
  const PAD = 32;
  const totalCssW = validPairs.reduce((sum, { capture: c }) => sum + c.cssW, 0) + GAP * (validPairs.length - 1) + PAD * 2;
  const maxCssH = Math.max(...validPairs.map(({ capture: c }) => c.cssH));
  const totalCssH = maxCssH + PAD * 2;

  const canvas = document.createElement('canvas');
  canvas.width = totalCssW * scale;
  canvas.height = totalCssH * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = bgFor(theme);
  ctx.fillRect(0, 0, totalCssW, totalCssH);

  const imgs = await Promise.all(validPairs.map(({ capture: c }) => loadImage(c.dataUrl)));

  // Track each rack's CSS-pixel origin in the composite for cable drawing.
  const rackPositions = [];
  let x = PAD;
  for (let i = 0; i < validPairs.length; i++) {
    const { capture: c } = validPairs[i];
    const y = PAD + Math.floor((maxCssH - c.cssH) / 2);
    rackPositions.push({ x, y });
    ctx.drawImage(imgs[i], x, y, c.cssW, c.cssH);
    x += c.cssW + GAP;
  }

  // Draw cross-rack power cables on top of the composited rack images.
  if (allSlots && targetRacks) {
    drawCrossRackCablesOnCanvas(
      ctx,
      validPairs.map(({ capture: c }) => c),
      validPairs.map(({ rack: r }) => r),
      rackPositions,
      allSlots,
    );
  }

  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return { dataUrl: canvas.toDataURL(mime, 0.95), cssW: totalCssW, cssH: totalCssH };
}

// ─── Legend panel: device type → color swatch, one entry per type ─────────────
const LEG_SWATCH   = 11;   // colored swatch size
const LEG_ROW_H    = 20;   // height per entry row
const LEG_HEADER_H = 22;   // "LEGEND" header row
const LEG_PADV     = 10;   // top/bottom padding inside panel
const LEG_PADH     = 12;   // left/right padding inside panel
const LEG_FONT_SZ  = 10;

function buildLegendItems(slots) {
  // Build unique device-type entries (skip blanks, one per type)
  const seen = new Map();
  for (const s of slots) {
    if (s.item_type === 'blank') continue;
    const type = resolveRenderType(s);
    if (!seen.has(type)) {
      const color = CATEGORY_CONFIG[type] || CATEGORY_CONFIG.other;
      const label = TYPE_LABELS[type] || 'Device';
      seen.set(type, { color, label });
    }
  }
  return [...seen.values()];
}

function measureLegendHeight(items) {
  return LEG_PADV * 2 + LEG_HEADER_H + items.length * LEG_ROW_H;
}

// Draws the legend panel with its top-left at (x, y), both already in
// physical (scaled) px, with the given panel width (also physical px).
function drawLegendPanel(ctx, x, y, panelW, items, { theme, scale }) {
  const s = scale;
  const panelH = measureLegendHeight(items) * s;

  const panelBg  = theme === 'light' ? 'rgba(200,210,225,0.55)' : 'rgba(26,28,36,0.96)';
  const panelBrd = theme === 'light' ? '#a8b4c4' : '#2a2e38';

  ctx.fillStyle = panelBg;
  roundRect(ctx, x, y, panelW, panelH, 6 * s);
  ctx.fill();
  ctx.strokeStyle = panelBrd;
  ctx.lineWidth = 1 * s;
  roundRect(ctx, x, y, panelW, panelH, 6 * s);
  ctx.stroke();

  const hdrColor = theme === 'light' ? '#607080' : '#6b7280';
  const sepColor = theme === 'light' ? '#a8b4c4' : '#2a2e38';
  const txtColor = theme === 'light' ? '#263040' : '#d4d8e0';

  ctx.fillStyle = hdrColor;
  ctx.font = `bold ${Math.round(8 * s)}px monospace`;
  ctx.fillText('LEGEND', x + LEG_PADH * s, y + (LEG_PADV + 12) * s);

  ctx.fillStyle = sepColor;
  ctx.fillRect(x + LEG_PADH * s, y + (LEG_PADV + LEG_HEADER_H - 2) * s, panelW - LEG_PADH * 2 * s, Math.max(1, Math.round(s)));

  ctx.font = `${Math.round(LEG_FONT_SZ * s)}px monospace`;

  for (let i = 0; i < items.length; i++) {
    const { color, label } = items[i];
    const rowTop = y + (LEG_PADV + LEG_HEADER_H + i * LEG_ROW_H) * s;
    const rowMid = rowTop + (LEG_ROW_H / 2) * s;
    const swX = x + LEG_PADH * s;
    const swY = rowMid - (LEG_SWATCH / 2) * s;

    ctx.fillStyle = color;
    roundRect(ctx, swX, swY, LEG_SWATCH * s, LEG_SWATCH * s, 3 * s);
    ctx.fill();

    ctx.fillStyle = txtColor;
    const maxW = panelW - (LEG_PADH * 2 + LEG_SWATCH + 8) * s;
    ctx.fillText(truncateToWidth(ctx, label, maxW), swX + (LEG_SWATCH + 7) * s, rowMid + 4 * s);
  }
}

// ─── Power summary: per-device outlet map + a device → plugged-into table ─────
const POW_PADV         = 10;
const POW_PADH         = 12;
const POW_HEADER_H     = 22;  // "POWER" header row
const POW_SUB_H        = 16;  // device label sub-header
const POW_INPUT_H      = 13;  // "Input: ..." line
const POW_TYPE_H       = 13;  // outlet-type sub-group header (e.g. "C13")
const POW_OUTLET_H     = 12;  // one numbered outlet row
const POW_BLOCK_GAP    = 7;   // gap between two devices' outlet-map blocks
const POW_SECTION_GAP  = 12;  // gap between outlet map and connections table
const POW_TABLE_HEADER_H = 15;
const POW_TABLE_ROW_H  = 12;
const POW_FONT_SZ      = 9;
const POW_FONT_SZ_SM   = 8;   // outlet rows / table rows — kept small so the panel stays compact

// Vertical PDUs are floating 0U elements owned by a UPS — list each main
// power device top-of-rack-first, with any vertical PDUs it owns
// immediately following it (any orphaned ones, if that ever happens, at
// the end so nothing silently disappears from the summary).
function orderPowerDevices(slots) {
  const main = slots
    .filter((s) => isPowerDevice(s) && s.item_type !== 'vertical-pdu')
    .sort((a, b) => b.u_position - a.u_position);

  const result = [];
  const seen = new Set();
  for (const dev of main) {
    result.push(dev);
    seen.add(dev.id);
    if (isUps(dev)) {
      for (const vpdu of verticalPdusForUps(slots, dev.id)) {
        result.push(vpdu);
        seen.add(vpdu.id);
      }
    }
  }
  for (const s of slots) {
    if (s.item_type === 'vertical-pdu' && !seen.has(s.id)) result.push(s);
  }
  return result;
}

// "<PDU label> → <Type> Outlet N", or the appropriate not-connected label,
// for one PSU's connection. Looks the source up in `allSlots` (project-
// wide, not just the racks being exported) since a PSU can point at a
// PDU/UPS in any rack — the connections table is text, not a rendered
// panel, so it can describe a cross-rack connection even when the target
// rack itself isn't part of this particular export.
function describeConnection(sourceId, outlet, allSlots, unsetLabel) {
  if (!sourceId) return unsetLabel;
  const source = allSlots.find((x) => x.id === sourceId);
  if (!source) return unsetLabel;
  const flat = flattenOutlets(source).find((o) => o.n === outlet);
  const outletLabel = flat ? `${flat.type} Outlet ${flat.indexInGroup}` : `Outlet ${outlet}`;
  return `${getPowerSourceLabel(source, allSlots)} → ${outletLabel}`;
}

// Pure data model — no canvas. { outletBlocks, connections, hasContent }
// `slots` is the devices actually being exported (rows in the table);
// `allSlots` is every rack in the project, used only to resolve what a
// cross-rack PSU connection or outlet occupant actually points at.
// `racks` (id -> name) is only needed to spell out the other rack's name
// when a vertical PDU's UPS connection crosses rack boundaries.
function buildPowerSummaryModel(slots, allSlots, racks) {
  const powerDevices = orderPowerDevices(slots);
  if (powerDevices.length === 0) return { outletBlocks: [], connections: [], hasContent: false };

  const sourceById = new Map(listPowerSources(allSlots).map((entry) => [entry.slot.id, entry]));

  const outletBlocks = powerDevices.map((dev) => {
    const entry = sourceById.get(dev.id);
    const groups = [];
    if (entry) {
      let curType = null;
      let curRows = null;
      for (const o of entry.outlets) {
        if (o.type !== curType) {
          curType = o.type;
          curRows = [];
          groups.push({ type: curType, rows: curRows });
        }
        curRows.push({
          index: o.indexInGroup,
          label: o.occupant ? getPowerLabel(o.occupant) : 'Empty',
          empty: !o.occupant,
        });
      }
    }
    return {
      label: getPowerLabel(dev) + (dev.item_type === 'vertical-pdu' ? ' (Vertical PDU)' : ''),
      inputLine: `Input: ${dev.input_plug_type || '—'} · ${dev.input_voltage || '—'}`,
      groups,
    };
  });

  // Every non-power, non-passive device (passive items like blanks/patch
  // panels/shelves have no power cord, so they're not relevant here) plus
  // vertical PDUs, which are power devices themselves but still have their
  // own upstream "Plugged Into" connection worth listing.
  // Each row shows both independent power connections — PSU2 is optional,
  // so an unset one reads as "Not connected" rather than "Wall (Direct)"
  // (which specifically means "this cord really does go to the wall").
  const connections = slots
    .filter((s) => (!isPowerDevice(s) && !isPassiveItem(s)) || s.item_type === 'vertical-pdu')
    .sort((a, b) => b.u_position - a.u_position)
    .map((s) => {
      let psu1 = describeConnection(s.power_source_slot_id, s.power_source_outlet, allSlots, 'Wall (Direct)');
      if (s.item_type === 'vertical-pdu' && s.power_source_slot_id) {
        const source = allSlots.find((x) => x.id === s.power_source_slot_id);
        const sourceRack = source && source.rack_id !== s.rack_id
          ? (racks || []).find((r) => r.id === source.rack_id)
          : null;
        if (sourceRack) psu1 += ` — Connected to UPS in ${sourceRack.name}`;
      }
      return {
        device: getPowerLabel(s),
        psu1,
        psu1Dim: !s.power_source_slot_id,
        psu2: describeConnection(s.psu2_source_slot_id, s.psu2_source_outlet, allSlots, 'Not connected'),
        psu2Dim: !s.psu2_source_slot_id,
      };
    });

  return { outletBlocks, connections, hasContent: true };
}

// ─── Full-width Power Summary page (PDF page 2) ───────────────────────────────
const P2_PAD     = 40;
const P2_HDR_H   = 28;   // title line height
const P2_SUB_LINE = 16;  // subtitle line height
const P2_SEP_GAP = 16;   // gap below the separator line
const P2_COLS    = 2;    // outlet block columns
const P2_BGAP    = 20;   // gap between block columns/rows
const P2_BPADH   = 14;   // block inner horizontal padding
const P2_BPADV   = 12;   // block inner vertical padding
const P2_FONT_TITLE  = 18;
const P2_FONT_LABEL  = 11;
const P2_FONT_BODY   = 9;
const P2_FONT_SM     = 8;
const P2_LH_SUB  = 18;   // device label row height
const P2_LH_INP  = 14;   // input line height
const P2_LH_TYPE = 13;   // outlet-type header height
const P2_LH_OUTL = 12;   // per-outlet row height
const P2_LH_ROW  = 13;   // connection table row height

function p2BlockHeight(block) {
  let h = P2_BPADV * 2 + P2_LH_SUB + P2_LH_INP;
  block.groups.forEach((g) => { h += P2_LH_TYPE + g.rows.length * P2_LH_OUTL; });
  return h;
}

async function buildPowerSummaryPageCanvas(model, racks, pageW, { theme, scale }) {
  const s = scale;
  const bg      = bgFor(theme);
  const txtColor = theme === 'light' ? '#263040' : '#d4d8e0';
  const dimColor = theme === 'light' ? '#8a96a8' : '#5a6170';
  const hdrColor = theme === 'light' ? '#607080' : '#6b7280';
  const sepColor = theme === 'light' ? '#a8b4c4' : '#2a2e38';
  const accentColor = theme === 'light' ? '#3060a0' : '#4adede';
  const panelBg  = theme === 'light' ? 'rgba(200,210,225,0.45)' : 'rgba(26,28,36,0.96)';
  const panelBrd = theme === 'light' ? '#a8b4c4' : '#2a2e38';

  const innerW   = pageW - P2_PAD * 2;
  const colW     = (innerW - P2_BGAP * (P2_COLS - 1)) / P2_COLS;
  const blocks   = model.outletBlocks;
  const nRows    = Math.ceil(blocks.length / P2_COLS);

  // Row heights: maximum block height per row (both cols sit at the same y)
  const rowHs = [];
  for (let r = 0; r < nRows; r++) {
    let maxH = 0;
    for (let c = 0; c < P2_COLS; c++) {
      const idx = r * P2_COLS + c;
      if (idx < blocks.length) maxH = Math.max(maxH, p2BlockHeight(blocks[idx]));
    }
    rowHs.push(maxH);
  }
  const gridH  = rowHs.reduce((a, b) => a + b, 0) + Math.max(0, nRows - 1) * P2_BGAP;
  const tableH = model.connections.length > 0
    ? P2_BGAP + P2_LH_ROW * 2 + model.connections.length * P2_LH_ROW
    : 0;

  // Total page height: header + separator gap + optional grid + optional table + bottom pad
  const headerH = P2_PAD + P2_HDR_H + P2_SUB_LINE + P2_SEP_GAP;
  const pageH   = headerH + (gridH > 0 ? gridH + P2_PAD : 0) + (tableH > 0 ? tableH + P2_PAD : 0) + P2_PAD;

  const canvas = document.createElement('canvas');
  canvas.width  = pageW * s;
  canvas.height = pageH * s;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, pageW * s, pageH * s);

  // ── Header ──────────────────────────────────────────────────────────────
  let cy = P2_PAD * s;

  ctx.font      = `bold ${Math.round(P2_FONT_TITLE * s)}px monospace`;
  ctx.fillStyle = accentColor;
  ctx.fillText('POWER SUMMARY', P2_PAD * s, cy + P2_FONT_TITLE * s);
  cy += P2_HDR_H * s;

  const rackNames = racks.map((r) => r.name).join(', ');
  const dateStr   = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  ctx.font      = `${Math.round(P2_FONT_BODY * s)}px monospace`;
  ctx.fillStyle = dimColor;
  ctx.fillText(`${rackNames}  ·  ${dateStr}`, P2_PAD * s, cy + P2_FONT_BODY * s);
  cy += P2_SUB_LINE * s;

  ctx.fillStyle = sepColor;
  ctx.fillRect(P2_PAD * s, cy, innerW * s, Math.max(1, Math.round(s)));
  cy += P2_SEP_GAP * s;

  // ── Outlet block grid ─────────────────────────────────────────────────────
  if (blocks.length > 0) {
    let rowY = cy;
    for (let r = 0; r < nRows; r++) {
      for (let c = 0; c < P2_COLS; c++) {
        const idx = r * P2_COLS + c;
        if (idx >= blocks.length) continue;
        const block = blocks[idx];
        const bx  = (P2_PAD + c * (colW + P2_BGAP)) * s;
        const bh  = rowHs[r] * s;
        const bw  = colW * s;
        const maxBW = (colW - P2_BPADH * 2) * s;

        ctx.fillStyle = panelBg;
        roundRect(ctx, bx, rowY, bw, bh, 6 * s);
        ctx.fill();
        ctx.strokeStyle = panelBrd;
        ctx.lineWidth = Math.max(1, Math.round(s));
        roundRect(ctx, bx, rowY, bw, bh, 6 * s);
        ctx.stroke();

        let iy = rowY + P2_BPADV * s;

        ctx.font      = `bold ${Math.round(P2_FONT_LABEL * s)}px monospace`;
        ctx.fillStyle = txtColor;
        ctx.fillText(truncateToWidth(ctx, block.label, maxBW), bx + P2_BPADH * s, iy + P2_FONT_LABEL * s);
        iy += P2_LH_SUB * s;

        ctx.font      = `${Math.round(P2_FONT_SM * s)}px monospace`;
        ctx.fillStyle = dimColor;
        ctx.fillText(truncateToWidth(ctx, block.inputLine, maxBW), bx + P2_BPADH * s, iy + P2_FONT_SM * s);
        iy += P2_LH_INP * s;

        block.groups.forEach((grp) => {
          ctx.font      = `bold ${Math.round(P2_FONT_SM * s)}px monospace`;
          ctx.fillStyle = hdrColor;
          ctx.fillText(truncateToWidth(ctx, grp.type, maxBW), bx + P2_BPADH * s, iy + P2_FONT_SM * s);
          iy += P2_LH_TYPE * s;

          ctx.font = `${Math.round(P2_FONT_SM * s)}px monospace`;
          grp.rows.forEach((outlet) => {
            ctx.fillStyle = hdrColor;
            ctx.fillText(String(outlet.index), bx + P2_BPADH * s, iy + P2_FONT_SM * s);
            ctx.fillStyle = outlet.empty ? dimColor : txtColor;
            ctx.fillText(truncateToWidth(ctx, outlet.label, maxBW - 20 * s), bx + (P2_BPADH + 20) * s, iy + P2_FONT_SM * s);
            iy += P2_LH_OUTL * s;
          });
        });
      }
      rowY += (rowHs[r] + P2_BGAP) * s;
    }
    cy = rowY - P2_BGAP * s + P2_PAD * s;
  }

  // ── Device power connections table ─────────────────────────────────────────
  if (model.connections.length > 0) {
    const col1x = P2_PAD * s;
    const col2x = (P2_PAD + innerW * 0.30) * s;
    const col3x = (P2_PAD + innerW * 0.65) * s;
    const c1max = (innerW * 0.28) * s;
    const c2max = (innerW * 0.33) * s;
    const c3max = (innerW * 0.33) * s;

    ctx.font      = `bold ${Math.round(P2_FONT_LABEL * s)}px monospace`;
    ctx.fillStyle = hdrColor;
    ctx.fillText('DEVICE POWER CONNECTIONS', col1x, cy + P2_FONT_LABEL * s);
    cy += P2_LH_ROW * 1.5 * s;

    ctx.fillStyle = sepColor;
    ctx.fillRect(col1x, cy, innerW * s, Math.max(1, Math.round(s)));
    cy += (1 + 6) * s;

    ctx.font      = `bold ${Math.round(P2_FONT_BODY * s)}px monospace`;
    ctx.fillStyle = hdrColor;
    ctx.fillText('DEVICE', col1x, cy + P2_FONT_BODY * s);
    ctx.fillText('PSU 1',  col2x, cy + P2_FONT_BODY * s);
    ctx.fillText('PSU 2',  col3x, cy + P2_FONT_BODY * s);
    cy += P2_LH_ROW * s;

    ctx.font = `${Math.round(P2_FONT_BODY * s)}px monospace`;
    model.connections.forEach((row) => {
      ctx.fillStyle = txtColor;
      ctx.fillText(truncateToWidth(ctx, row.device, c1max), col1x, cy + P2_FONT_BODY * s);
      ctx.fillStyle = row.psu1Dim ? dimColor : txtColor;
      ctx.fillText(truncateToWidth(ctx, row.psu1, c2max), col2x, cy + P2_FONT_BODY * s);
      ctx.fillStyle = row.psu2Dim ? dimColor : txtColor;
      ctx.fillText(truncateToWidth(ctx, row.psu2, c3max), col3x, cy + P2_FONT_BODY * s);
      cy += P2_LH_ROW * s;
    });
  }

  return { dataUrl: canvas.toDataURL('image/png'), cssW: pageW, cssH: pageH };
}

function measurePowerSummaryHeight(model) {
  if (!model.hasContent) return 0;
  let h = POW_PADV * 2 + POW_HEADER_H;
  model.outletBlocks.forEach((b, i) => {
    if (i > 0) h += POW_BLOCK_GAP;
    h += POW_SUB_H + POW_INPUT_H;
    b.groups.forEach((g) => { h += POW_TYPE_H + g.rows.length * POW_OUTLET_H; });
  });
  if (model.connections.length > 0) {
    h += POW_SECTION_GAP + POW_TABLE_HEADER_H + model.connections.length * POW_TABLE_ROW_H;
  }
  return h;
}

// Draws the power summary panel with its top-left at (x, y), both already in
// physical (scaled) px, with the given panel width (also physical px).
function drawPowerSummaryPanel(ctx, x, y, panelW, model, { theme, scale }) {
  const s = scale;
  const panelH = measurePowerSummaryHeight(model) * s;

  const panelBg  = theme === 'light' ? 'rgba(200,210,225,0.55)' : 'rgba(26,28,36,0.96)';
  const panelBrd = theme === 'light' ? '#a8b4c4' : '#2a2e38';
  const hdrColor = theme === 'light' ? '#607080' : '#6b7280';
  const sepColor = theme === 'light' ? '#a8b4c4' : '#2a2e38';
  const txtColor = theme === 'light' ? '#263040' : '#d4d8e0';
  const dimColor = theme === 'light' ? '#8a96a8' : '#5a6170';

  ctx.fillStyle = panelBg;
  roundRect(ctx, x, y, panelW, panelH, 6 * s);
  ctx.fill();
  ctx.strokeStyle = panelBrd;
  ctx.lineWidth = 1 * s;
  roundRect(ctx, x, y, panelW, panelH, 6 * s);
  ctx.stroke();

  ctx.fillStyle = hdrColor;
  ctx.font = `bold ${Math.round(8 * s)}px monospace`;
  ctx.fillText('POWER', x + POW_PADH * s, y + (POW_PADV + 12) * s);
  ctx.fillStyle = sepColor;
  ctx.fillRect(x + POW_PADH * s, y + (POW_PADV + POW_HEADER_H - 2) * s, panelW - POW_PADH * 2 * s, Math.max(1, Math.round(s)));

  const innerMaxW = panelW - POW_PADH * 2 * s;
  let cy = y + (POW_PADV + POW_HEADER_H) * s;

  // ── Section 1: outlet map ──────────────────────────────────────────────
  model.outletBlocks.forEach((block, bi) => {
    if (bi > 0) cy += POW_BLOCK_GAP * s;

    ctx.font = `bold ${Math.round(POW_FONT_SZ * s)}px monospace`;
    ctx.fillStyle = txtColor;
    ctx.fillText(truncateToWidth(ctx, block.label, innerMaxW), x + POW_PADH * s, cy + 11 * s);
    cy += POW_SUB_H * s;

    ctx.font = `${Math.round(POW_FONT_SZ_SM * s)}px monospace`;
    ctx.fillStyle = dimColor;
    ctx.fillText(truncateToWidth(ctx, block.inputLine, innerMaxW), x + POW_PADH * s, cy + 9 * s);
    cy += POW_INPUT_H * s;

    block.groups.forEach((group) => {
      ctx.font = `bold ${Math.round(POW_FONT_SZ_SM * s)}px monospace`;
      ctx.fillStyle = hdrColor;
      ctx.fillText(truncateToWidth(ctx, group.type, innerMaxW), x + POW_PADH * s, cy + 10 * s);
      cy += POW_TYPE_H * s;

      ctx.font = `${Math.round(POW_FONT_SZ_SM * s)}px monospace`;
      group.rows.forEach((row) => {
        ctx.fillStyle = txtColor;
        ctx.fillText(String(row.index), x + (POW_PADH + 2) * s, cy + 9 * s);
        ctx.fillStyle = row.empty ? dimColor : txtColor;
        const rowMaxW = innerMaxW - 20 * s;
        ctx.fillText(truncateToWidth(ctx, row.label, rowMaxW), x + (POW_PADH + 20) * s, cy + 9 * s);
        cy += POW_OUTLET_H * s;
      });
    });
  });

  // ── Section 2: device → PSU1/PSU2 plugged-into table ────────────────────
  if (model.connections.length > 0) {
    cy += POW_SECTION_GAP * s;

    // Two columns of roughly equal width for the two independent power
    // cords, with the device name column slightly narrower than either —
    // a "Rack 2 — PDU Right → Outlet 3"-style label needs more room than
    // a device name does.
    const col1 = x + POW_PADH * s;
    const col2 = x + Math.round(panelW * 0.26);
    const col3 = x + Math.round(panelW * 0.63);

    ctx.font = `bold ${Math.round(POW_FONT_SZ_SM * s)}px monospace`;
    ctx.fillStyle = hdrColor;
    ctx.fillText('DEVICE', col1, cy + 10 * s);
    ctx.fillText('PSU 1', col2, cy + 10 * s);
    ctx.fillText('PSU 2', col3, cy + 10 * s);
    cy += POW_TABLE_HEADER_H * s;

    ctx.font = `${Math.round(POW_FONT_SZ_SM * s)}px monospace`;
    model.connections.forEach((row) => {
      ctx.fillStyle = txtColor;
      ctx.fillText(truncateToWidth(ctx, row.device, col2 - col1 - 4 * s), col1, cy + 9 * s);
      ctx.fillStyle = row.psu1Dim ? dimColor : txtColor;
      ctx.fillText(truncateToWidth(ctx, row.psu1, col3 - col2 - 4 * s), col2, cy + 9 * s);
      ctx.fillStyle = row.psu2Dim ? dimColor : txtColor;
      ctx.fillText(truncateToWidth(ctx, row.psu2, x + panelW - col3 - POW_PADH * s), col3, cy + 9 * s);
      cy += POW_TABLE_ROW_H * s;
    });
  }
}

// ─── Composite the legend and/or power summary, stacked in one side column ────
// Returns { dataUrl, cssW, cssH } with updated (expanded) dimensions.
async function compositeSidePanel(dataUrl, cssW, cssH, slots, allSlots, racks, { theme, scale, includeLegend, includePowerSummary }) {
  const legendItems = includeLegend ? buildLegendItems(slots) : [];
  const powerModel = includePowerSummary ? buildPowerSummaryModel(slots, allSlots, racks) : { hasContent: false };

  const legendH = legendItems.length > 0 ? measureLegendHeight(legendItems) : 0;
  const powerH = powerModel.hasContent ? measurePowerSummaryHeight(powerModel) : 0;
  if (legendH === 0 && powerH === 0) return { dataUrl, cssW, cssH };

  const LEG_W = 168;   // legend-only column width (unchanged from before)
  const POW_W = 460;   // wider column when the power summary is present, to fit two
                        // independent "Rack N — PDU Side → Type Outlet N" PSU columns
  const SIDE_GAP = 20; // gap between rack image and the side column
  const STACK_GAP = 14; // gap between legend and power summary within the column
  const TOP_OFFSET = 20; // drop the column 20px from the top so it doesn't crowd the rack name
  const BOTTOM_PAD = 24;

  const colW = powerH > 0 ? POW_W : LEG_W;
  const betweenGap = (legendH > 0 && powerH > 0) ? STACK_GAP : 0;
  const colContentH = legendH + betweenGap + powerH;

  const totalCssW = cssW + SIDE_GAP + colW;
  const totalCssH = Math.max(cssH, TOP_OFFSET + colContentH + BOTTOM_PAD);

  const physW = totalCssW * scale;
  const physH = totalCssH * scale;
  const s = scale;

  const canvas = document.createElement('canvas');
  canvas.width = physW;
  canvas.height = physH;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = bgFor(theme);
  ctx.fillRect(0, 0, physW, physH);

  const rackOffsetY = Math.floor((totalCssH - cssH) / 2);
  const mainImg = await loadImage(dataUrl);
  ctx.drawImage(mainImg, 0, rackOffsetY * s, cssW * s, cssH * s);

  const colX = (cssW + SIDE_GAP) * s;
  let curY = TOP_OFFSET * s;

  if (legendH > 0) {
    drawLegendPanel(ctx, colX, curY, colW * s, legendItems, { theme, scale: s });
    curY += (legendH + betweenGap) * s;
  }
  if (powerH > 0) {
    drawPowerSummaryPanel(ctx, colX, curY, colW * s, powerModel, { theme, scale: s });
  }

  return { dataUrl: canvas.toDataURL('image/png'), cssW: totalCssW, cssH: totalCssH };
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function buildCsvRows(targetRacks, allSlots) {
  const isMulti = targetRacks.length > 1;
  const headers = isMulti
    ? ['Rack', 'Device Name', 'Position (U)', 'Height (U)', 'Mounted Face', 'Type', 'IP Address', 'Notes']
    : ['Device Name', 'Position (U)', 'Height (U)', 'Mounted Face', 'Type', 'IP Address', 'Notes'];

  const rows = [];
  for (const rack of targetRacks) {
    const slots = allSlots
      .filter((s) => s.rack_id === rack.id && s.item_type !== 'blank')
      .sort((a, b) => a.u_position - b.u_position);
    for (const s of slots) {
      const row = [
        s.item_label || s.hostname || '',
        s.u_position,
        s.u_size,
        s.mounted_face || 'front',
        s.custom_type || s.inv_device_type || s.item_type || '',
        s.ip_address || s.ip || '',
        (s.slot_notes || '').replace(/"/g, '""'),
      ];
      rows.push(isMulti ? [rack.name, ...row] : row);
    }
  }
  return [headers, ...rows];
}

function downloadCsv(targetRacks, allSlots) {
  const rows = buildCsvRows(targetRacks, allSlots);
  const csv = rows.map((row) => row.map((c) => `"${c}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const filename = targetRacks.length === 1
    ? `rack-${rackFilename(targetRacks[0].name)}.csv`
    : 'racks-export.csv';
  downloadUrl(url, filename);
  URL.revokeObjectURL(url);
}

// ─── Main export orchestration ────────────────────────────────────────────────

async function performExport(targetRacks, allSlots, racks, { format, view, theme, includeLegend, includePowerSummary }) {
  if (format === 'csv') { downloadCsv(targetRacks, allSlots); return; }

  const scale = EXPORT_SCALE;
  let result;

  if (targetRacks.length === 1) {
    result = await captureSingle(targetRacks[0].id, targetRacks[0], allSlots, { format, view, theme, scale });
  } else {
    const singles = await Promise.all(
      targetRacks.map((r) => captureSingle(r.id, r, allSlots, { format, view, theme, scale }))
    );
    result = await compositeRacks(singles, targetRacks, allSlots, { theme, scale, format });
  }

  if (!result) return;

  let { dataUrl, cssW, cssH } = result;

  // For PDF, power summary goes on its own page 2 — only the legend goes in
  // the side column on page 1.  For all other visual formats the existing
  // side-column layout is used unchanged.
  const powerSummaryInSidebar = includePowerSummary && format !== 'pdf';
  if ((includeLegend || powerSummaryInSidebar) && format !== 'svg') {
    const slots = allSlots.filter((s) => targetRacks.some((r) => r.id === s.rack_id));
    const sideResult = await compositeSidePanel(dataUrl, cssW, cssH, slots, allSlots, racks, {
      theme, scale, includeLegend, includePowerSummary: powerSummaryInSidebar,
    });
    ({ dataUrl, cssW, cssH } = sideResult);
  }

  const filename = targetRacks.length === 1
    ? `rack-${rackFilename(targetRacks[0].name)}`
    : 'racks-export';

  if (format === 'pdf') {
    const pages = [{ dataUrl, cssW, cssH }];
    if (includePowerSummary) {
      const slots = allSlots.filter((s) => targetRacks.some((r) => r.id === s.rack_id));
      const model = buildPowerSummaryModel(slots, allSlots, racks);
      if (model.hasContent) {
        const p2 = await buildPowerSummaryPageCanvas(model, targetRacks, Math.max(cssW, 600), { theme, scale });
        pages.push(p2);
      }
    }
    makePdf(pages, `${filename}.pdf`);
  } else if (format === 'svg') {
    const base64 = dataUrl.split(',')[1];
    const blob = new Blob([atob(base64)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    downloadUrl(url, `${filename}.svg`);
    URL.revokeObjectURL(url);
  } else if (format === 'jpeg') {
    downloadUrl(dataUrl, `${filename}.jpg`);
  } else {
    downloadUrl(dataUrl, `${filename}.png`);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ExportModal({ targetRacks, allSlots, racks, onClose }) {
  const [format, setFormat] = useState('png');
  const [view, setView] = useState('side-by-side');
  const [theme, setTheme] = useState('dark');
  const [includeLegend, setIncludeLegend] = useState(false);
  const [includePowerSummary, setIncludePowerSummary] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const isVisual = ['png', 'jpeg', 'svg', 'pdf'].includes(format);
  const isSingle = targetRacks.length === 1;
  const title = isSingle ? `Export — ${targetRacks[0]?.name}` : `Export All Racks (${targetRacks.length})`;

  const generatePreview = useCallback(async ({ format: f, view: v, theme: t, includeLegend: il, includePowerSummary: ips }) => {
    if (!['png', 'jpeg', 'svg', 'pdf'].includes(f)) { setPreviewUrl(null); return; }
    setPreviewLoading(true);
    setPreviewError(false);
    try {
      const previewFormat = f === 'svg' ? 'svg' : 'png';
      let result;
      if (targetRacks.length === 1) {
        result = await captureSingle(targetRacks[0].id, targetRacks[0], allSlots, { format: previewFormat, view: v, theme: t, scale: PREVIEW_SCALE });
      } else {
        const singles = await Promise.all(
          targetRacks.map((r) => captureSingle(r.id, r, allSlots, { format: previewFormat, view: v, theme: t, scale: PREVIEW_SCALE }))
        );
        result = await compositeRacks(singles, targetRacks, allSlots, { theme: t, scale: PREVIEW_SCALE, format: previewFormat });
      }
      if (!result) { setPreviewError(true); return; }

      let { dataUrl, cssW, cssH } = result;
      // For PDF, power summary goes on page 2 — preview shows page 1 only.
      const previewIncludePower = ips && f !== 'pdf';
      if (il || previewIncludePower) {
        const slots = allSlots.filter((s) => targetRacks.some((r) => r.id === s.rack_id));
        const sideResult = await compositeSidePanel(dataUrl, cssW, cssH, slots, allSlots, racks, {
          theme: t, scale: PREVIEW_SCALE, includeLegend: il, includePowerSummary: previewIncludePower,
        });
        dataUrl = sideResult.dataUrl;
      }
      setPreviewUrl(dataUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Export preview failed', err);
      setPreviewError(true);
    } finally {
      setPreviewLoading(false);
    }
  }, [targetRacks, allSlots, racks]);

  useEffect(() => {
    if (!isVisual) { setPreviewUrl(null); return; }
    setPreviewLoading(true);
    const timer = setTimeout(() => generatePreview({ format, view, theme, includeLegend, includePowerSummary }), PREVIEW_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [format, view, theme, includeLegend, includePowerSummary, isVisual, generatePreview]);

  const handleExport = async () => {
    setExporting(true);
    try {
      await performExport(targetRacks, allSlots, racks, { format, view, theme, includeLegend, includePowerSummary });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Export failed', err);
    } finally {
      setExporting(false);
    }
  };

  const csvPreviewRows = !isVisual ? buildCsvRows(targetRacks, allSlots).slice(0, 8) : null;

  return (
    <div className="em-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="em-modal">
        <div className="em-header">
          <span className="em-title">{title}</span>
          <button type="button" className="em-close" onClick={onClose}>✕</button>
        </div>

        <div className="em-body">
          <div className="em-options">
            <div className="em-field">
              <label className="em-label">FORMAT</label>
              <select className="em-select" value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="png">PNG — Image</option>
                <option value="jpeg">JPEG — Image (smaller)</option>
                <option value="svg">SVG — Vector</option>
                <option value="pdf">PDF — Document</option>
                <option value="csv">CSV — Spreadsheet</option>
              </select>
            </div>

            {isVisual && (
              <div className="em-field">
                <label className="em-label">VIEW</label>
                <select className="em-select" value={view} onChange={(e) => setView(e.target.value)}>
                  <option value="side-by-side">Side-by-Side (Front &amp; Rear)</option>
                  <option value="front-only">Front Only</option>
                  <option value="rear-only">Rear Only</option>
                </select>
              </div>
            )}

            {isVisual && (
              <div className="em-field">
                <label className="em-label">THEME</label>
                <select className="em-select" value={theme} onChange={(e) => setTheme(e.target.value)}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>
            )}

            {isVisual && (
              <label className="em-checkbox-row">
                <input
                  type="checkbox"
                  checked={includeLegend}
                  onChange={(e) => setIncludeLegend(e.target.checked)}
                />
                Include device legend
              </label>
            )}

            {isVisual && (
              <label className="em-checkbox-row">
                <input
                  type="checkbox"
                  checked={includePowerSummary}
                  onChange={(e) => setIncludePowerSummary(e.target.checked)}
                />
                Include power summary
              </label>
            )}
          </div>

          <div className="em-preview-area">
            <span className="em-preview-label">PREVIEW</span>
            {isVisual ? (
              <div className="em-preview-box">
                {previewLoading && <div className="em-preview-msg">Generating preview…</div>}
                {!previewLoading && previewError && <div className="em-preview-msg em-preview-err">Preview unavailable</div>}
                {!previewLoading && !previewError && previewUrl && (
                  <img className="em-preview-img" src={previewUrl} alt="Export preview" />
                )}
                {!previewLoading && !previewError && !previewUrl && (
                  <div className="em-preview-msg">—</div>
                )}
              </div>
            ) : (
              <div className="em-csv-preview">
                {csvPreviewRows && csvPreviewRows.length > 0 ? (
                  <table className="em-csv-table">
                    <tbody>
                      {csvPreviewRows.map((row, ri) => (
                        <tr key={ri} className={ri === 0 ? 'em-csv-header' : ''}>
                          {row.map((cell, ci) => <td key={ci}>{String(cell)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="em-preview-msg">No devices to export</div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="em-footer">
          <button type="button" className="em-btn em-btn-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="em-btn em-btn-export" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
