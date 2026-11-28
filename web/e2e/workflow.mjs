// Set-up shortcuts: the overview's Get started steps, a one-floor location
// showing its racks directly, Add rack with a "Where" picker, and placing a
// device that waits in Unplaced. Uses its own project.
import { strict as assert } from 'node:assert';

export default function (test, { base }) {
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
}
