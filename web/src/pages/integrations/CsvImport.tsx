// CSV import: checked row by row with the same rules as the API, and
// all-or-nothing. Try it first; nothing is saved unless every row is fine.
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileUp, Play } from 'lucide-react';
import { api, qs } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import { Badge, Button, Card, ErrorBox, PageHeader, SelectField, TextArea, useLoad, useToast } from '../../ui';

interface Result {
  kind: string;
  rows: number;
  dry_run: boolean;
  applied: boolean;
  ok: number;
  errors: { row: number; message: string }[];
}

const KIND_TEXT: Record<string, string> = {
  devices: 'Devices',
  ports: 'Ports',
  connections: 'Cables',
  prefixes: 'Prefixes',
  ranges: 'IP ranges',
  addresses: 'IP addresses',
};

const HINTS: Record<string, string> = {
  devices: 'Place a device with room (HQ/2/MDF) or rack (HQ/2/MDF/RK01) plus u; template names a device template.',
  ports: 'device is the device path, e.g. HQ/2/MDF/RK01/SW01.',
  connections: 'a and b are port paths, e.g. HQ/2/MDF/RK01/SW01/24; kind is patch, permanent or power.',
  prefixes: 'cidr like 10.20.30.0/24; vlan is the VLAN number; location is a location code.',
  ranges: 'prefix is the CIDR it sits in; kind is dhcp_pool, reserved or static.',
  addresses: 'device or port as a path; dns_aliases separated by spaces.',
};

export function CsvImportPage() {
  const { project, canWrite } = useProject();
  const toast = useToast();
  const columns = useLoad(() => api.get<Record<string, string[]>>('/api/import/csv/columns'), []);
  const [kind, setKind] = useState('devices');
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<'try' | 'import' | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const cols = columns.data?.[kind] ?? [];

  const run = async (dry: boolean) => {
    setBusy(dry ? 'try' : 'import');
    try {
      const r = await api.upload<Result>('POST', `/api/projects/${project.id}/import/csv${qs({ kind, dry_run: dry })}`, text, 'text/csv');
      setResult(r);
      if (r.applied) toast.ok(`Imported ${r.ok} row(s)`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const header = () => {
    const blob = new Blob([cols.join(',') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rackpath-${kind}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div>
      <nav className="crumbs"><Link to={link.integrations(project.id)}>Integrations</Link></nav>
      <PageHeader title="Import a CSV file" subtitle="Every row is checked; if any row fails, nothing is saved" />
      <ErrorBox error={columns.error} onRetry={columns.reload} />
      <div className="grid-2">
        <Card title="File">
          <div className="stack">
            <SelectField
              label="What it holds"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setResult(null);
              }}
              options={Object.keys(columns.data ?? KIND_TEXT).map((k) => ({ value: k, label: KIND_TEXT[k] ?? k }))}
            />
            <div className="row">
              <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) {
                  setText(await f.text());
                  setResult(null);
                }
              }} />
              <Button icon={<FileUp size={15} />} onClick={() => file.current?.click()}>Choose file</Button>
              <Button variant="ghost" icon={<Download size={15} />} disabled={!cols.length} onClick={header}>Download an empty file</Button>
            </div>
            <TextArea label="Or paste it" rows={10} className="input mono small" value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} />
            <div className="row">
              <Button icon={<Play size={15} />} busy={busy === 'try'} disabled={!text.trim()} onClick={() => run(true)}>Check it</Button>
              {canWrite && (
                <Button variant="primary" busy={busy === 'import'} disabled={!text.trim() || !result || result.errors.length > 0 || result.applied} onClick={() => run(false)}>
                  Import
                </Button>
              )}
            </div>
          </div>
        </Card>
        <Card title="Columns">
          <p className="small">{HINTS[kind]}</p>
          <div className="row">{cols.map((c) => <code key={c} className="mono small col-name">{c}</code>)}</div>
          <p className="small muted">The first row names the columns, in any order. Columns not listed here are refused. Paths may start with the project code.</p>
        </Card>
      </div>
      {result && (
        <Card title="Result" className="mt">
          <div className="stack">
            <div className="row">
              {result.applied ? <Badge tone="ok">Imported</Badge> : result.errors.length ? <Badge tone="danger">Not imported</Badge> : <Badge tone="info">Ready to import</Badge>}
              <span className="small">{result.ok} of {result.rows} row(s) fine{result.errors.length ? `, ${result.errors.length} with problems` : ''}.</span>
            </div>
            {result.errors.length > 0 && (
              <table className="table small csv-errors">
                <thead><tr><th className="num">Row</th><th>Problem</th></tr></thead>
                <tbody>{result.errors.map((e, i) => <tr key={i}><td className="num">{e.row}</td><td>{e.message}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
