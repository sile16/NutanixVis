/**
 * UI regressions found by driving the real topologies (not the scripted demo): each test pins a
 * bug where the model was right and the UI misrepresented it.
 */
import { expect, type Page, test } from '@playwright/test';

const REAL = ['t1-ahv-flasharray', 't1-lab', 't2-hci-ahv', 't3-co-so', 't3-co-hci'] as const;

async function open(page: Page, topology: string) {
  await page.goto(`./#topology=${topology}`);
  await expect(page.getByTestId('topology-select')).toHaveValue(topology);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
}

async function step(page: Page, n: number) {
  for (let i = 0; i < n; i++) await page.getByTestId('step').click();
}

async function selectDevice(page: Page, id: string) {
  await page.getByRole('tab', { name: 'Inspector' }).click();
  if ((await page.getByTestId('inspector-empty').count()) === 0) {
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  }
  await page.getByTestId('device-picker').selectOption(id);
}

async function applyAction(page: Page, kind: string, params: Record<string, string> = {}) {
  const button = page.getByTestId(`action-${kind}`);
  const form = button.locator('xpath=ancestor::form');
  for (const [label, value] of Object.entries(params)) {
    await form.getByLabel(label).selectOption(value);
  }
  await button.click();
}

for (const topology of REAL) {
  test(`${topology}: loads and runs without console errors or warnings`, async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(e.message));
    await open(page, topology);
    await step(page, 3);
    // Bonds (engine kind "bond") are drawn as vswitch cards with their bond mode.
    await expect(page.getByTestId('node-node-1.vs0')).toContainText(
      /Active-Backup|A\/B|LACP|SLB|MAC|No bond|1 NIC/,
    );
    expect(problems).toEqual([]);
  });
}

test('a failed host: children and cables drawn failed/down, no repeating drop bursts', async ({
  page,
}) => {
  await open(page, 't2-hci-ahv');
  await page.getByTestId('traffic-preset-all').click(); // drops of control traffic are drawn too
  await step(page, 2);
  await selectDevice(page, 'node-4');
  await applyAction(page, 'fail');
  const overlay = page.getByTestId('packet-overlay');
  for (let i = 0; i < 5; i++) {
    await step(page, 1);
    // Peers keep sending to the dead host; those drops are persistent, not news.
    await expect(overlay).toHaveAttribute('data-bursts', '0');
  }
  await expect(overlay).not.toHaveAttribute('data-steady-drops', '0');
  for (const id of ['node-4.eth0', 'node-4.eth1', 'node-4.vs0', 'node-4.cvm', 'node-4.disk-1']) {
    await expect(page.getByTestId(`node-${id}`)).toHaveAttribute('data-status', /failed|offline/);
  }
  for (const id of ['l-node-4.eth0--sw-a', 'l-node-4.eth1--sw-b']) {
    await expect(page.locator(`.react-flow__edge[data-id="${id}"]`)).toHaveAttribute(
      'aria-label',
      /down$/,
    );
  }
  // The inspector says why a healthy-looking child is drawn failed.
  await selectDevice(page, 'node-4.eth0');
  await expect(page.getByTestId('inspector-title')).toHaveText('eth0');
  await expect(
    page.getByTestId('inspector-device').locator('[data-status="failed"]').first(),
  ).toBeVisible();
  await expect(page.getByTestId('inspector-down-reason')).toContainText(/node-4|Node 4/);
});

test('HA restart: restart marker on the VM and its original host in the inspector', async ({
  page,
}) => {
  test.slow();
  await open(page, 't2-hci-ahv');
  await step(page, 2);
  await selectDevice(page, 'node-4');
  await applyAction(page, 'fail');
  await page.getByTestId('speed-60').check({ force: true });
  await page.getByTestId('play').click();
  const marker = page.getByTestId('restart-marker-node-4.vm-1');
  await expect(marker).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('play').click();
  await expect(marker).toContainText('from Node 4');
  await selectDevice(page, 'node-4.vm-1');
  const placement = page.getByTestId('vm-placement');
  await expect(placement).toContainText('restarted by AHV HA from');
  await expect(placement).toContainText('Node 4');
  // Drawn healthy on its new host, not failed with the old one.
  await expect(page.getByTestId('inspector-down-reason')).toHaveCount(0);
});

test('per-VM path usage: CO VMs on one host show only their own owning CVM', async ({ page }) => {
  await open(page, 't3-co-so');
  await step(page, 12);
  await selectDevice(page, 'node-1.vm-1');
  const usage = page.getByTestId('path-usage');
  await expect(page.getByTestId('path-usage-scope')).toContainText("This VM's own paths");
  // A fresh selection reads the shared 10-tick window, not an empty per-panel buffer.
  await expect(usage).toContainText('recent activity');
  const a = await usage.locator('button').first().textContent();
  await selectDevice(page, 'node-1.vm-2');
  const b = await usage.locator('button').first().textContent();
  expect(a).not.toEqual(b);
  // Only that VM's far end is highlighted.
  // vs0 is LACP: the connection to node 5's CVM hashes onto either of its members.
  await expect(
    page
      .locator(
        '[data-testid="node-node-5.eth0"][data-inpath="true"], [data-testid="node-node-5.eth1"][data-inpath="true"]',
      )
      .first(),
  ).toBeVisible();
  await expect(page.locator('[data-testid="node-node-4.eth0"]')).toHaveAttribute(
    'data-dim',
    'true',
  );

  // HCI VM served locally: falls back to its host, and says so.
  await open(page, 't2-hci-ahv');
  await step(page, 3);
  await selectDevice(page, 'node-1.vm-1');
  await expect(page.getByTestId('path-usage-local')).toBeVisible();
});

test('traffic filter: toggles hide glow, presets, persists across topology switches', async ({
  page,
}) => {
  await open(page, 't2-hci-ahv');
  await step(page, 3);
  const glows = page.locator('[data-testid^="glow-"]');
  await expect(glows).not.toHaveCount(0);
  await page.getByTestId('traffic-preset-none').click();
  await expect(glows).toHaveCount(0);

  await page.getByTestId('traffic-preset-all').click();
  await expect(glows).not.toHaveCount(0);
  // Keyboard: toggle Zookeeper off with Space.
  const zk = page.getByTestId('legend-zk');
  await zk.locator('input').focus();
  await page.keyboard.press('Space');
  await expect(zk).toHaveAttribute('data-visible', 'false');
  await expect(zk).toHaveAttribute('title', /Zookeeper/);
  await expect(page.getByTestId('legend-iscsi-nop')).toHaveAttribute('title', /Autopath/);

  await page.evaluate(() => {
    window.location.hash = 'topology=t3-co-so';
  });
  await step(page, 2);
  await expect(page.getByTestId('legend-zk')).toHaveAttribute('data-visible', 'false');
  await page.getByTestId('traffic-preset-all').click();
});

test('topology hash: picking writes it, editing it switches', async ({ page }) => {
  await open(page, 't1-ahv-flasharray');
  // The dropdown offers the three storage-network configurations only.
  await expect(page.getByTestId('topology-select').locator('option')).toHaveCount(5);
  await page.getByTestId('topology-select').selectOption('t1-bonded-lacp');
  await expect(page).toHaveURL(/#topology=t1-bonded-lacp$/);
  await page.reload();
  await expect(page.getByTestId('topology-select')).toHaveValue('t1-bonded-lacp');
  await page.evaluate(() => {
    window.location.hash = 'topology=t1-ahv-flasharray';
  });
  await expect(page.getByTestId('topology-select')).toHaveValue('t1-ahv-flasharray');
});

test('reset clears the event log (event numbers restart)', async ({ page }) => {
  await open(page, 't1-ahv-flasharray');
  await selectDevice(page, 'sw-a');
  await applyAction(page, 'fail');
  await step(page, 2);
  await page.getByRole('tab', { name: 'Events' }).click();
  await expect(page.getByTestId('event-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Reset simulation' }).click();
  await expect(page.getByRole('tab', { name: 'Explain' })).toHaveCount(0);
  // Only the fresh run's own events remain (line-rate VMs fill their NICs at once).
  await expect(page.locator('[data-testid="event-row"][data-code^="action."]')).toHaveCount(0);
  await expect(page.locator('[data-testid="event-row"][data-code="switch.failed"]')).toHaveCount(0);
  const codes = await page
    .getByTestId('event-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-code')));
  expect(codes.every((c) => c === 'net.link.saturated')).toBe(true);
});

test('forms show the current value; MLAG can be turned off and on', async ({ page }) => {
  // (Rejected-action messages are covered by src/ui/panels/action-params.test.ts.)
  await open(page, 't1-ahv-flasharray');
  await selectDevice(page, 'sw-a');
  const form = page.getByTestId('action-fabric.set-mlag').locator('xpath=ancestor::form');
  // MLAG is on by default: vs0 runs LACP across the switch pair.
  await expect(form.locator('option', { hasText: '(current)' })).toHaveText('on (current)');
  await applyAction(page, 'fabric.set-mlag', { MLAG: 'off' });
  await expect(page.getByTestId('action-rejected-fabric.set-mlag')).toHaveCount(0);
  await page.getByTestId('step').click();
  await expect(form.locator('option', { hasText: '(current)' })).toHaveText('off (current)');
  await applyAction(page, 'fabric.set-mlag', { MLAG: 'on' });
  await page.getByTestId('step').click();
  await expect(form.locator('option', { hasText: '(current)' })).toHaveText('on (current)');
});

test('the FlashArray VIP is drawn in the controller that holds it, and follows failover', async ({
  page,
}) => {
  test.slow();
  await open(page, 't1-ahv-flasharray');
  const inside = async (child: string, parent: string) => {
    const c = await page.getByTestId(`node-${child}`).boundingBox();
    const p = await page.getByTestId(`node-${parent}`).boundingBox();
    if (!c || !p) return false;
    return (
      c.x >= p.x && c.y >= p.y && c.x + c.width <= p.x + p.width && c.y + c.height <= p.y + p.height
    );
  };
  expect(await inside('fa.vir0', 'fa.ct0')).toBe(true);
  await selectDevice(page, 'fa');
  await applyAction(page, 'fa.controller.failover');
  await expect
    .poll(
      async () => {
        await page.getByTestId('step').click();
        return inside('fa.vir0', 'fa.ct1');
      },
      { timeout: 60_000, intervals: [50] },
    )
    .toBe(true);
  await expect(page.getByTestId('node-fa.ct1')).toContainText('Primary');
});

test('context menu near the bottom edge stays inside the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page, 't1-ahv-flasharray');
  const b = await page.getByTestId('node-fa.ct1.eth11.v20').boundingBox();
  if (!b) throw new Error('port not drawn');
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  const menu = await page.getByTestId('context-menu').boundingBox();
  expect(menu).not.toBeNull();
  expect((menu?.y ?? 0) + (menu?.height ?? 0)).toBeLessThanOrEqual(720);
  expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(1280);
});

test('traffic dots keep streaming slowly while the simulation is paused', async ({ page }) => {
  await open(page, 't1-ahv-flasharray');
  await step(page, 3);
  const overlay = page.getByTestId('packet-overlay');
  await expect(overlay).not.toHaveAttribute('data-flows', '0');
  const clock = await page.getByTestId('sim-clock').textContent();
  const a = await overlay.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(400);
  const b = await overlay.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  expect(a).not.toEqual(b);
  // Still paused: the clock did not move, only the dots did.
  await expect(page.getByTestId('sim-clock')).toHaveText(clock ?? '');
});

for (const id of [
  't1-ahv-flasharray',
  't1-bonded-slb',
  't1-bonded-slb-8ip',
  't1-bonded-lacp',
  't1-bonded-lacp-8ip',
]) {
  test(`${id}: IO is already flowing when the page loads (step 0)`, async ({ page }) => {
    await open(page, id);
    await expect(page.getByTestId('sim-clock')).toHaveAttribute('data-step', '0');
    await expect(page.getByTestId('packet-overlay')).not.toHaveAttribute('data-flows', '0');
  });
}

test('the CVM inspector lists its NVMe paths by name, and a failed controller marks two lost', async ({
  page,
}) => {
  await open(page, 't1-ahv-flasharray');
  await selectDevice(page, 'node-1.cvm');
  const paths = page.getByTestId('cvm-path');
  await expect(paths).toHaveCount(4);
  await expect(page.getByTestId('cvm-paths')).toContainText('CVM-IP A → CT0 eth10 (VLAN 10)');
  await expect(page.locator('[data-testid="cvm-path"][data-state="live"]')).toHaveCount(4);
  // The raw per-path JSON is not repeated in the State list.
  await expect(page.getByTestId('inspector-fields')).not.toContainText('~');

  await selectDevice(page, 'fa.ct0');
  await applyAction(page, 'fail');
  await step(page, 2);
  await selectDevice(page, 'node-1.cvm');
  const lost = page.locator('[data-testid="cvm-path"][data-state="lost"]');
  await expect(lost).toHaveCount(2);
  // A lost path's last latency is stale, so it is not shown.
  await expect(lost.first()).not.toContainText('ms');
});
