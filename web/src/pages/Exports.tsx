// Export buttons, the rack bill of materials, and the short links that
// report QR codes open (/r/{type}/{id}).
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileDown, FileText, ListChecks } from 'lucide-react';
import { api, download } from '../api';
import { Button, Empty, ErrorBox, Modal, Spinner, Table, useLoad, useToast } from '../ui';

export function ReportButton({ type, id, label = 'PDF report' }: { type: string; id: number; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      icon={<FileText size={15} />}
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await download(`/api/export/report?type=${type}&id=${id}`);
        } catch (e) {
          toast.error(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

export function CsvButton({ projectId, table, label }: { projectId: number; table: 'devices' | 'connections' | 'prefixes' | 'addresses'; label?: string }) {
  const toast = useToast();
  return (
    <Button variant="ghost" icon={<FileDown size={15} />} onClick={() => download(`/api/projects/${projectId}/export/${table}`).catch(toast.error)}>
      {label ?? 'CSV'}
    </Button>
  );
}

interface Bom {
  devices: { type: string; manufacturer: string; model: string; quantity: number; codes: string[]; positions: string[] }[];
  cords: { kind: string; cable_type: string | null; length_m: number | null; color: string | null; quantity: number }[];
}

export function BomButton({ rackId }: { rackId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<ListChecks size={15} />} onClick={() => setOpen(true)}>Bill of materials</Button>
      {open && <BomModal rackId={rackId} onClose={() => setOpen(false)} />}
    </>
  );
}

function BomModal({ rackId, onClose }: { rackId: number; onClose: () => void }) {
  const toast = useToast();
  const bom = useLoad(() => api.get<Bom>(`/api/racks/${rackId}/bom`), [rackId]);
  return (
    <Modal
      title="Bill of materials"
      wide
      onClose={onClose}
      footer={
        <>
          <Button icon={<FileDown size={15} />} onClick={() => download(`/api/racks/${rackId}/bom?format=csv`).catch(toast.error)}>CSV</Button>
          <Button icon={<FileText size={15} />} onClick={() => download(`/api/racks/${rackId}/bom?format=pdf`).catch(toast.error)}>PDF</Button>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </>
      }
    >
      <ErrorBox error={bom.error} />
      {!bom.data ? (
        <Spinner />
      ) : (
        <div className="stack">
          <h4 className="form-section">Devices</h4>
          <Table
            rows={bom.data.devices}
            rowKey={(d) => `${d.type}/${d.manufacturer}/${d.model}`}
            empty="No devices"
            columns={[
              { key: 'q', label: 'Qty', render: (d) => d.quantity, className: 'num' },
              { key: 't', label: 'Type', render: (d) => d.type },
              { key: 'm', label: 'Model', render: (d) => [d.manufacturer, d.model].filter(Boolean).join(' ') },
              { key: 'c', label: 'Codes', render: (d) => <span className="mono small">{d.codes.join(' ')}</span> },
              { key: 'p', label: 'Positions', render: (d) => <span className="small">{d.positions.join(' ')}</span> },
            ]}
          />
          <h4 className="form-section">Cords</h4>
          {bom.data.cords.length === 0 ? (
            <p className="small muted">No patch or power cords recorded.</p>
          ) : (
            <Table
              rows={bom.data.cords}
              rowKey={(c) => `${c.kind}/${c.cable_type}/${c.length_m}/${c.color}`}
              columns={[
                { key: 'q', label: 'Qty', render: (c) => c.quantity, className: 'num' },
                { key: 'k', label: 'Kind', render: (c) => (c.kind === 'power' ? 'Power cord' : 'Patch cord') },
                { key: 't', label: 'Type', render: (c) => c.cable_type ?? '—' },
                { key: 'l', label: 'Length', render: (c) => (c.length_m != null ? `${c.length_m} m` : '—') },
                { key: 'c', label: 'Colour', render: (c) => (c.color ? <span className="row"><span className="swatch" style={{ background: c.color }} />{c.color}</span> : '—') },
              ]}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

/** /r/{type}/{id}: where a report's QR code leads. */
export function ShortLink() {
  const { type, id } = useParams();
  const nav = useNavigate();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api.get<{ url: string }>(`/api/resolve/${type}/${id}`).then(
      (r) => nav(r.url, { replace: true }),
      () => setMissing(true),
    );
  }, [type, id, nav]);
  return missing ? <Empty title="Not found">It may have been deleted, or you don't have access to it.</Empty> : <Spinner label="Opening…" />;
}
