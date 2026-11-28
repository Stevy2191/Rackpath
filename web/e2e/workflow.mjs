// Set-up shortcuts: the overview's Get started steps, a one-floor location
// showing its racks directly, Add rack with a "Where" picker, and placing a
// device that waits in Unplaced. Uses its own project.
import { strict as assert } from 'node:assert';

import { join } from 'node:path';

export default function (test, { base, shots }) {
  const snap = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }));
  const s = {};
  const call = async (page, method, path, data) => {
    const r = await page.request[method](base + path, data ? { data } : undefined);
    assert.ok(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };

  test('a new project walks from Get started to a rack', async (page) => {
    s.pid = (await call(page, 'post', '/api/projects', { code: 'HOMELAB', name: 'Home lab' })).id;
    await page.goto(`${base}/p/${s.pid}`);
    const steps = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Get started' }) });
    await steps.getByRole('button', { name: 'Add location' }).click();
    await page.getByRole('dialog').getByLabel('Code', { exact: true }).fill('HOUSE');
    await page.getByRole('button', { name: 'Save' }).click();
    // One floor, no rooms drawn: the location page shows racks directly.
    await page.getByRole('heading', { name: 'Racks' }).waitFor();
    await page.getByText('Everything is on one floor').waitFor();
    await page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Racks' }) }).getByRole('button', { name: 'Add rack' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText('In HOUSE').waitFor();
    await page.waitForFunction(() => document.querySelector('[role=dialog] input')?.value === 'RK01');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { level: 1, name: 'RK01' }).waitFor();
    s.rack = Number(page.url().split('/').pop());
  });

  test('a device waiting in Unplaced is placed by clicking a free U', async (page) => {
    await call(page, 'post', `/api/projects/${s.pid}/devices`, { device_type: 'switch', name: 'Core switch' });
    await page.goto(`${base}/p/${s.pid}`);
    await page.getByText('device(s)').first().waitFor();
    await page.getByText(/are waiting in Unplaced/).waitFor();
    await page.goto(`${base}/p/${s.pid}/racks/${s.rack}`);
    await page.getByRole('button', { name: 'Place a device (1 unplaced)' }).waitFor();
    await page.getByRole('button', { name: 'Add a device at U10' }).click();
    await page.getByRole('button', { name: 'A device from Unplaced (1)' }).click();
    const dlg = page.getByRole('dialog');
    assert.equal(await dlg.getByLabel('Position (U)').inputValue(), '10');
    assert.match(await dlg.getByLabel('Device', { exact: true }).locator('option:checked').innerText(), /Core switch/);
    await page.getByRole('button', { name: 'Place it' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.locator('.rack-device', { hasText: 'SW01' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: /Place a device/ }).count(), 0, 'nothing left to place');
    // All three steps done: Get started is gone.
    await page.goto(`${base}/p/${s.pid}`);
    await page.getByRole('heading', { name: 'Placed devices' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Get started' }).count(), 0);
  });

  test('racks stand side by side in rows, front and rear', async (page) => {
    const loc = (await call(page, 'get', `/api/projects/${s.pid}/locations`))[0];
    const l = await call(page, 'get', `/api/locations/${loc.id}`);
    const floor = await call(page, 'get', `/api/floors/${l.floors[0].id}`);
    const room = floor.rooms[0].id;
    await call(page, 'patch', `/api/racks/${s.rack}`, { row_label: 'A', row_position: 1 });
    const rk2 = await call(page, 'post', `/api/rooms/${room}/racks`, { code: 'RK02', u_height: 24, row_label: 'A', row_position: 2 });
    await call(page, 'post', `/api/rooms/${room}/racks`, { code: 'RK03', u_height: 12 });
    await call(page, 'post', `/api/projects/${s.pid}/devices`, { device_type: 'patch_panel', placement: { type: 'rack', rack_id: rk2.id, u: 20, face: 'front', mount: 'full_width' } });

    await page.goto(`${base}/p/${s.pid}/locations/${loc.id}`);
    const rowA = page.getByRole('region', { name: 'Row A' });
    await rowA.waitFor();
    const order = async (region) => (await region.locator('.rack-row-head a').allInnerTexts()).join(' ');
    assert.equal(await order(rowA), 'RK01 RK02');
    await page.getByRole('region', { name: 'Racks not in a row' }).getByText('RK03').waitFor();
    await snap(page, 'rack-row');
    // From the rear the row is mirrored.
    await page.getByRole('button', { name: 'Rear', exact: true }).click();
    assert.equal(await order(rowA), 'RK02 RK01');
    await page.getByRole('button', { name: 'Front', exact: true }).click();

    // Drag a device from one rack into another.
    await rowA.locator('.rack-device[data-device=PP01]').dragTo(rowA.locator('.rack-row-item').first().getByRole('button', { name: 'Add a device at U30' }));
    await page.waitForFunction(() => document.querySelectorAll('.rack-row-item')[0]?.querySelector('[data-device=PP01]'));
    // Drag a rack's heading onto another to reorder the row.
    await rowA.locator('.rack-row-head').nth(1).dragTo(rowA.locator('.rack-row-head').nth(0));
    await page.getByText('Row A reordered').waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Row A"] .rack-row-head a')?.textContent === 'RK02');
    const racks = (await call(page, 'get', `/api/rooms/${room}`)).racks.map((r) => `${r.code}:${r.row_label}${r.row_position}`);
    assert.deepEqual(racks.slice(0, 2), ['RK02:A1', 'RK01:A2']);
  });
}
