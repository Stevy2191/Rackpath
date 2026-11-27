// VLANs, Wi-Fi, prefixes, ranges, the address grid, next free, addresses,
// warnings and port VLANs. Runs after cabling.mjs (switch SW20 exists).
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

  test('VLANs and Wi-Fi networks', async (page) => {
    s.pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'ACME').id;
    await page.goto(`${base}/p/${s.pid}`);
    await page.getByRole('link', { name: 'VLANs and Wi-Fi' }).click();
    await page.getByRole('button', { name: 'Add VLAN' }).click();
    await page.getByLabel('VLAN ID').fill('30');
    await page.getByLabel('Name').fill('Users');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('cell', { name: 'Users' }).waitFor();
    await page.getByRole('tab', { name: 'Wi-Fi networks' }).click();
    await page.getByRole('button', { name: 'Add WLAN' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('SSID', { exact: true }).fill('Acme-Staff');
    await dlg.getByLabel('Security').selectOption('wpa3');
    await dlg.getByLabel('VLAN').selectOption({ label: '30 Users' });
    assert.equal(await dlg.getByLabel(/pass/i).count(), 0, 'no passphrase field');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('cell', { name: 'Acme-Staff' }).waitFor();
    assert.match(await page.locator('tbody').innerText(), /WPA3 Personal\s+30 Users/);
  });

  test('prefixes nest, and host bits are refused', async (page) => {
    await page.getByRole('link', { name: 'IP addresses' }).click();
    await page.getByRole('heading', { name: 'IP addresses' }).waitFor();
    await call(page, 'post', `/api/projects/${s.pid}/prefixes`, { cidr: '10.30.0.0/16', role: 'transit' });
    await page.getByRole('button', { name: 'Add prefix' }).click();
    const dlg = page.getByRole('dialog');
    allow(/^POST .*\/prefixes$/);
    await dlg.getByLabel('Prefix (CIDR)').fill('10.30.5.7/24');
    await dlg.getByLabel('VLAN').selectOption({ label: '30 Users' });
    await dlg.getByLabel('Gateway').fill('10.30.5.1');
    await page.getByRole('button', { name: 'Save' }).click();
    await dlg.getByRole('alert').getByText(/10\.30\.5\.0\/24/).waitFor();
    await dlg.getByLabel('Prefix (CIDR)').fill('10.30.5.0/24');
    await dlg.getByLabel('Description').fill('Office users');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { level: 1, name: '10.30.5.0/24' }).waitFor();
    s.prefix = Number(page.url().split('/prefixes/')[1]);
    assert.match(await page.locator('.crumbs').innerText(), /10\.30\.0\.0\/16/);
    await page.goto(`${base}/p/${s.pid}/ipam`);
    const child = page.locator('tr[data-cidr="10.30.5.0/24"] td').first();
    const parent = page.locator('tr[data-cidr="10.30.0.0/16"] td').first();
    const pad = async (l) => parseFloat(await l.evaluate((e) => getComputedStyle(e).paddingLeft));
    assert.ok((await pad(child)) > (await pad(parent)), 'child is indented under its parent');
  });

  test('a DHCP pool on the grid, then the next free address', async (page) => {
    await page.goto(`${base}/p/${s.pid}/ipam/prefixes/${s.prefix}`);
    await page.getByRole('button', { name: 'Add range' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('First address').fill('10.30.5.100');
    await dlg.getByLabel('Last address').fill('10.30.5.199');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('.ip-grid .cell.range-dhcp_pool').length === 100);
    assert.equal(await page.locator('.ip-grid .cell.gateway').count(), 1);

    await page.getByRole('button', { name: 'Next free address' }).click();
    await page.getByRole('dialog').getByLabel('DNS name').fill('printer1.acme.lan');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Documented 10.30.5.2').waitFor();
    await page.locator('.ip-grid .cell.addr-static').first().waitFor();
    assert.match(await page.locator('.ip-grid .cell.addr-static').first().getAttribute('title'), /10\.30\.5\.2 · printer1/);
    await snap(page, 'prefix');
  });

  test('click a free cell to document an address on a device port', async (page) => {
    await page.getByRole('button', { name: /^10\.30\.5\.10$/ }).click();
    const dlg = page.getByRole('dialog');
    assert.equal(await dlg.getByLabel('Address', { exact: true }).inputValue(), '10.30.5.10');
    await dlg.getByLabel('Find a device').fill('SW20');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent.endsWith('SW20')));
    await dlg.getByLabel('Device', { exact: true }).selectOption({ label: 'HQ / F1 / SR1 / RK02 / SW20' });
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent === '2'));
    await dlg.getByLabel('Port').selectOption({ label: '2' });
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('link', { name: '10.30.5.10' }).click();
    await page.getByRole('heading', { level: 1, name: '10.30.5.10' }).waitFor();
    assert.match(await page.locator('.kv').innerText(), /SW20/);
    await page.getByRole('link', { name: '2', exact: true }).waitFor();
  });

  test('IPAM warnings list a static address inside a DHCP pool', async (page) => {
    await call(page, 'post', `/api/projects/${s.pid}/addresses`, { address: '10.30.5.150', description: 'old printer' });
    await page.goto(`${base}/p/${s.pid}/ipam?tab=warnings`);
    await page.getByText('10.30.5.150 is documented as static inside the DHCP pool').waitFor();
  });

  test('set a port’s VLANs', async (page) => {
    const ports = (await call(page, 'get', `/api/projects/${s.pid}/devices?q=SW20`)).devices;
    const p2 = (await call(page, 'get', `/api/devices/${ports[0].id}/ports`)).ports.find((p) => p.code === '2');
    await page.goto(`${base}/p/${s.pid}/ports/${p2.id}`);
    await page.getByRole('button', { name: 'Set VLANs' }).click();
    await page.getByRole('dialog').getByLabel('Untagged (native)').selectOption({ label: '30 Users' });
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByText('30 Users').waitFor();
    const vlans = (await call(page, 'get', `/api/ports/${p2.id}`)).vlans;
    assert.deepEqual(vlans.map((v) => [v.vid, v.mode]), [[30, 'untagged']]);
  });
}
