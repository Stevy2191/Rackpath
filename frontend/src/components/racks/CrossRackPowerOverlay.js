import React, { useEffect, useState } from 'react';

// Draws a curved power-cord line between a vertical PDU and its UPS when
// they're in DIFFERENT racks — same-rack connections are already drawn by
// each RackEnclosure's own SVG (rack-power-cords), which is necessarily
// scoped to that one rack's frame and can't reach into a neighbor's. This
// overlay instead measures the ACTUAL rendered DOM positions of the PDU's
// strip (data-pdu-id) and the UPS's device block (data-slot-id) — rather
// than recomputing each rack's internal layout math from outside — so it
// stays correct regardless of how either rack is laid out, and naturally
// inherits the canvas's own pan/zoom transform since it renders as a
// sibling inside the same transformed `.rack-canvas-content` container.
function buildCurve(x1, y1, x2, y2) {
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const sag = Math.min(70, Math.max(20, dist * 0.15));
  const c1x = x1 + (x2 - x1) / 3;
  const c2x = x1 + (x2 - x1) * 2 / 3;
  const lowY = Math.max(y1, y2) + sag;
  return { x1, y1, c1x, c1y: lowY, c2x, c2y: lowY, x2, y2 };
}

function pathD(c) {
  return `M ${c.x1} ${c.y1} C ${c.c1x} ${c.c1y}, ${c.c2x} ${c.c2y}, ${c.x2} ${c.y2}`;
}

export default function CrossRackPowerOverlay({ allSlots, contentRef, vp, enabled }) {
  const [lines, setLines] = useState([]);

  useEffect(() => {
    if (!enabled) { setLines([]); return undefined; }
    const contentEl = contentRef.current;
    if (!contentEl) return undefined;

    const measure = () => {
      const contentRect = contentEl.getBoundingClientRect();
      const toLocal = (clientX, clientY) => ({
        x: (clientX - contentRect.left) / vp.zoom,
        y: (clientY - contentRect.top) / vp.zoom,
      });

      const verticalPdus = allSlots.filter((s) => s.item_type === 'vertical-pdu' && s.power_source_slot_id);
      const next = [];
      for (const pdu of verticalPdus) {
        const ups = allSlots.find((s) => s.id === pdu.power_source_slot_id);
        // Same-rack connections are RackEnclosure's job, not this overlay's.
        if (!ups || ups.rack_id === pdu.rack_id) continue;

        const pduEl = contentEl.querySelector(`[data-pdu-id="${pdu.id}"]`);
        const upsEl = contentEl.querySelector(`[data-slot-id="${ups.id}"]`);
        if (!pduEl || !upsEl) continue; // either rack scrolled out / not rendered

        const pduRect = pduEl.getBoundingClientRect();
        const upsRect = upsEl.getBoundingClientRect();
        const pduPoint = toLocal(pduRect.left + pduRect.width / 2, pduRect.bottom);
        const upsPoint = toLocal(upsRect.left + upsRect.width / 2, upsRect.bottom);

        const curve = buildCurve(pduPoint.x, pduPoint.y, upsPoint.x, upsPoint.y);
        const side = pdu.mount_side === 'right' ? 'right' : 'left';
        const upsLabel = ups.item_label || ups.hostname || 'UPS';
        const pduLabel = pdu.item_label || 'PDU';

        next.push({
          key: pdu.id,
          d: pathD(curve),
          side,
          label: `${pduLabel} → ${upsLabel}`,
          labelX: (curve.c1x + curve.c2x) / 2,
          labelY: curve.c1y,
        });
      }
      setLines(next);
    };

    // Runs after the current paint so freshly-changed DOM (a rack added/
    // moved/resized, a device repositioned) is measured correctly rather
    // than from stale positions.
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, allSlots, vp, contentRef]);

  if (!enabled || lines.length === 0) return null;

  return (
    <svg className="cross-rack-power-overlay" overflow="visible">
      {lines.map((line) => (
        <g key={line.key} className={`cross-rack-power-line cross-rack-power-line-${line.side}`}>
          <path d={line.d} className="cross-rack-power-line-glow" fill="none" />
          <path d={line.d} className="cross-rack-power-line-stroke" fill="none" />
          <text x={line.labelX} y={line.labelY - 4} className="cross-rack-power-line-label" textAnchor="middle">
            {line.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
