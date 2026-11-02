import { expect, test } from '@playwright/test';
import { topologies, topologyIds } from '../../src/topologies';

/**
 * Every real topology renders from the live engine (loader) with all devices and cables. Hosts of
 * an external-array topology also draw two derived boxes each (the AHV redirector and Stargate),
 * and the internal I/O hops are extra edges next to the physical cables.
 */
for (const id of topologyIds) {
  test(`real topology ${id} renders every device and cable`, async ({ page }) => {
    const t = topologies[id];
    const derived = t.devices.some((d) => d.kind === 'fa-array')
      ? 2 * t.devices.filter((d) => d.kind === 'cvm').length
      : 0;
    await page.goto(`./#topology=${id}`);
    await expect(page.getByTestId('node-sw-a')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(t.devices.length + derived);
    await expect(page.locator('.react-flow__edge:not([aria-label^="I/O hop"])')).toHaveCount(
      t.links.length,
    );
  });
}

test('real T1: the step counter starts at 0 and Step runs without error', async ({ page }) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  const clock = page.getByTestId('sim-clock');
  await expect(clock).toHaveAttribute('data-step', '0');
  await expect(clock).toContainText('steady');
  await page.getByTestId('step').click();
  await expect(clock).toHaveAttribute('data-step', '0');
  // Time is steps: nothing on the page reads as a clock.
  await expect(page.locator('body')).not.toContainText(/T\+\d\d:\d\d/);
});

test('real T1: both storage NICs down, step by step: stall, maintenance, redirect via CVM 2', async ({
  page,
}) => {
  test.slow();
  await page.goto('./#topology=t1-ahv-flasharray');
  await expect(page.getByTestId('node-node-1.cvm.stargate')).toBeVisible();
  await expect(page.getByTestId('node-node-1.redirector')).toBeVisible();
  // Normal I/O path: VM -> redirector -> Stargate -> storage interface -> bond -> NIC.
  const hop = (a: string, b: string) => page.locator(`.react-flow__edge[data-id="io:${a}>${b}"]`);
  await page.getByTestId('step').click();
  await expect(hop('node-1.vm-1', 'node-1.redirector')).toHaveAttribute('aria-label', /active/);
  await expect(hop('node-1.vs1', 'node-1.eth1')).toHaveAttribute('aria-label', /active/);

  for (const nic of ['node-1.eth1', 'node-1.eth3']) {
    await page.getByRole('tab', { name: 'Inspector' }).click();
    if ((await page.getByTestId('inspector-empty').count()) === 0) {
      await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    }
    await page.getByTestId('device-picker').selectOption(nic);
    await page.getByTestId('action-fail').click();
  }
  const clock = page.getByTestId('sim-clock');
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) {
    await page.getByTestId('step').click();
    seen.push(Number(await clock.getAttribute('data-step')));
    if (seen.at(-1) === 4) break;
  }
  // The counter only moves forward, one ordinal at a time, and reaches the redirect step.
  expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  expect(seen.at(-1)).toBe(4);
  await expect(hop('node-1.vs1', 'node-1.eth1')).toHaveAttribute('aria-label', /down/);
  const row = page.locator('[data-testid="impact-row"][data-vm="node-1.vm-1"]');
  await expect(row.locator('[data-kind="stalled"]').first()).toBeVisible();
  await expect(row.locator('[data-kind="redirected"]').first()).toContainText('via CVM 2');
  await expect(hop('node-1.redirector', 'node-1.host-mgmt')).toHaveAttribute(
    'aria-label',
    /active/,
  );
});

test('bonded single-network topology: a member loss is a 0-step, no-interruption event', async ({
  page,
}) => {
  await page.goto('./#topology=t1-bonded-single');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  await page.getByTestId('device-picker').selectOption('node-1.eth1');
  await page.getByTestId('action-fail').click();
  for (let i = 0; i < 6; i++) await page.getByTestId('step').click();
  await expect(page.getByTestId('sim-clock')).toHaveAttribute('data-step', '0');
  await expect(page.getByTestId('impact-bond')).toContainText('no interruption');
  await expect(page.getByTestId('impact-summary')).toContainText('no VM interrupted');
  await expect(page.getByTestId('node-node-1.eth3').getByTestId('node-note')).toHaveText('active');
  await expect(page.getByTestId('node-node-1.eth1').getByTestId('node-note')).toHaveText('down');
});

test('bonded single-network variant: two live array paths, other portals not connected, both NICs down', async ({
  page,
}) => {
  test.slow();
  await page.goto('./#topology=t1-bonded-single');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  await page.getByTestId('step').click();
  for (const id of ['fa.ct0.eth11.v10', 'fa.ct1.eth11.v10']) {
    await expect(page.getByTestId(`node-${id}`)).toHaveAttribute(
      'title',
      /not connected \(by design\)/,
    );
    await expect(page.getByTestId(`node-${id}`)).toHaveAttribute('data-status', 'offline');
  }
  for (const nic of ['node-1.eth1', 'node-1.eth3']) {
    await page.getByRole('tab', { name: 'Inspector' }).click();
    if ((await page.getByTestId('inspector-empty').count()) === 0) {
      await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    }
    await page.getByTestId('device-picker').selectOption(nic);
    await page.getByTestId('action-fail').click();
  }
  const clock = page.getByTestId('sim-clock');
  for (let i = 0; i < 12; i++) {
    await page.getByTestId('step').click();
    if (Number(await clock.getAttribute('data-step')) >= 4) break;
  }
  await expect(clock).toHaveAttribute('data-step', '4');
  const row = page.locator('[data-testid="impact-row"][data-vm="node-1.vm-1"]');
  await expect(row.locator('[data-kind="stalled"]').first()).toBeVisible();
  await expect(row.locator('[data-kind="redirected"]').first()).toContainText('via CVM 2');
});

test('guided steps scenario loads its topology and injects the failure', async ({ page }) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  await page.getByRole('tab', { name: 'Scenario' }).click();
  await page.getByTestId('scenario-select').selectOption('t1-34-steps-bond-does-not-fail-back');
  await expect(page.getByTestId('scenario-active')).toContainText('MAC-pinning bond');
  await page.getByTestId('scenario-apply-0').click();
  await expect(page.getByTestId('scenario-group').first()).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId('node-node-1.eth1')).toHaveAttribute('data-status', 'failed');
});
