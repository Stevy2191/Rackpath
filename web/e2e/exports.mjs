// PDF reports, the bill of materials, CSV downloads and QR short links.
// Runs after moves.mjs (HQ is now in project OTHER).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

export default function (test, { base, allow }) {
  const s = {};
  const call = async (page, method, path) => {
    const r = await page.request[method](base + path);
    assert.ok(r.ok(), `${method} ${path}: ${r.status()}`);
    return r.json();
  };

  test('a rack’s PDF report and bill of materials', async (page) => {
    s.pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'OTHER').id;
    s.rack = (await call(page, 'get', `/api/projects/${s.pid}/places`)).find((p) => p.kind === 'rack' && p.path.endsWith('/RK02'));
    await page.goto(`${base}/p/${s.pid}/racks/${s.rack.id}`);
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PDF report' }).click()]);
    assert.equal(pdf.suggestedFilename(), 'rackpath-OTHER-HQ-F1-SR1-RK02.pdf');
    assert.ok(readFileSync(await pdf.path()).subarray(0, 5).toString() === '%PDF-');

    await page.getByRole('button', { name: 'Bill of materials' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('cell', { name: 'Patch panel' }).waitFor();
    assert.match(await dlg.innerText(), /SW20/);
    const [csv] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'CSV' }).click()]);
    assert.match(readFileSync(await csv.path(), 'utf8'), /^item,quantity,/);
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
  });

  test('devices CSV from the devices list', async (page) => {
    await page.goto(`${base}/p/${s.pid}/devices`);
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Devices CSV' }).click()]);
    assert.equal(csv.suggestedFilename(), 'rackpath-OTHER-devices.csv');
    const text = readFileSync(await csv.path(), 'utf8');
    assert.match(text, /^code,path,type,/);
    assert.match(text, /SW20,OTHER\/HQ\/F1\/SR1\/RK02\/SW20,Switch/);
  });

  test('a QR short link opens the page it names', async (page) => {
    await page.goto(`${base}/r/rack/${s.rack.id}`);
    await page.waitForURL(new RegExp(`/p/${s.pid}/racks/${s.rack.id}$`));
    await page.getByRole('heading', { level: 1, name: /RK02/ }).waitFor();
    allow(/\/api\/resolve\/device\/999999$/);
    await page.goto(`${base}/r/device/999999`);
    await page.getByText('Not found').waitFor();
  });
}
