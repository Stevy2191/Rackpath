// Power: a device's figures (draw, capacity, UPS runtime curves), its
// power ports and cords, and a rack's power summary.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { link } from '../../links';
import type { CurvePoint, DevicePower, PowerSpec, RackPower } from '../../types';
import { Badge, Button, Card, Empty, ErrorBox, FormModal, Spinner, TextField, Warnings, useLoad } from '../../ui';
import { PortsPanel } from '../cabling/PortsPanel';
import { KeyValues, num } from '../places/common';

const w = (v: number | null | undefined) => (v == null ? '—' : `${v} W`);
const pctTone = (p: number | null) => (p == null ? 'neutral' : p > 100 ? 'danger' : p > 80 ? 'warn' : 'ok');
export const minutes = (m: number | null | undefined) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${m} min`);

function CurveEditor({ label, value, onChange }: { label: string; value: CurvePoint[]; onChange: (v: CurvePoint[]) => void }) {
  const set = (i: number, k: keyof CurvePoint, v: string) => onChange(value.map((p, j) => (j === i ? { ...p, [k]: Number(v) } : p)));
  return (
    <fieldset className="curve">
      <legend>{label}</legend>
      {value.map((p, i) => (
        <div key={i} className="row">
          <TextField label="Load (W)" type="number" min={0} value={p.load_w} onChange={(e) => set(i, 'load_w', e.target.value)} />
          <TextField label="Minutes" type="number" min={0} step="any" value={p.minutes} onChange={(e) => set(i, 'minutes', e.target.value)} />
          <Button variant="ghost" aria-label={`Remove point ${i + 1}`} icon={<Trash2 size={14} />} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button variant="ghost" icon={<Plus size={14} />} onClick={() => onChange([...value, { load_w: 0, minutes: 0 }])}>Add point</Button>
    </fieldset>
  );
}

/** The figures, as fields. `kind` decides which ones matter. */
export function PowerFields({ value, onChange, kind }: { value: PowerSpec; onChange: (v: PowerSpec) => void; kind: string }) {
  const set = (k: keyof PowerSpec, v: unknown) => onChange({ ...value, [k]: v });
  const text = (k: keyof PowerSpec) => (value[k] == null ? '' : String(value[k]));
  const ups = kind === 'ups';
  const ebm = kind === 'battery' || kind === 'ebm' || !!value.ebm_runtime_curve?.length;
  const supplier = ups || kind === 'pdu';
  return (
    <div className="stack">
      <div className="grid-3">
        <TextField label="Typical draw (W)" type="number" min={0} value={text('typical_w')} onChange={(e) => set('typical_w', num(e.target.value))} hint="Used for load figures" />
        <TextField label="Maximum draw (W)" type="number" min={0} value={text('max_w')} onChange={(e) => set('max_w', num(e.target.value))} hint="Used when typical isn't known" />
        <TextField label="Input voltage" placeholder="230 V" value={text('input_voltage')} onChange={(e) => set('input_voltage', e.target.value || null)} />
        {supplier && <TextField label="Capacity (VA)" type="number" min={0} value={text('capacity_va')} onChange={(e) => set('capacity_va', num(e.target.value))} />}
        {supplier && <TextField label="Capacity (W)" type="number" min={0} value={text('capacity_w')} onChange={(e) => set('capacity_w', num(e.target.value))} />}
        {ups && <TextField label="Battery module slots" type="number" min={0} value={text('max_ebm_slots')} onChange={(e) => set('max_ebm_slots', num(e.target.value))} />}
      </div>
      {ups && <CurveEditor label="Runtime (minutes at a load)" value={value.runtime_curve ?? []} onChange={(c) => set('runtime_curve', c.length ? c : null)} />}
      {ebm && <CurveEditor label="Minutes this battery module adds at a load" value={value.ebm_runtime_curve ?? []} onChange={(c) => set('ebm_runtime_curve', c.length ? c : null)} />}
    </div>
  );
}

export function DevicePowerPanel({ projectId, deviceId, typeKey, canEdit }: { projectId: number; deviceId: number; typeKey: string; canEdit: boolean }) {
  const power = useLoad(() => api.get<DevicePower>(`/api/devices/${deviceId}/power`), [deviceId]);
  const [editing, setEditing] = useState(false);
  const [spec, setSpec] = useState<PowerSpec>({});
  if (power.error) return <ErrorBox error={power.error} onRetry={power.reload} />;
  if (!power.data) return <Spinner />;
  const p = power.data;
  const supplies = p.power.capacity_w != null || p.outlets.total > 0;
  return (
    <div className="stack">
      <Warnings items={p.warnings} />
      <div className="grid-2">
        <Card
          title="Figures"
          actions={canEdit && <Button variant="ghost" icon={<Pencil size={15} />} onClick={() => { setSpec(p.power); setEditing(true); }}>Edit</Button>}
        >
          <KeyValues
            rows={[
              ['Draw', p.draw_w != null ? `${p.draw_w} W${p.power.typical_w == null ? ' (maximum)' : ''}` : <span className="muted">Not recorded</span>],
              ['Input voltage', p.power.input_voltage],
              ['Capacity', p.power.capacity_w != null || p.power.capacity_va != null ? [p.power.capacity_va != null ? `${p.power.capacity_va} VA` : null, p.power.capacity_w != null ? `${p.power.capacity_w} W` : null].filter(Boolean).join(' / ') : null],
              ['Runtime curve', p.power.runtime_curve?.length ? p.power.runtime_curve.map((c) => `${c.load_w} W → ${c.minutes} min`).join(', ') : null],
              ['Battery module curve', p.power.ebm_runtime_curve?.length ? p.power.ebm_runtime_curve.map((c) => `${c.load_w} W → +${c.minutes} min`).join(', ') : null],
            ]}
          />
        </Card>
        <Card title="Load">
          <KeyValues
            rows={[
              ['Inlets', p.inlets.total ? `${p.inlets.used} of ${p.inlets.total} connected` : null],
              ['Delivers', supplies ? w(p.output_w) : null],
              ['Load', p.load_pct != null ? <Badge tone={pctTone(p.load_pct)}>{p.load_pct}%</Badge> : null],
              ['If the other feed fails', supplies && p.failover_w !== p.output_w ? <>{w(p.failover_w)} {p.failover_pct != null && <Badge tone={pctTone(p.failover_pct)}>{p.failover_pct}%</Badge>}</> : null],
              ['Runtime now', p.runtime_min != null ? minutes(p.runtime_min) : null],
              ['Runtime on failover', p.failover_runtime_min != null && p.failover_runtime_min !== p.runtime_min ? minutes(p.failover_runtime_min) : null],
              ['Battery modules', p.battery_modules.length ? `${p.battery_modules.length}${p.power.max_ebm_slots != null ? ` of ${p.power.max_ebm_slots}` : ''}` : null],
              ['Outlets', p.outlets.total ? `${p.outlets.used} of ${p.outlets.total} used${p.outlets.groups.length > 1 ? ` (${p.outlets.groups.map((g) => `bank ${g.group ?? '–'}: ${g.used}/${g.total}`).join(', ')})` : ''}` : null],
            ]}
          />
        </Card>
      </div>
      <h3 className="form-section">Power ports and cords</h3>
      <PortsPanel projectId={projectId} deviceId={deviceId} canEdit={canEdit} power onChanged={power.reload} />
      {editing && (
        <FormModal
          title="Power figures"
          wide
          onClose={() => setEditing(false)}
          onSubmit={async () => {
            await api.put(`/api/devices/${deviceId}/power`, spec);
            power.reload();
          }}
        >
          <PowerFields value={spec} onChange={setSpec} kind={typeKey} />
        </FormModal>
      )}
    </div>
  );
}

export function RackPowerPanel({ projectId, rackId }: { projectId: number; rackId: number }) {
  const power = useLoad(() => api.get<RackPower>(`/api/racks/${rackId}/power`), [rackId]);
  if (power.error) return <ErrorBox error={power.error} onRetry={power.reload} />;
  if (!power.data) return <Spinner />;
  const r = power.data;
  const t = r.totals;
  if (r.devices.length === 0) return <Empty title="No power recorded in this rack">Add power figures and power ports to its devices, then connect power cords.</Empty>;
  return (
    <div className="stack">
      {r.loop_detected && <Warnings items={['These power cords form a loop; check them.']} />}
      <div className="grid-3">
        <Card title="Draw"><div className="stat">{t.draw_w} W</div></Card>
        {t.ups_count > 0 && (
          <Card title={`UPS capacity (${t.ups_count})`}>
            <div className="stat">{t.ups_capacity_w} W</div>
            {t.ups_redundant_w != null && t.ups_count > 1 && <div className="small muted">{t.ups_redundant_w} W if the largest fails (N+1)</div>}
          </Card>
        )}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th className="num">Draw</th>
              <th className="num">Delivers</th>
              <th>Load</th>
              <th>On failover</th>
              <th>Runtime</th>
              <th>Outlets</th>
              <th>Warnings</th>
            </tr>
          </thead>
          <tbody>
            {r.devices.map((d) => (
              <tr key={d.device_id} data-device={d.code}>
                <td><Link to={`${link.device(projectId, d.device_id)}?tab=power`} className="mono">{d.code}</Link></td>
                <td className="num">{w(d.draw_w)}</td>
                <td className="num">{d.output_w ? w(d.output_w) : '—'}</td>
                <td>{d.load_pct != null ? <Badge tone={pctTone(d.load_pct)}>{d.load_pct}%</Badge> : '—'}</td>
                <td>{d.failover_pct != null && d.failover_w !== d.output_w ? <Badge tone={pctTone(d.failover_pct)}>{d.failover_pct}%</Badge> : '—'}</td>
                <td>{d.runtime_min != null ? minutes(d.runtime_min) : '—'}</td>
                <td>{d.outlets.total ? `${d.outlets.used}/${d.outlets.total}` : '—'}</td>
                <td className="small">{d.warnings.join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
