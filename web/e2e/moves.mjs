// Moves with a preview: a rack whose move would cut a cable (previewed,
// then cancelled), and a whole location moved to another project.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export default function (test, { base, shots }) {
  const snap = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
  const s = {};
  const call = async (page, method, path, data) => {
    const r = await page.request[method](base + path, data ? { data } : undefined);
    assert.ok(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };

  test('moving a rack previews the cable it would cut', async (page) => {
    s.pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'ACME').id;
    const places = await call(page, 'get', `/api/projects/${s.pid}/places`);
    const rack = places.find((p) => p.kind === 'rack' && p.path.endsWith('/RK02'));
    await page.goto(`${base}/p/${s.pid}/racks/${rack.id}`);
    await page.getByRole('button', { name: 'Move' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('To room').selectOption({ label: 'HQ / 0 / DEFAULT' });
    await dlg.locator('.move-preview').waitFor();
    assert.match(await dlg.locator('.move-preview').innerText(), /ACME \/ HQ \/ F1 \/ SR1 \/ RK02\s*→\s*ACME \/ HQ \/ 0 \/ DEFAULT \/ RK02/);
    await dlg.getByText('1 cable(s) are removed').waitFor();
    assert.match(await dlg.locator('.move-preview').innerText(), /PP01.*WO01/s);
    const [csv] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Download the list (CSV)' }).click()]);
    assert.match(readFileSync(await csv.path(), 'utf8'), /^cable removed by the move,from,to\n.*PP01.*WO01/s);
    await snap(page, 'move-preview');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    const after = await call(page, 'get', `/api/racks/${rack.id}`);
    assert.equal(after.path, 'ACME/HQ/F1/SR1/RK02', 'the preview moved nothing');
  });

  test('moving a location to another project', async (page) => {
    const other = await call(page, 'post', '/api/projects', { code: 'OTHER', name: 'Other Co' });
    const hq = (await call(page, 'get', `/api/projects/${s.pid}/locations`)).find((l) => l.code === 'HQ');
    await page.goto(`${base}/p/${s.pid}/locations/${hq.id}`);
    await page.getByRole('button', { name: 'Move' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('To project').selectOption({ label: 'OTHER · Other Co' });
    const preview = dlg.locator('.move-preview');
    await preview.waitFor();
    const text = await preview.innerText();
    assert.match(text, /ACME \/ HQ\s*→\s*OTHER \/ HQ/);
    assert.match(text, /VLAN 30 Users: copied/);
    assert.match(text, /IP address\(es\) stay in the old project/);
    assert.match(text, /Tags copied: core/);
    await dlg.getByRole('button', { name: 'Move', exact: true }).click();
    await page.waitForURL(new RegExp(`/p/${other.id}/locations/${hq.id}$`));
    await page.getByRole('heading', { level: 1, name: /HQ/ }).waitFor();
    assert.equal(await page.getByLabel('Project').inputValue(), String(other.id));
    const sw = (await call(page, 'get', `/api/projects/${other.id}/devices?q=SW20`)).devices[0];
    assert.equal(sw.path, 'OTHER/HQ/F1/SR1/RK02/SW20');
  });
}
