import React, { useEffect, useState } from 'react';

// Identical values to RackEnclosure's same-rack cord animation so cross-rack
// cords pulse at exactly the same rate and trail shape.
const CORD_PULSE_DUR = 2.4;
const CORD_PULSE_TRAIL = [
  { delay: 0.07, r: 1.3, opacity: 0.5 },
  { delay: 0.14, r: 1.0, opacity: 0.32 },
  { delay: 0.21, r: 0.7, opacity: 0.18 },
  { delay: 0.28, r: 0.45, opacity: 0.09 },
];

// Identical bezier-shape logic to verticalPduLayout.buildCordCurve — the cord
// leaves the UPS at a shallow angle, droops to a single low point (like a real
// cable under its own weight), then rises steeply into the PDU tip.
function buildCordCurve(upsX, upsY, pduX, pduY, outward) {
  const dist = Math.hypot(pduX - upsX, pduY - upsY);
  const reach = Math.max(10, Math.min(40, dist * 0.3));
  const droop = Math.max(16, Math.min(48, dist * 0.24));
  const lowY = Math.max(upsY, pduY) + droop;

  const c1x = upsX + outward * reach * 0.4;
  const c1y = (upsY + lowY) / 2;
  const c2x = pduX + outward * reach;
  const c2y = lowY;

  return `M ${upsX} ${upsY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${pduX} ${pduY}`;
}

// Draws power cords for vertical PDUs whose UPS is in a DIFFERENT rack.
// Same-rack connections are RackEnclosure's job. This overlay lives as a
// sibling inside rack-canvas-content (inside the pan/zoom transform), so
// coordinates are in the same local space as the racks themselves — no
// extra zoom correction needed.
export default function CrossRackPowerOverlay({ allSlots, contentRef, vp, enabled }) {
  const [cords, setCords] = useState([]);
  const [reduceMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );

  useEffect(() => {
    if (!enabled) { setCords([]); return undefined; }
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
        // Same-rack connections are RackEnclosure's responsibility.
        if (!ups || ups.rack_id === pdu.rack_id) continue;

        const pduEl = contentEl.querySelector(`[data-pdu-id="${pdu.id}"]`);
        const upsEl = contentEl.querySelector(`[data-slot-id="${ups.id}"]`);
        if (!pduEl || !upsEl) continue;

        const pduRect = pduEl.getBoundingClientRect();
        const upsRect = upsEl.getBoundingClientRect();

        // PDU anchor: bottom-center of the floating strip (same as
        // verticalPduLayout: pduX = leftPx + STRIP_WIDTH/2, pduY = pduBottomY).
        const pduClientMidX = pduRect.left + pduRect.width / 2;
        const pduPoint = toLocal(pduClientMidX, pduRect.bottom);

        // UPS anchor: the EDGE of the UPS device block that faces the PDU's
        // rack — mirrors the same-rack code's upsX = 0 (left edge of Front)
        // or upsX = frontWidth (right edge of Front) rather than using the
        // UPS block's center, so the curve exits from the rack boundary.
        const upsClientMidX = upsRect.left + upsRect.width / 2;
        const pduIsLeft = pduClientMidX < upsClientMidX;
        const upsEdgeClientX = pduIsLeft ? upsRect.left : upsRect.right;
        const upsPoint = toLocal(upsEdgeClientX, upsRect.bottom);

        // outward: which direction "away from the UPS's rack" is, so the
        // bezier bows toward the inter-rack space instead of through the rack.
        const outward = pduIsLeft ? -1 : 1;

        const d = buildCordCurve(upsPoint.x, upsPoint.y, pduPoint.x, pduPoint.y, outward);
        next.push({ key: pdu.id, d });
      }
      setCords(next);
    };

    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, allSlots, vp, contentRef]);

  if (!enabled || cords.length === 0) return null;

  return (
    <svg className="cross-rack-power-overlay" overflow="visible">
      {cords.map((cord) => (
        <g key={cord.key}>
          {/* Glow: wide blurred stroke — inline attrs so export capture keeps them */}
          <path
            d={cord.d}
            stroke="#f59e0b"
            strokeWidth={7}
            fill="none"
            opacity={0.28}
            style={{ filter: 'blur(2px)' }}
          />
          {/* Cord: solid line matching same-rack style */}
          <path d={cord.d} stroke="#f59e0b" strokeWidth={2} fill="none" />
          {/* Traveling pulse + comet trail — skipped when OS prefers reduced motion */}
          {!reduceMotion && (
            <>
              {CORD_PULSE_TRAIL.map((t, i) => (
                <g key={i}>
                  <animateMotion
                    dur={`${CORD_PULSE_DUR}s`}
                    begin={`${t.delay}s`}
                    repeatCount="indefinite"
                    path={cord.d}
                  />
                  <circle r={t.r} fill="#fbbf24" opacity={t.opacity} />
                </g>
              ))}
              <g>
                <animateMotion dur={`${CORD_PULSE_DUR}s`} repeatCount="indefinite" path={cord.d} />
                <circle r={3.6} fill="#fbbf24" opacity={0.35} />
                <circle r={1.6} fill="#ffe3a3" />
              </g>
            </>
          )}
        </g>
      ))}
    </svg>
  );
}
