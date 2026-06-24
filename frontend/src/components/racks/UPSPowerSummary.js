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

// Linear interpolation between the (50%, half) and (100%, full) points.
// Extrapolates for loads outside that range.
function interpolate(full, half, loadPct) {
  const f = full != null && full !== '' ? Number(full) : null;
  const h = half != null && half !== '' ? Number(half) : null;
  if (!f || !h) return null;
  const result = h + (f - h) * (loadPct - 50) / 50;
  return Math.round(Math.max(0, result));
}

function deviceLabel(s) {
  return s.item_label || s.hostname || `Slot ${s.id}`;
}

export default function UPSPowerSummary({ rack, racks, allSlots, onClose }) {
  const [loadPct, setLoadPct] = useState(100);

  const rackSlots = allSlots.filter((s) => s.rack_id === rack.id);
  const upsDevices = rackSlots.filter((s) => s.device_type === 'ups');
  const ebmDevices = rackSlots.filter((s) => s.device_type === 'ebm');

  // Every vertical PDU mounted in THIS rack, regardless of which rack its
  // own UPS connection lives in — a PDU here can be wired to a UPS in any
  // rack in the project (see DevicePropertiesPanel's "Connected To"), and
  // that's exactly the case this list calls out with a Cross-Rack badge.
  const verticalPdus = rackSlots.filter((s) => s.item_type === 'vertical-pdu');
  const pduSides = computeVerticalPduPositions(verticalPdus);
  const pduConnections = verticalPdus.map((pdu) => {
    const ups = pdu.power_source_slot_id ? allSlots.find((s) => s.id === pdu.power_source_slot_id) : null;
    const upsRack = ups ? (racks || []).find((r) => r.id === ups.rack_id) : null;
    const crossRack = Boolean(ups) && ups.rack_id !== rack.id;
    return {
      pdu,
      side: pduSides.get(pdu.id)?.side || 'left',
      ups,
      upsRackName: upsRack?.name || null,
      crossRack,
    };
  });

  const upsRows = upsDevices.map((ups) => {
    const connectedEbms = ebmDevices.filter((e) => e.ebm_connected_ups_id === ups.id);
    const ebmFull = connectedEbms.reduce((s, e) => s + (Number(e.ebm_runtime_full) || 0), 0);
    const ebmHalf = connectedEbms.reduce((s, e) => s + (Number(e.ebm_runtime_half) || 0), 0);
    const baseFull = ups.ups_runtime_full != null ? Number(ups.ups_runtime_full) : null;
    const baseHalf = ups.ups_runtime_half != null ? Number(ups.ups_runtime_half) : null;
    const totalFull = baseFull != null ? baseFull + ebmFull : null;
    const totalHalf = baseHalf != null ? baseHalf + ebmHalf : null;
    return { ups, connectedEbms, ebmFull, ebmHalf, baseFull, baseHalf, totalFull, totalHalf };
  });

  const totalVA = upsDevices.reduce((s, u) => s + (Number(u.ups_va_rating) || 0), 0) || null;
  const totalW  = upsDevices.reduce((s, u) => s + (Number(u.ups_watt_rating) || 0), 0) || null;

  const estRuntimes = upsRows
    .map((r) => interpolate(r.totalFull, r.totalHalf, loadPct))
    .filter((v) => v != null);
  const minRuntime = estRuntimes.length > 0 ? Math.min(...estRuntimes) : null;

  // N+1: capacity with the largest UPS removed (worst-case failure)
  const sortedByVA = [...upsDevices].sort(
    (a, b) => (Number(b.ups_va_rating) || 0) - (Number(a.ups_va_rating) || 0)
  );
  const largestVA = Number(sortedByVA[0]?.ups_va_rating) || 0;
  const largestW  = Number(sortedByVA[0]?.ups_watt_rating) || 0;
  const redundantVA = totalVA != null ? totalVA - largestVA : null;
  const redundantW  = totalW  != null ? totalW  - largestW  : null;

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
                <div className="ups-summary-empty">
                  No UPS devices found in this rack.
                </div>
              )}

              {upsRows.map(({ ups, connectedEbms, ebmFull, ebmHalf, baseFull, baseHalf, totalFull, totalHalf }) => {
                const estRuntime = interpolate(totalFull, totalHalf, loadPct);
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

                    <div className="ups-summary-runtime-grid">
                      <div className="ups-summary-runtime-col">
                        <div className="ups-summary-runtime-header">Base Runtime</div>
                        <div className="ups-summary-runtime-row">
                          <span>{fmtRuntime(baseFull)}</span>
                          <span className="ups-summary-muted">@ 100%</span>
                        </div>
                        <div className="ups-summary-runtime-row">
                          <span>{fmtRuntime(baseHalf)}</span>
                          <span className="ups-summary-muted">@ 50%</span>
                        </div>
                      </div>
                      {hasEbms && (
                        <div className="ups-summary-runtime-col">
                          <div className="ups-summary-runtime-header">+ EBMs</div>
                          <div className="ups-summary-runtime-row">
                            <span>+{fmtRuntime(ebmFull)}</span>
                            <span className="ups-summary-muted">@ 100%</span>
                          </div>
                          <div className="ups-summary-runtime-row">
                            <span>+{fmtRuntime(ebmHalf)}</span>
                            <span className="ups-summary-muted">@ 50%</span>
                          </div>
                        </div>
                      )}
                      <div className="ups-summary-runtime-col ups-summary-runtime-total">
                        <div className="ups-summary-runtime-header">
                          {hasEbms ? 'Total Runtime' : 'Runtime'}
                        </div>
                        <div className="ups-summary-runtime-row">
                          <span>{fmtRuntime(totalFull)}</span>
                          <span className="ups-summary-muted">@ 100%</span>
                        </div>
                        <div className="ups-summary-runtime-row">
                          <span>{fmtRuntime(totalHalf)}</span>
                          <span className="ups-summary-muted">@ 50%</span>
                        </div>
                      </div>
                    </div>

                    {estRuntime != null && (
                      <div className="ups-summary-est">
                        Est. runtime at {loadPct}% load:&nbsp;<strong>{fmtRuntime(estRuntime)}</strong>
                      </div>
                    )}
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
                    <span className="ups-summary-slider-pct">{loadPct}%</span>
                  </div>
                  {minRuntime != null && (
                    <div className="ups-summary-est-total">
                      Est. shortest runtime at {loadPct}% load:&nbsp;
                      <strong>{fmtRuntime(minRuntime)}</strong>
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
