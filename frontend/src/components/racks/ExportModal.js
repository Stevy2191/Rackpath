import React, { useState, useEffect, useCallback } from 'react';
import { toPng, toJpeg, toSvg } from 'html-to-image';
import { jsPDF } from 'jspdf';
import './ExportModal.css';

const EXPORT_SCALE = Math.max(window.devicePixelRatio || 1, 3);
const PREVIEW_SCALE = 1;
const PDF_DPI = 150;
const PREVIEW_DEBOUNCE = 350;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
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

// Capture a single rack in the requested view/theme. Returns { dataUrl, cssW, cssH }.
async function captureSingle(rackId, { format, view, theme, scale }) {
  const enclosure = document.getElementById(`rack-${rackId}`);
  if (!enclosure) return null;

  const frame = enclosure.querySelector('.rack-dual-frame');
  if (!frame) return null;

  const themeClass = theme === 'light' ? ['rack-capture-light'] : [];
  const capFn = captureFnFor(format);
  const bg = bgFor(theme);

  if (view === 'stacked') {
    // Capture front-only then rear-only, composite vertically
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

// Composite multiple rack captures side-by-side. Returns { dataUrl, cssW, cssH }.
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

// Composite a legend strip below the image.
async function compositeWithLegend(dataUrl, cssW, cssH, slots, { theme, scale }) {
  const items = [];
  const seen = new Set();
  for (const s of slots) {
    const color = s.color || '#4a90d9';
    const label = s.item_label || s.hostname || s.custom_type || s.item_type || 'Device';
    const key = color + '|' + label;
    if (!seen.has(key)) { seen.add(key); items.push({ color, label }); }
  }
  if (items.length === 0) return dataUrl;

  const sw = 12;                       // swatch side (CSS px)
  const fontSize = 11;
  const rowH = sw + 4;                 // per legend row height (CSS px)
  const hPad = 16;
  const vPad = 10;
  const colW = 160;
  const cols = Math.max(1, Math.floor(cssW / colW));
  const rows = Math.ceil(items.length / cols);
  const legendCssH = rows * rowH + vPad * 2 + hPad;

  const physW = cssW * scale;
  const physH = cssH * scale;
  const physLegH = legendCssH * scale;

  const canvas = document.createElement('canvas');
  canvas.width = physW;
  canvas.height = physH + physLegH;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = bgFor(theme);
  ctx.fillRect(0, 0, physW, physH + physLegH);

  const mainImg = await loadImage(dataUrl);
  ctx.drawImage(mainImg, 0, 0, physW, physH);

  // Legend background strip
  const stripColor = theme === 'light' ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.03)';
  ctx.fillStyle = stripColor;
  ctx.fillRect(0, physH + hPad * scale / 2, physW, physLegH);

  ctx.font = `${fontSize * scale}px monospace`;
  const textColor = theme === 'light' ? '#405060' : '#c4cad6';

  for (let i = 0; i < items.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = (col * colW + hPad) * scale;
    const y = physH + hPad * scale + row * rowH * scale;

    ctx.fillStyle = items[i].color;
    ctx.fillRect(x, y + 1 * scale, sw * scale, sw * scale);

    ctx.fillStyle = textColor;
    const maxLabelW = colW - sw - hPad - 8;
    let label = items[i].label;
    while (label.length > 3 && ctx.measureText(label).width > maxLabelW * scale) {
      label = label.slice(0, -1);
    }
    if (label !== items[i].label) label += '…';
    ctx.fillText(label, x + (sw + 6) * scale, y + (sw - 1) * scale);
  }

  return canvas.toDataURL('image/png');
}

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
    dataUrl = await compositeWithLegend(dataUrl, cssW, cssH, slots, { theme, scale });
    cssH = cssH + 80; // approximate; not used for PDF with legend (legend adds to physH)
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

  // Generate preview on option change, debounced
  const generatePreview = useCallback(async ({ format: f, view: v, theme: t, includeLegend: il }) => {
    if (!['png', 'jpeg', 'svg', 'pdf'].includes(f)) { setPreviewUrl(null); return; }
    setPreviewLoading(true);
    setPreviewError(false);
    try {
      let result;
      const previewFormat = f === 'svg' ? 'svg' : 'png'; // always PNG for preview except SVG
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
        dataUrl = await compositeWithLegend(dataUrl, cssW, cssH, slots, { theme: t, scale: PREVIEW_SCALE });
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

  // CSV preview: first few rows as table
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

          {/* Preview area */}
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
