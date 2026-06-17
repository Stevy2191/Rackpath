import React, { useState, useEffect, useCallback } from 'react';
import { toPng, toJpeg, toSvg } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { CATEGORY_CONFIG, resolveRenderType } from './deviceRenderConfig';
import './ExportModal.css';

const EXPORT_SCALE = Math.max(window.devicePixelRatio || 1, 3);
const PREVIEW_SCALE = 1;
const PDF_DPI = 150;
const PREVIEW_DEBOUNCE = 350;

// Human-readable names for each device type key
const TYPE_LABELS = {
  switch:          'Switch',
  firewall:        'Firewall / Router',
  server:          'Server',
  storage:         'Storage / NAS',
  ups:             'UPS',
  pdu:             'PDU',
  'patch-panel':   'Patch Panel',
  'cable-manager': 'Cable Mgr',
  blank:           'Blank Panel',
  kvm:             'KVM',
  ap:              'Access Point',
  other:           'Device',
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

async function withClasses(el, classes, fn) {
  classes.forEach((c) => el.classList.add(c));
  try {
    return await fn();
  } finally {
    classes.forEach((c) => el.classList.remove(c));
  }
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

function makePdf(dataUrl, physW, physH, filename) {
  const pdfW = (physW / PDF_DPI) * 72;
  const pdfH = (physH / PDF_DPI) * 72;
  const pdf = new jsPDF({ orientation: pdfW >= pdfH ? 'landscape' : 'portrait', unit: 'pt', format: [pdfW, pdfH] });
  pdf.addImage(dataUrl, 'PNG', 0, 0, pdfW, pdfH);
  pdf.save(filename);
}

// ─── Capture a single rack in the requested view/theme ────────────────────────
// Returns { dataUrl, cssW, cssH }
async function captureSingle(rackId, { format, view, theme, scale }) {
  const enclosure = document.getElementById(`rack-${rackId}`);
  if (!enclosure) return null;
  const frame = enclosure.querySelector('.rack-dual-frame');
  if (!frame) return null;

  const themeClass = theme === 'light' ? ['rack-capture-light'] : [];
  const capFn = captureFnFor(format);
  const bg = bgFor(theme);

  if (view === 'stacked') {
    const frontResult = await withClasses(enclosure, ['rack-capture-front-only', ...themeClass], async () => {
      const w = frame.offsetWidth;
      const h = frame.offsetHeight;
      const dataUrl = await toPng(frame, { backgroundColor: bg, pixelRatio: scale, width: w, height: h });
      return { dataUrl, cssW: w, cssH: h };
    });

    const rearResult = await withClasses(enclosure, ['rack-capture-rear-only', ...themeClass], async () => {
      const w = frame.offsetWidth;
      const h = frame.offsetHeight;
      const dataUrl = await toPng(frame, { backgroundColor: bg, pixelRatio: scale, width: w, height: h });
      return { dataUrl, cssW: w, cssH: h };
    });

    const STACK_GAP = Math.round(16 * scale);
    const totalW = Math.max(frontResult.cssW, rearResult.cssW) * scale;
    const totalH = (frontResult.cssH + rearResult.cssH) * scale + STACK_GAP;

    const canvas = document.createElement('canvas');
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, totalW, totalH);

    const [frontImg, rearImg] = await Promise.all([loadImage(frontResult.dataUrl), loadImage(rearResult.dataUrl)]);
    ctx.drawImage(frontImg, 0, 0, frontResult.cssW * scale, frontResult.cssH * scale);
    ctx.drawImage(rearImg, 0, frontResult.cssH * scale + STACK_GAP, rearResult.cssW * scale, rearResult.cssH * scale);

    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return { dataUrl: canvas.toDataURL(mime, 0.95), cssW: totalW / scale, cssH: totalH / scale };
  }

  const viewClass =
    view === 'front-only' ? ['rack-capture-front-only'] :
    view === 'rear-only'  ? ['rack-capture-rear-only']  : [];

  return withClasses(enclosure, [...viewClass, ...themeClass], async () => {
    const w = frame.offsetWidth;
    const h = frame.offsetHeight;
    const dataUrl = await capFn(frame, { backgroundColor: bg, pixelRatio: scale, width: w, height: h });
    return { dataUrl, cssW: w, cssH: h };
  });
}

// ─── Composite multiple rack captures side-by-side ────────────────────────────
// Returns { dataUrl, cssW, cssH }
async function compositeRacks(captures, { theme, scale, format }) {
  const valid = captures.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];

  const GAP = 48;
  const PAD = 32;
  const totalCssW = valid.reduce((sum, c) => sum + c.cssW, 0) + GAP * (valid.length - 1) + PAD * 2;
  const maxCssH = Math.max(...valid.map((c) => c.cssH));
  const totalCssH = maxCssH + PAD * 2;

  const canvas = document.createElement('canvas');
  canvas.width = totalCssW * scale;
  canvas.height = totalCssH * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = bgFor(theme);
  ctx.fillRect(0, 0, totalCssW, totalCssH);

  const imgs = await Promise.all(valid.map((c) => loadImage(c.dataUrl)));
  let x = PAD;
  for (let i = 0; i < valid.length; i++) {
    const y = PAD + Math.floor((maxCssH - valid[i].cssH) / 2);
    ctx.drawImage(imgs[i], x, y, valid[i].cssW, valid[i].cssH);
    x += valid[i].cssW + GAP;
  }

  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return { dataUrl: canvas.toDataURL(mime, 0.95), cssW: totalCssW, cssH: totalCssH };
}

// ─── Composite a legend panel to the top-right of the rack image ──────────────
// Returns { dataUrl, cssW, cssH } with updated (expanded) dimensions.
async function compositeWithLegend(dataUrl, cssW, cssH, slots, { theme, scale }) {
  // Build unique device-type entries (skip blanks, one per type)
  const seen = new Map();
  for (const s of slots) {
    if (s.item_type === 'blank') continue;
    const type = resolveRenderType(s);
    if (!seen.has(type)) {
      const color = CATEGORY_CONFIG[type] || CATEGORY_CONFIG.other;
      const label = TYPE_LABELS[type] || 'Device';
      seen.set(type, { color, label, uSize: s.u_size });
    }
  }

  const items = [...seen.values()];
  if (items.length === 0) return { dataUrl, cssW, cssH };

  // Legend panel dimensions (CSS px)
  const LEG_W    = 168;  // legend panel width
  const LEG_GAP  = 20;   // gap between rack image and legend panel
  const SWATCH   = 11;   // colored swatch size
  const ROW_H    = 20;   // height per entry row
  const HEADER_H = 22;   // "LEGEND" header row
  const LEG_PADV = 10;   // top/bottom padding inside panel
  const LEG_PADH = 12;   // left/right padding inside panel
  const FONT_SZ  = 10;

  const legContentH = LEG_PADV * 2 + HEADER_H + items.length * ROW_H;
  const TOP_OFFSET  = 20;  // drop legend 20px from top so it doesn't crowd the rack name

  const totalCssW = cssW + LEG_GAP + LEG_W;
  const totalCssH = Math.max(cssH, TOP_OFFSET + legContentH + 24);

  const physW = totalCssW * scale;
  const physH = totalCssH * scale;
  const s = scale; // shorthand

  const canvas = document.createElement('canvas');
  canvas.width = physW;
  canvas.height = physH;
  const ctx = canvas.getContext('2d');

  // Background fill
  ctx.fillStyle = bgFor(theme);
  ctx.fillRect(0, 0, physW, physH);

  // Rack image — centered vertically on left side
  const rackOffsetY = Math.floor((totalCssH - cssH) / 2);
  const mainImg = await loadImage(dataUrl);
  ctx.drawImage(mainImg, 0, rackOffsetY * s, cssW * s, cssH * s);

  // Legend panel
  const legPanelX = (cssW + LEG_GAP) * s;
  const legPanelY = TOP_OFFSET * s;
  const legPanelW = LEG_W * s;
  const legPanelH = legContentH * s;

  const panelBg  = theme === 'light' ? 'rgba(200,210,225,0.55)' : 'rgba(26,28,36,0.96)';
  const panelBrd = theme === 'light' ? '#a8b4c4' : '#2a2e38';

  ctx.fillStyle = panelBg;
  roundRect(ctx, legPanelX, legPanelY, legPanelW, legPanelH, 6 * s);
  ctx.fill();
  ctx.strokeStyle = panelBrd;
  ctx.lineWidth = 1 * s;
  roundRect(ctx, legPanelX, legPanelY, legPanelW, legPanelH, 6 * s);
  ctx.stroke();

  // "LEGEND" header text
  const hdrColor  = theme === 'light' ? '#607080' : '#6b7280';
  const sepColor  = theme === 'light' ? '#a8b4c4' : '#2a2e38';
  const txtColor  = theme === 'light' ? '#263040' : '#d4d8e0';

  ctx.fillStyle = hdrColor;
  ctx.font = `bold ${Math.round(8 * s)}px monospace`;
  ctx.fillText('LEGEND', legPanelX + LEG_PADH * s, legPanelY + (LEG_PADV + 12) * s);

  // Header separator line
  ctx.fillStyle = sepColor;
  ctx.fillRect(
    legPanelX + LEG_PADH * s,
    legPanelY + (LEG_PADV + HEADER_H - 2) * s,
    (LEG_W - LEG_PADH * 2) * s,
    Math.max(1, Math.round(s)),
  );

  // Entry rows
  ctx.font = `${Math.round(FONT_SZ * s)}px monospace`;

  for (let i = 0; i < items.length; i++) {
    const { color, label, uSize } = items[i];
    const rowTop = legPanelY + (LEG_PADV + HEADER_H + i * ROW_H) * s;
    const rowMid = rowTop + (ROW_H / 2) * s;
    const swX    = legPanelX + LEG_PADH * s;
    const swY    = rowMid - (SWATCH / 2) * s;

    // Colored swatch
    ctx.fillStyle = color;
    roundRect(ctx, swX, swY, SWATCH * s, SWATCH * s, 3 * s);
    ctx.fill();

    // Label "(NNU)"
    const fullLabel = `${label} (${uSize}U)`;
    ctx.fillStyle = txtColor;
    // Truncate if too long for the panel
    let text = fullLabel;
    const maxW = (LEG_W - LEG_PADH * 2 - SWATCH - 8) * s;
    while (text.length > 4 && ctx.measureText(text).width > maxW) text = text.slice(0, -1);
    if (text !== fullLabel) text += '…';
    ctx.fillText(text, swX + (SWATCH + 7) * s, rowMid + 4 * s);
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
        s.custom_type || s.device_type || s.item_type || '',
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

async function performExport(targetRacks, allSlots, { format, view, theme, includeLegend }) {
  if (format === 'csv') { downloadCsv(targetRacks, allSlots); return; }

  const scale = EXPORT_SCALE;
  let result;

  if (targetRacks.length === 1) {
    result = await captureSingle(targetRacks[0].id, { format, view, theme, scale });
  } else {
    const singles = await Promise.all(
      targetRacks.map((r) => captureSingle(r.id, {
        format: view === 'stacked' ? 'png' : format,
        view,
        theme,
        scale,
      }))
    );
    result = await compositeRacks(singles, { theme, scale, format });
  }

  if (!result) return;

  let { dataUrl, cssW, cssH } = result;

  if (includeLegend && format !== 'svg') {
    const slots = allSlots.filter((s) => targetRacks.some((r) => r.id === s.rack_id));
    const legResult = await compositeWithLegend(dataUrl, cssW, cssH, slots, { theme, scale });
    ({ dataUrl, cssW, cssH } = legResult);
  }

  const filename = targetRacks.length === 1
    ? `rack-${rackFilename(targetRacks[0].name)}`
    : 'racks-export';

  if (format === 'pdf') {
    makePdf(dataUrl, cssW * scale, cssH * scale, `${filename}.pdf`);
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

export default function ExportModal({ targetRacks, allSlots, onClose }) {
  const [format, setFormat] = useState('png');
  const [view, setView] = useState('side-by-side');
  const [theme, setTheme] = useState('dark');
  const [includeLegend, setIncludeLegend] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const isVisual = ['png', 'jpeg', 'svg', 'pdf'].includes(format);
  const isSingle = targetRacks.length === 1;
  const title = isSingle ? `Export — ${targetRacks[0]?.name}` : `Export All Racks (${targetRacks.length})`;

  const generatePreview = useCallback(async ({ format: f, view: v, theme: t, includeLegend: il }) => {
    if (!['png', 'jpeg', 'svg', 'pdf'].includes(f)) { setPreviewUrl(null); return; }
    setPreviewLoading(true);
    setPreviewError(false);
    try {
      const previewFormat = f === 'svg' ? 'svg' : 'png';
      let result;
      if (targetRacks.length === 1) {
        result = await captureSingle(targetRacks[0].id, { format: previewFormat, view: v, theme: t, scale: PREVIEW_SCALE });
      } else {
        const singles = await Promise.all(
          targetRacks.map((r) => captureSingle(r.id, { format: previewFormat, view: v, theme: t, scale: PREVIEW_SCALE }))
        );
        result = await compositeRacks(singles, { theme: t, scale: PREVIEW_SCALE, format: previewFormat });
      }
      if (!result) { setPreviewError(true); return; }

      let { dataUrl, cssW, cssH } = result;
      if (il) {
        const slots = allSlots.filter((s) => targetRacks.some((r) => r.id === s.rack_id));
        const legResult = await compositeWithLegend(dataUrl, cssW, cssH, slots, { theme: t, scale: PREVIEW_SCALE });
        dataUrl = legResult.dataUrl;
      }
      setPreviewUrl(dataUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Export preview failed', err);
      setPreviewError(true);
    } finally {
      setPreviewLoading(false);
    }
  }, [targetRacks, allSlots]);

  useEffect(() => {
    if (!isVisual) { setPreviewUrl(null); return; }
    setPreviewLoading(true);
    const timer = setTimeout(() => generatePreview({ format, view, theme, includeLegend }), PREVIEW_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [format, view, theme, includeLegend, isVisual, generatePreview]);

  const handleExport = async () => {
    setExporting(true);
    try {
      await performExport(targetRacks, allSlots, { format, view, theme, includeLegend });
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
                  <option value="stacked">Stacked (Front then Rear)</option>
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
