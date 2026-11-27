// Templates (designer, live preview, edits that update devices) and power
// (figures, power cords, rack summary). Runs after cabling.mjs (rack RK02).
import { strict as assert } from 'node:assert';
import { join } from 'node:path';

export default function (test, { base, shots, allow }) {
  const snap = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
  const s = {};
  const call = async (page, method, path, data) => {
    const r = await page.request[method](base + path, data ? { data } : undefined);
    assert.ok(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };
  /** Drags across grid cells (0-based) of the face grid. */
  const drawGroup = async (page, r0, c0, r1, c1) => {
    const g = await page.locator('.face-grid').boundingBox();
    const [rows, cols] = await page.locator('.face-grid').evaluate((e) => [getComputedStyle(e).gridTemplateRows.split(' ').length, getComputedStyle(e).gridTemplateColumns.split(' ').length]);
    const at = (r, c) => [g.x + ((c + 0.5) * g.width) / cols, g.y + ((r + 0.5) * g.height) / rows];
    await page.mouse.move(...at(r0, c0));
    await page.mouse.down();
    await page.mouse.move(...at(r1, c1), { steps: 4 });
    await page.mouse.up();
  };

  test('design a template: draw a port group and see its ports named', async (page) => {
    s.pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'ACME').id;
    await page.goto(`${base}/p/${s.pid}`);
    await page.getByRole('link', { name: 'Templates' }).click();
    await page.getByRole('heading', { name: 'Device templates' }).waitFor();
    assert.ok((await page.getByText('built-in').count()) > 5);
    await page.getByRole('button', { name: 'New template' }).click();
    await page.getByLabel('Name').fill('Access 8');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('heading', { level: 1, name: /Access 8/ }).waitFor();
    s.tpl = Number(page.url().split('/templates/')[1]);

    await drawGroup(page, 0, 0, 1, 3);
    await page.getByRole('heading', { name: 'Port group 1' }).waitFor();
    await page.getByLabel('Name prefix').fill('G');
    await page.locator('.face-port[data-code=G8]').waitFor();
    // Column-major: G2 sits under G1.
    const pos = async (c) => page.locator(`.face-port[data-code=${c}]`).boundingBox();
    assert.ok((await pos('G2')).y > (await pos('G1')).y);
    await page.getByLabel('Connector').selectOption('RJ45');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    const t = await call(page, 'get', `/api/templates/${s.tpl}`);
    assert.deepEqual(t.ports.map((p) => p.code), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
  });

  test('an impossible group is shown as an error and can’t be saved', async (page) => {
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: 'Port group 1 (G)' }).click();
    allow(/templates\/preview$/);
    await page.getByLabel('Columns', { exact: true }).fill('60');
    await page.getByRole('alert').getByText(/more than 99 ports/).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Save' }).isDisabled());
    await page.getByLabel('Columns', { exact: true }).fill('4');
    await page.locator('[role=alert]').waitFor({ state: 'detached' });
  });

  test('editing a used template shows what happens to its devices first', async (page) => {
    await call(page, 'post', `/api/projects/${s.pid}/devices`, { template_id: s.tpl, code: 'SW30', placement: { type: 'rack', rack_id: (await call(page, 'get', `/api/projects/${s.pid}/places`)).find((p) => p.kind === 'rack' && p.path.endsWith('/RK02')).id, u: 5 } });
    await page.reload();
    await page.getByRole('button', { name: 'Port group 1 (G)' }).click();
    await page.getByLabel('Columns', { exact: true }).fill('2');
    await page.locator('.face-port[data-code=G4]').waitFor();
    await page.locator('.face-port[data-code=G5]').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Save' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText('Ports removed: G5, G6, G7, G8').waitFor();
    const go = dlg.getByRole('button', { name: 'Save and update devices' });
    assert.ok(await go.isDisabled());
    await dlg.getByLabel(/Type Access 8 to confirm/).fill('Access 8');
    await go.click();
    await page.getByText(/Saved; 1 device/).waitFor();
    const sw = (await call(page, 'get', `/api/projects/${s.pid}/devices?q=SW30`)).devices[0];
    assert.equal((await call(page, 'get', `/api/devices/${sw.id}/ports`)).ports.length, 4);
    await snap(page, 'template-designer');
  });

  test('a built-in template is copied into the project to be changed', async (page) => {
    await page.goto(`${base}/p/${s.pid}/templates`);
    const row = page.locator('tbody tr').filter({ hasText: 'built-in' }).first();
    const name = (await row.locator('td').first().innerText()).trim();
    await row.getByRole('button', { name: 'Copy to project' }).click();
    await page.getByRole('heading', { level: 1, name }).waitFor();
    assert.equal(await page.getByText('built-in', { exact: true }).count(), 0);
    assert.ok(await page.getByRole('button', { name: 'Save' }).isVisible());
  });

  test('power: UPS figures, a power cord, and the rack’s power summary', async (page) => {
    const rack = (await call(page, 'get', `/api/projects/${s.pid}/places`)).find((p) => p.kind === 'rack' && p.path.endsWith('/RK02')).id;
    s.ups = await call(page, 'post', `/api/projects/${s.pid}/devices`, { device_type: 'ups', code: 'UPS01', placement: { type: 'rack', rack_id: rack, u: 1, face: 'both' }, u_height: 2 });
    await call(page, 'post', `/api/devices/${s.ups.id}/ports/bulk`, { prefix: 'O', count: 4, connector: 'C13', outlet_group: 1 });
    s.srv = await call(page, 'post', `/api/projects/${s.pid}/devices`, { device_type: 'server', code: 'SRV01', placement: { type: 'rack', rack_id: rack, u: 10 } });

    // UPS figures through the form, including its runtime curve.
    await page.goto(`${base}/p/${s.pid}/devices/${s.ups.id}?tab=power`);
    await page.locator('.card').filter({ hasText: 'Figures' }).getByRole('button', { name: 'Edit' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Capacity (W)').fill('1000');
    await dlg.getByRole('button', { name: 'Add point' }).click();
    await dlg.getByLabel('Load (W)').fill('200');
    await dlg.getByLabel('Minutes').fill('40');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByText('200 W → 40 min').waitFor();

    // The server: a draw, an inlet, and a cord to the UPS.
    await call(page, 'put', `/api/devices/${s.srv.id}/power`, { typical_w: 200 });
    await page.goto(`${base}/p/${s.pid}/devices/${s.srv.id}?tab=power`);
    await page.getByText('No power cord on any inlet').waitFor({ state: 'detached' }).catch(() => {});
    await page.getByRole('button', { name: 'Add power port' }).click();
    await page.getByRole('dialog').getByLabel('Port').fill('PSU1');
    await page.getByRole('dialog').getByLabel('Connector').selectOption('C14');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('No power cord on any inlet').waitFor();
    await page.getByRole('button', { name: 'Connect PSU1 front' }).click();
    const c = page.getByRole('dialog');
    await c.getByLabel('Find a device').fill('UPS01');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent.startsWith('O1 ')));
    assert.equal(await c.getByLabel('Cable', { exact: true }).inputValue(), 'power');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByText('No power cord on any inlet').waitFor({ state: 'detached' });

    await page.goto(`${base}/p/${s.pid}/racks/${rack}?view=power`);
    const ups = page.locator('tr[data-device=UPS01]');
    await ups.waitFor();
    assert.match(await ups.innerText(), /200 W/);
    assert.match(await ups.innerText(), /20%/);
    assert.match(await ups.innerText(), /40 min/);
    assert.match(await ups.innerText(), /1\/4/);
    await snap(page, 'rack-power');
  });
}
