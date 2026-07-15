import React, { useState } from 'react';
import { X, Zap } from 'lucide-react';
import { computeVerticalPduPositions } from './rackPlacement';
import './UPSPowerSummary.css';

const SIDE_LABELS = { left: 'Left Rail', right: 'Right Rail' };

function fmtRuntime(min) {
  if (min == null) return '—';
  const n = Number(min);
  if (!n && n !== 0) return '—';
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

function fmtNum(n) {
  if (n == null || n === '') return '—';
  const v = Number(n);
  return v ? v.toLocaleString() : '—';
}

function interpolateCurve(curve, targetWatts) {
  if (!curve || curve.length === 0) return null;
  const sorted = [...curve].sort((a, b) => a.load_watts - b.load_watts);
  if (targetWatts <= sorted[0].load_watts) return sorted[0].runtime_minutes;
  if (targetWatts >= sorted[sorted.length - 1].load_watts) return sorted[sorted.length - 1].runtime_minutes;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (targetWatts >= sorted[i].load_watts && targetWatts <= sorted[i + 1].load_watts) {
      const t = (targetWatts - sorted[i].load_watts) / (sorted[i + 1].load_watts - sorted[i].load_watts);
      return Math.round(sorted[i].runtime_minutes + t * (sorted[i + 1].runtime_minutes - sorted[i].runtime_minutes));
    }
  }
  return null;
}

function interpolateEbmCurve(curve, targetWatts) {
  if (!curve || curve.length === 0) return 0;
  const sorted = [...curve].sort((a, b) => a.load_watts - b.load_watts);
  if (targetWatts <= sorted[0].load_watts) return sorted[0].added_runtime_minutes;
  if (targetWatts >= sorted[sorted.length - 1].load_watts) return sorted[sorted.length - 1].added_runtime_minutes;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (targetWatts >= sorted[i].load_watts && targetWatts <= sorted[i + 1].load_watts) {
      const t = (targetWatts - sorted[i].load_watts) / (sorted[i + 1].load_watts - sorted[i].load_watts);
      return Math.round(sorted[i].added_runtime_minutes + t * (sorted[i + 1].added_runtime_minutes - sorted[i].added_runtime_minutes));
    }
  }
  return 0;
}

function Sparkline({ curve, ebmCurves, wattRating, currentLoadPct }) {
  if (!curve || curve.length < 2 || !wattRating) return null;
  const W = 100;
  const H = 36;
  const PAD = 2;

  const points = [];
  for (let pct = 0; pct <= 100; pct += 5) {
    const watts = (pct / 100) * wattRating;
    const base = interpolateCurve(curve, watts) ?? 0;
    const ebmAdd = (ebmCurves || []).reduce((sum, ec) => sum + interpolateEbmCurve(ec, watts), 0);
    points.push({ pct, runtime: base + ebmAdd });
  }

  const maxRuntime = Math.max(...points.map((p) => p.runtime), 1);
  const toX = (pct) => PAD + (pct / 100) * (W - PAD * 2);
  const toY = (rt) => H - PAD - (rt / maxRuntime) * (H - PAD * 2);

  const polyPoints = points.map((p) => `${toX(p.pct)},${toY(p.runtime)}`).join(' ');

  const cx = toX(currentLoadPct);
  const currentWatts = (currentLoadPct / 100) * wattRating;
  const currentBase = interpolateCurve(curve, currentWatts) ?? 0;
  const currentEbm = (ebmCurves || []).reduce((sum, ec) => sum + interpolateEbmCurve(ec, currentWatts), 0);
  const cy = toY(currentBase + currentEbm);

  return (
    <svg width={W} height={H} className="ups-sparkline">
      <polyline
        points={polyPoints}
        fill="none"
        stroke="var(--rack-accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx={cx} cy={cy} r="3" fill="var(--rack-accent)" />
    </svg>
  );
}

function deviceLabel(s) {
  return s.item_label || s.hostname || `Slot ${s.id}`;
}

export default function UPSPowerSummary({ rack, racks, allSlots, onClose }) {
  const [loadPct, setLoadPct] = useState(50);

  const rackSlots = allSlots.filter((s) => s.rack_id === rack.id);
  const upsDevices = rackSlots.filter((s) => s.device_type === 'ups');
  const ebmDevices = rackSlots.filter((s) => s.device_type === 'ebm');

  const verticalPdus = rackSlots.filter((s) => s.item_type === 'vertical-pdu');
  const pduSides = computeVerticalPduPositions(verticalPdus);
  const pduConnections = verticalPdus.map((pdu) => {
    const ups = pdu.power_source_slot_id ? allSlots.find((s) => s.id === pdu.power_source_slot_id) : null;
    const upsRack = ups ? (racks || []).find((r) => r.id === ups.rack_id) : null;
    const crossRack = Boolean(ups) && ups.rack_id !== rack.id;
    return { pdu, side: pduSides.get(pdu.id)?.side || 'left', ups, upsRackName: upsRack?.name || null, crossRack };
  });

  const upsRows = upsDevices.map((ups) => {
    const wattRating = Number(ups.ups_watt_rating) || null;
    const targetWatts = wattRating ? (loadPct / 100) * wattRating : null;
    const connectedEbms = ebmDevices.filter((e) => e.ebm_connected_ups_id === ups.id);

    const baseRuntime = (ups.runtime_curve && targetWatts != null)
      ? interpolateCurve(ups.runtime_curve, targetWatts)
      : null;

    const ebmAdded = connectedEbms.reduce((sum, e) => {
      if (!e.ebm_runtime_curve || targetWatts == null) return sum;
      return sum + interpolateEbmCurve(e.ebm_runtime_curve, targetWatts);
    }, 0);

    const totalRuntime = baseRuntime != null ? baseRuntime + ebmAdded : null;
    const ebmCurves = connectedEbms.map((e) => e.ebm_runtime_curve).filter(Boolean);

    return { ups, connectedEbms, wattRating, targetWatts, baseRuntime, ebmAdded, totalRuntime, ebmCurves };
  });

  const totalVA = upsDevices.reduce((s, u) => s + (Number(u.ups_va_rating) || 0), 0) || null;
  const totalW  = upsDevices.reduce((s, u) => s + (Number(u.ups_watt_rating) || 0), 0) || null;

  const estRuntimes = upsRows.map((r) => r.totalRuntime).filter((v) => v != null);
  const minRuntime = estRuntimes.length > 0 ? Math.min(...estRuntimes) : null;

  const sortedByVA = [...upsDevices].sort((a, b) => (Number(b.ups_va_rating) || 0) - (Number(a.ups_va_rating) || 0));
  const largestVA = Number(sortedByVA[0]?.ups_va_rating) || 0;
  const largestW  = Number(sortedByVA[0]?.ups_watt_rating) || 0;
  const redundantVA = totalVA != null ? totalVA - largestVA : null;
  const redundantW  = totalW  != null ? totalW  - largestW  : null;

  const currentTotalW = totalW ? Math.round((loadPct / 100) * totalW) : null;

  return (
    <div className="ups-summary-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ups-summary-modal">
        <div className="ups-summary-header">
          <div className="ups-summary-title">
            <Zap size={16} />
            <span>UPS Power Summary — {rack.name}</span>
          </div>
          <button type="button" className="ups-summary-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="ups-summary-body">
          {upsDevices.length === 0 && verticalPdus.length === 0 ? (
            <div className="ups-summary-empty">
              No UPS devices found in this rack. Add a UPS device and set its Device Type to "UPS" in the properties panel, then fill in the Power Capacity fields.
            </div>
          ) : (
            <>
              {upsDevices.length === 0 && (
                <div className="ups-summary-empty">No UPS devices found in this rack.</div>
              )}

              {upsRows.map(({ ups, connectedEbms, wattRating, targetWatts, baseRuntime, ebmAdded, totalRuntime, ebmCurves }) => {
                const hasEbms = connectedEbms.length > 0;
                return (
                  <div key={ups.id} className="ups-summary-block">
                    <div className="ups-summary-ups-name">{deviceLabel(ups)}</div>
                    <div className="ups-summary-spec-row">
                      <div className="ups-summary-spec">
                        <span className="ups-summary-spec-label">VA Rating</span>
                        <span className="ups-summary-spec-value">{fmtNum(ups.ups_va_rating)} VA</span>
                      </div>
                      <div className="ups-summary-spec">
                        <span className="ups-summary-spec-label">Watt Rating</span>
                        <span className="ups-summary-spec-value">{fmtNum(ups.ups_watt_rating)} W</span>
                      </div>
                      <div className="ups-summary-spec">
                        <span className="ups-summary-spec-label">EBMs</span>
                        <span className="ups-summary-spec-value">
                          {connectedEbms.length}
                          {ups.ups_max_ebm_slots ? ` / ${ups.ups_max_ebm_slots}` : ''}
                        </span>
                      </div>
                    </div>

                    {hasEbms && (
                      <div className="ups-summary-ebm-names">
                        {connectedEbms.map((e) => deviceLabel(e)).join(', ')}
                      </div>
                    )}

                    <div className="ups-summary-curve-row">
                      <Sparkline
                        curve={ups.runtime_curve}
                        ebmCurves={ebmCurves}
                        wattRating={wattRating}
                        currentLoadPct={loadPct}
                      />
                      {totalRuntime != null && (
                        <div className="ups-summary-est">
                          <span className="ups-summary-muted">
                            {targetWatts != null ? `${Math.round(targetWatts).toLocaleString()} W` : `${loadPct}%`}
                          </span>
                          <strong>{fmtRuntime(totalRuntime)}</strong>
                          {hasEbms && baseRuntime != null && (
                            <span className="ups-summary-muted">(+{fmtRuntime(ebmAdded)} EBM)</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {verticalPdus.length > 0 && (
                <div className="ups-summary-pdu-section">
                  <div className="ups-summary-totals-label">Vertical PDUs</div>
                  <div className="ups-summary-pdu-list">
                    {pduConnections.map(({ pdu, side, ups, upsRackName, crossRack }) => (
                      <div key={pdu.id} className="ups-summary-pdu-row">
                        <span className="ups-summary-pdu-name">
                          {deviceLabel(pdu)} <span className="ups-summary-muted">({SIDE_LABELS[side]})</span>
                        </span>
                        <span className="ups-summary-pdu-arrow">→</span>
                        <span className="ups-summary-pdu-target">
                          {ups ? (
                            <>
                              {deviceLabel(ups)}
                              {crossRack && upsRackName && (
                                <span className="ups-summary-muted"> in {upsRackName}</span>
                              )}
                            </>
                          ) : (
                            <span className="ups-summary-muted">Not connected</span>
                          )}
                        </span>
                        {crossRack && <span className="ups-summary-cross-rack-badge">Cross-Rack</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {upsDevices.length > 0 && (
                <div className="ups-summary-totals-section">
                  <div className="ups-summary-totals-label">Totals</div>
                  <div className="ups-summary-totals-grid">
                    <div>
                      <div className="ups-summary-tl">Total VA</div>
                      <div className="ups-summary-tv">{totalVA ? totalVA.toLocaleString() : '—'}</div>
                    </div>
                    <div>
                      <div className="ups-summary-tl">Total W</div>
                      <div className="ups-summary-tv">{totalW ? totalW.toLocaleString() : '—'}</div>
                    </div>
                    <div>
                      <div className="ups-summary-tl">UPS Units</div>
                      <div className="ups-summary-tv">{upsDevices.length}</div>
                    </div>
                    <div>
                      <div className="ups-summary-tl">EBMs</div>
                      <div className="ups-summary-tv">{ebmDevices.length}</div>
                    </div>
                  </div>

                  <div className="ups-summary-slider-wrap">
                    <div className="ups-summary-slider-row">
                      <span className="ups-summary-slider-label">Load</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="5"
                        value={loadPct}
                        onChange={(e) => setLoadPct(Number(e.target.value))}
                        className="ups-summary-slider"
                      />
                      <span className="ups-summary-slider-pct">
                        {loadPct}%
                        {currentTotalW != null && (
                          <span className="ups-summary-slider-watts"> ({currentTotalW.toLocaleString()} W)</span>
                        )}
                      </span>
                    </div>
                    {minRuntime != null && (
                      <div className="ups-summary-est-total">
                        Shortest runtime:&nbsp;<strong>{fmtRuntime(minRuntime)}</strong>
                      </div>
                    )}
                  </div>

                  {upsDevices.length >= 2 && (totalVA || totalW) && (
                    <div className="ups-summary-redundancy">
                      <strong>N+1 Redundancy</strong> — capacity with one UPS offline:&nbsp;
                      <span className="ups-summary-redundancy-val">
                        {redundantVA != null ? `${redundantVA.toLocaleString()} VA` : '—'}
                        {' / '}
                        {redundantW != null ? `${redundantW.toLocaleString()} W` : '—'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
