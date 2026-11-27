// Ports, cables, the rack patching view, tracing and IP addresses on a
// device. Runs after places.mjs: signed in, project ACME, room SR1.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';

export default function (test, { base, shots }) {
  const snap = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
  const s = {};
  const call = async (page, method, path, data) => {
    const r = await page.request[method](base + path, data ? { data } : undefined);
    assert.ok(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };

  test('add numbered ports on a device page', async (page) => {
    s.pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'ACME').id;
    const room = (await call(page, 'get', `/api/projects/${s.pid}/places`)).find((p) => p.kind === 'room' && p.path.endsWith('/SR1'));
    s.rack = (await call(page, 'post', `/api/rooms/${room.id}/racks`, { code: 'RK02', u_height: 42 })).id;
    const dev = (body) => call(page, 'post', `/api/projects/${s.pid}/devices`, body);
    s.sw = await dev({ device_type: 'switch', code: 'SW20', name: 'Access switch', placement: { type: 'rack', rack_id: s.rack, u: 30 } });
    s.pp = await dev({ device_type: 'patch_panel', code: 'PP01', placement: { type: 'rack', rack_id: s.rack, u: 32 } });
    s.pc = await dev({ device_type: 'desktop', code: 'DP01', name: 'Reception PC', placement: { type: 'room', room_id: room.id } });
    await call(page, 'post', `/api/devices/${s.pp.id}/ports/bulk`, { count: 24 });
    s.wo = await dev({ device_type: 'wall_outlet', code: 'WO01', placement: { type: 'room', room_id: room.id } });
    const nic = await call(page, 'post', `/api/devices/${s.pc.id}/ports`, { code: 'NIC1' });
    const outlet = await call(page, 'post', `/api/devices/${s.wo.id}/ports`, { code: 'A' });
    s.deskPatch = { kind: 'patch', a: { port_id: outlet.id }, b: { port_id: nic.id }, cable_type: 'Cat6', length_m: 2 };

    await page.goto(`${base}/p/${s.pid}/devices/${s.sw.id}?tab=ports`);
    await page.getByRole('button', { name: 'Add numbered ports' }).click();
    await page.getByLabel('How many').fill('8');
    await page.getByText('Creates 1 … 8.').waitFor();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('tr[data-port="8"]').waitFor();
    assert.equal(await page.locator('tbody tr[data-port]').count(), 8);
  });

  test('a permanent cable from a panel rear to a wall outlet', async (page) => {
    await page.goto(`${base}/p/${s.pid}/devices/${s.pp.id}?tab=ports`);
    await page.getByRole('button', { name: 'Connect 01 rear' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Find a device').fill('WO01');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent.includes('WO01')));
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent.startsWith('A ')));
    assert.equal(await dlg.getByLabel('Cable', { exact: true }).inputValue(), 'permanent');
    await dlg.getByLabel('Cable type').selectOption('Cat6');
    await dlg.getByLabel('Length (m)').fill('30');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const row = page.locator('tr[data-port="01"]');
    await row.getByText('WO01 A').waitFor();
    // Patching needs a permanent cable behind the panel port first.
    assert.equal(await row.getByRole('button', { name: 'Connect 01 front' }).count(), 1);
    assert.equal(await page.locator('tr[data-port="02"]').getByRole('button', { name: 'Connect 02 front' }).count(), 0);
    assert.match(await row.innerText(), /Cat6 · 30 m/);
  });

  test('patch a switch port to the panel in the rack patching view, and trace it', async (page) => {
    await call(page, 'post', '/api/connections', s.deskPatch);
    await page.goto(`${base}/p/${s.pid}/racks/${s.rack}?view=patching`);
    await page.locator('tr.group-row').filter({ hasText: 'SW20' }).waitFor();
    assert.equal(await page.locator('tr.group-row').count(), 2);
    await page.locator('tr.group-row').filter({ hasText: 'SW20' }).locator('xpath=following-sibling::tr[1]').getByRole('button', { name: 'Connect 1 front' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Find a device').fill('PP01');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent.startsWith('01 ')));
    assert.equal(await dlg.getByLabel('Cable', { exact: true }).inputValue(), 'patch');
    await dlg.getByLabel('Length (m)').fill('1');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const trace = page.locator('.trace');
    await trace.getByText('Complete').waitFor();
    assert.equal(await trace.locator('.trace-port').count(), 4);
    assert.match(await trace.innerText(), /33 m in total/);
    assert.match(await trace.innerText(), /DP01 NIC1/);
    await snap(page, 'rack-patching');
  });

  test('port page: chain colour, change and remove a cable', async (page) => {
    const ports = (await call(page, 'get', `/api/devices/${s.sw.id}/ports`)).ports;
    const p01 = ports.find((p) => p.code === '1');
    await page.goto(`${base}/p/${s.pid}/ports/${p01.id}`);
    await page.getByRole('heading', { level: 1, name: /Port 1/ }).waitFor();
    await page.locator('.trace').getByText('Complete').waitFor();
    await page.getByLabel('Chain colour').fill('#ff8800');
    await page.getByRole('button', { name: 'Colour the patch cords' }).click();
    await page.waitForResponse((r) => r.url().includes('/trace'));
    const conn = (await call(page, 'get', `/api/ports/${p01.id}`)).front;
    assert.equal(conn.color, '#ff8800');
    await snap(page, 'port');

    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('dialog').getByLabel('Label').fill('P-01');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByText('P-01').first().waitFor();
    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('button', { name: 'Remove cable' }).click();
    await page.getByRole('button', { name: 'Click again to remove the cable' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByText('Nothing connected').waitFor();
    await page.locator('.trace').getByText('Not connected').waitFor();
  });

  test('IP addresses on the device page', async (page) => {
    await call(page, 'post', `/api/projects/${s.pid}/prefixes`, { cidr: '10.9.0.0/24' });
    await call(page, 'post', `/api/projects/${s.pid}/addresses`, { address: '10.9.0.20', device_id: s.sw.id, dns_name: 'sw20.acme.lan' });
    await page.goto(`${base}/p/${s.pid}/devices/${s.sw.id}`);
    await page.getByRole('tab', { name: 'IP addresses' }).click();
    await page.getByRole('link', { name: /10\.9\.0\.20/ }).waitFor();
    assert.match(await page.locator('tbody').innerText(), /sw20\.acme\.lan/);
    assert.match(page.url(), /tab=addresses/);
  });
}
