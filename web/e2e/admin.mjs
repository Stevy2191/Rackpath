// Users and access, a second person signing in, invitations, account
// settings, the change history, tags and device types.
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
  /** Another person in their own browser session. */
  const other = async (page, fn) => {
    const ctx = await page.context().browser().newContext();
    const p = await ctx.newPage();
    try {
      await fn(p);
    } catch (e) {
      if (shots) await p.screenshot({ path: join(shots, 'fail-other.png') });
      throw e;
    } finally {
      await ctx.close();
    }
  };

  test('the sidebar keeps the last project on account-wide pages', async (page) => {
    const pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'ACME').id;
    await page.goto(`${base}/p/${pid}`);
    await page.getByRole('heading', { name: 'Acme Corp' }).waitFor();
    const rail = page.locator('.rail');
    // Users is account-wide; the project's own links stay in the sidebar.
    await rail.getByRole('link', { name: 'Users' }).click();
    await page.waitForURL(/\/admin\/users$/);
    assert.equal(await page.getByLabel('Project').inputValue(), String(pid));
    await rail.getByRole('link', { name: 'Locations' }).click();
    await page.waitForURL(new RegExp(`/p/${pid}/locations$`));
    // Also after a reload of an account-wide page.
    await page.goto(`${base}/activity`);
    await rail.getByRole('link', { name: 'Devices' }).waitFor();
    // Choosing "All projects" leaves no project in the sidebar.
    await page.getByLabel('Project').selectOption('');
    await page.waitForURL(/\/projects$/);
    assert.equal(await rail.getByRole('link', { name: 'Devices' }).count(), 0);
  });

  test('add a user and give them editor access to a project', async (page) => {
    s.pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'ACME').id;
    await page.goto(`${base}/projects`);
    await page.getByRole('link', { name: 'Users' }).click();
    await page.getByRole('heading', { name: 'Users and access' }).waitFor();
    await page.getByRole('button', { name: 'Add user' }).click();
    await page.getByLabel('Username').fill('bob');
    await page.getByLabel('Display name').fill('Bob Builder');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    s.bobPassword = (await page.locator('.secret code').innerText()).trim();
    assert.ok(s.bobPassword.length >= 10);
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('cell', { name: /bob/ }).click();
    await page.getByRole('button', { name: 'Give access' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Project').selectOption({ label: 'ACME · Acme Corp' });
    await dlg.getByRole('button', { name: 'Give access' }).click();
    await dlg.getByText('Editor of Acme Corp').waitFor();
    await snap(page, 'user');
    await page.keyboard.press('Escape');
    await page.locator('tr').filter({ hasText: 'bob' }).getByText('Editor of Acme Corp').waitFor();
  });

  test('the new user signs in, picks a password and sees only their project', async (page) => {
    await other(page, async (p) => {
      await p.goto(base + '/');
      await p.getByLabel('Username').fill('bob');
      await p.getByLabel('Password').fill(s.bobPassword);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.getByLabel('Current password').fill(s.bobPassword);
      await p.getByLabel('New password', { exact: true }).fill('bob-password-1');
      await p.getByLabel('New password again').fill('bob-password-1');
      await p.getByRole('button', { name: 'Save and continue' }).click();
      await p.getByRole('heading', { name: 'Projects' }).waitFor();
      await p.getByText('Acme Corp', { exact: true }).waitFor();
      assert.equal(await p.getByRole('link', { name: 'Users' }).count(), 0, 'not an admin');
    });
  });

  test('invite someone with a link they accept', async (page) => {
    await page.goto(`${base}/admin/users?tab=invitations`);
    await page.getByRole('button', { name: 'Invite someone' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Role').selectOption('reader');
    await dlg.getByLabel('Project').selectOption({ label: 'ACME · Acme Corp' });
    await page.getByRole('button', { name: 'Create invitation' }).click();
    const link = (await page.locator('.secret code').innerText()).trim();
    assert.match(link, /\/invite\/[A-Za-z0-9_-]+$/);
    await page.getByRole('cell', { name: /reader/ }).waitFor();
    await other(page, async (p) => {
      await p.goto(link);
      await p.getByLabel('Username').fill('carol');
      await p.getByLabel('Password', { exact: true }).fill('carol-password-1');
      await p.getByLabel('Password again').fill('carol-password-1');
      await p.getByRole('button', { name: /Create|Join|Accept/ }).click();
      await p.getByRole('heading', { name: 'Projects' }).waitFor();
    });
    await page.reload();
    await page.getByText('No pending invitations').waitFor();
    const users = await call(page, 'get', '/api/users');
    const carol = users.find((r) => r.user.username === 'carol');
    assert.deepEqual(carol.grants.map((g) => [g.role, g.scope_type]), [['reader', 'project']]);
  });

  test('account settings: require two-factor sign-in', async (page) => {
    await page.goto(`${base}/admin/users?tab=settings`);
    await page.getByLabel('Everyone must use two-factor sign-in').check();
    await page.getByText('Two-factor sign-in is now required').waitFor();
    assert.equal((await call(page, 'get', '/api/account/settings')).require_2fa, true);
    await page.getByLabel('Everyone must use two-factor sign-in').uncheck();
    await page.getByText('Two-factor sign-in is optional').waitFor();
  });

  test('the activity log shows changes with before and after', async (page) => {
    await page.getByRole('link', { name: 'Activity' }).click();
    await page.getByRole('heading', { name: 'Activity' }).waitFor();
    await page.getByLabel('Action').selectOption('update');
    await page.getByLabel('Kind of thing').selectOption('account_settings');
    const row = page.locator('.activity li').first();
    await row.getByText('account settings').waitFor();
    await row.locator('.activity-head').click();
    await row.locator('.changes').getByText('require 2fa').waitFor();
    assert.match(await row.locator('.changes').innerText(), /true\s*→\s*false/);
    await snap(page, 'activity');
  });

  test('project settings: tags on devices, and a custom device type', async (page) => {
    await page.goto(`${base}/p/${s.pid}/settings?tab=tags`);
    await page.getByRole('button', { name: 'Add tag' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('core');
    await page.getByRole('dialog').getByLabel('Colour').fill('#f59e0b');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('cell', { name: 'core' }).waitFor();

    const sw = (await call(page, 'get', `/api/projects/${s.pid}/devices?q=SW20`)).devices[0];
    await page.goto(`${base}/p/${s.pid}/devices/${sw.id}`);
    await page.getByRole('button', { name: 'Add tags' }).click();
    await page.getByRole('dialog').getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('.kv .tag-chip').getByText('core').waitFor();
    await page.goto(`${base}/p/${s.pid}/devices?tag=core`);
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.match(await page.locator('tbody').innerText(), /SW20/);

    await page.goto(`${base}/p/${s.pid}/settings?tab=types`);
    await page.getByRole('button', { name: 'Add device type' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name').fill('Badge reader');
    await dlg.getByLabel('Key').fill('badge_reader');
    await dlg.getByLabel('Code prefix').fill('BR');
    await dlg.getByLabel('Goes').selectOption('floor');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('cell', { name: 'Badge reader' }).waitFor();
    const types = await call(page, 'get', `/api/projects/${s.pid}/device-types`);
    assert.ok(types.some((t) => t.key === 'badge_reader' && t.prefix === 'BR' && !t.is_builtin));
  });
}
