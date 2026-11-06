import { expect, test } from '@playwright/test';
import { buildTopology, topologies, topologyIds } from '../../src/topologies';

/**
 * Every real topology renders from the live engine (loader) with all devices and cables. Hosts of
 * an external-array topology also draw two derived boxes each (the AHV redirector and Stargate),
 * and the internal I/O hops are extra edges next to the physical cables.
 */
for (const id of topologyIds) {
  test(`real topology ${id} renders every device and cable`, async ({ page }) => {
    // The UI builds T1 as the simple view: 3 nodes, 2 test VMs.
    const t =
      id === 't1-ahv-flasharray'
        ? buildTopology(id, {
            'node-count': 3,
            'vm-layout': 'two-plus-spare',
            'vm-load-gbps': 'line-rate',
            'read-pct': 70,
            'storage-vswitch-layout': 'per-fabric',
          })
        : topologies[id];
    // One Stargate box per CVM, plus a redirector box on every host that runs VMs.
    const derived = t.devices.some((d) => d.kind === 'fa-array')
      ? t.devices.filter((d) => d.kind === 'cvm').length +
        new Set(t.devices.filter((d) => d.kind === 'vm').map((d) => d.parent)).size +
        // A host with a CVM and no VMs draws an empty "no VMs" spacer instead of a redirector.
        t.devices.filter(
          (d) =>
            d.kind === 'cvm' && !t.devices.some((v) => v.kind === 'vm' && v.parent === d.parent),
        ).length
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
  await expect(hop('node-1.vs1', 'node-1.eth2')).toHaveAttribute('aria-label', /active/);

  for (const nic of ['node-1.eth2', 'node-1.eth3']) {
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
  await expect(hop('node-1.vs1', 'node-1.eth2')).toHaveAttribute('aria-label', /down/);
  const row = page.locator('[data-testid="impact-row"][data-vm="node-1.vm-1"]');
  await expect(row.locator('[data-kind="stalled"]').first()).toBeVisible();
  await expect(row.locator('[data-kind="redirected"]').first()).toContainText('via CVM 2');
  await expect(hop('node-1.redirector', 'node-1.host-mgmt')).toHaveAttribute(
    'aria-label',
    /active/,
  );
});

test('real T1: Step keeps counting past step 4, and a restore shows later steps', async ({
  page,
}) => {
  test.slow();
  await page.goto('./#topology=t1-ahv-flasharray');
  await expect(page.getByTestId('node-node-1.vs2')).toBeVisible();
  await page.getByTestId('step').click();
  for (const nic of ['node-1.eth2', 'node-1.eth3']) {
    await page.getByRole('tab', { name: 'Inspector' }).click();
    if ((await page.getByTestId('inspector-empty').count()) === 0) {
      await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    }
    await page.getByTestId('device-picker').selectOption(nic);
    await page.getByTestId('action-fail').click();
  }
  const clock = page.getByTestId('sim-clock');
  for (let i = 0; i < 10; i++) await page.getByTestId('step').click();
  const atTen = Number(await clock.getAttribute('data-step'));
  expect(atTen).toBeGreaterThanOrEqual(5);
  let prev = atTen;
  for (const nic of ['node-1.eth2', 'node-1.eth3']) {
    await page.getByRole('tab', { name: 'Inspector' }).click();
    if ((await page.getByTestId('inspector-empty').count()) === 0) {
      await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    }
    await page.getByTestId('device-picker').selectOption(nic);
    await page.getByTestId('action-recover').click();
  }
  const row = page.locator('[data-testid="impact-row"][data-vm="node-1.vm-1"]');
  for (let i = 0; i < 40; i++) {
    await page.getByTestId('step').click();
    const now = Number(await clock.getAttribute('data-step'));
    expect(now).toBeGreaterThanOrEqual(prev);
    prev = now;
  }
  expect(prev).toBeGreaterThan(atTen);
  await expect(row.locator('[data-kind="recovered"]').first()).toBeVisible();
});

test('real T1: a failed CVM carries no I/O; a remote CVM serves the VM; failback after restore', async ({
  page,
}) => {
  test.slow();
  await page.goto('./#topology=t1-ahv-flasharray');
  const hop = (a: string, b: string) => page.locator(`.react-flow__edge[data-id="io:${a}>${b}"]`);
  await page.getByTestId('step').click();
  await expect(hop('node-1.redirector', 'node-1.cvm.stargate')).toHaveAttribute(
    'aria-label',
    /active/,
  );
  await page.getByRole('tab', { name: 'Inspector' }).click();
  if ((await page.getByTestId('inspector-empty').count()) === 0) {
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  }
  await page.getByTestId('device-picker').selectOption('node-1.cvm');
  await page.getByTestId('action-fail').click();
  const clock = page.getByTestId('sim-clock');
  // The path through the failed CVM is down at every step, never in use.
  for (let i = 0; i < 6; i++) {
    await page.getByTestId('step').click();
    await expect(hop('node-1.redirector', 'node-1.cvm.stargate')).toHaveAttribute(
      'aria-label',
      /down/,
    );
    await expect(hop('node-1.cvm.storage-a', 'node-1.vs1')).toHaveAttribute('aria-label', /down/);
    await expect(hop('node-1.vs1', 'node-1.eth2')).not.toHaveAttribute('aria-label', /active/);
  }
  // Redirected: the remote CVM carries the I/O through its own NICs.
  await expect(hop('node-1.redirector', 'node-1.host-mgmt')).toHaveAttribute(
    'aria-label',
    /active/,
  );
  await expect(hop('node-2.vs1', 'node-2.eth2')).toHaveAttribute('aria-label', /active/);
  const row = page.locator('[data-testid="impact-row"][data-vm="node-1.vm-1"]');
  await expect(row.locator('[data-kind="redirected"]').first()).toContainText('via CVM 2');
  const atFail = Number(await clock.getAttribute('data-step'));

  await page.getByRole('tab', { name: 'Inspector' }).click();
  if ((await page.getByTestId('inspector-empty').count()) === 0) {
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  }
  await page.getByTestId('device-picker').selectOption('node-1.cvm');
  await page.getByTestId('action-recover').click();
  // Keep stepping: the CVM comes back, then the sessions fail back to the local CVM.
  for (let i = 0; i < 80; i++) await page.getByTestId('step').click();
  expect(Number(await clock.getAttribute('data-step'))).toBeGreaterThan(atFail);
  await expect(hop('node-1.redirector', 'node-1.host-mgmt')).toHaveCount(0);
  await expect(hop('node-1.redirector', 'node-1.cvm.stargate')).toHaveAttribute(
    'aria-label',
    /active/,
  );
});

for (const id of ['t1-bonded-slb', 't1-bonded-slb-8ip', 't1-bonded-lacp', 't1-bonded-lacp-8ip']) {
  test(`${id}: a member loss is a 0-step, no-interruption event`, async ({ page }) => {
    await page.goto(`./#topology=${id}`);
    await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
    await page.getByTestId('device-picker').selectOption('node-1.eth2');
    await page.getByTestId('action-fail').click();
    for (let i = 0; i < 6; i++) await page.getByTestId('step').click();
    await expect(page.getByTestId('sim-clock')).toHaveAttribute('data-step', '0');
    await expect(page.getByTestId('impact-bond')).toContainText('no interruption');
    await expect(page.getByTestId('impact-summary')).toContainText('no VM interrupted');
    await expect(page.getByTestId('node-node-1.eth3').getByTestId('node-note')).toHaveText(
      'active',
    );
    await expect(page.getByTestId('node-node-1.eth2').getByTestId('node-note')).toHaveText('down');
  });
}

test('MAC-pinning trunk variant: all four array ports connected, both NICs down', async ({
  page,
}) => {
  test.slow();
  await page.goto('./#topology=t1-bonded-slb');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  await page.getByTestId('step').click();
  // All four array ports are cabled: none is marked as not connected.
  for (const id of [
    'fa.ct0.eth10.v10',
    'fa.ct1.eth10.v10',
    'fa.ct0.eth11.v20',
    'fa.ct1.eth11.v20',
  ]) {
    await expect(page.getByTestId(`node-${id}`)).not.toHaveAttribute(
      'title',
      /not connected \(by design\)/,
    );
    await expect(page.getByTestId(`node-${id}`)).not.toHaveAttribute('data-status', 'offline');
  }
  for (const nic of ['node-1.eth2', 'node-1.eth3']) {
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
  await expect(page.getByTestId('node-node-1.eth2')).toHaveAttribute('data-status', 'failed');
});

test('the ISL edge shows its speeds each way, line-rate bars, and the share of storage IO', async ({
  page,
}) => {
  await page.goto('./#topology=t1-bonded-slb-8ip');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  for (let i = 0; i < 2; i++) await page.getByTestId('step').click();
  const isl = page.getByTestId('edge-label-l-sw-a--sw-b');
  await expect(isl).toContainText(/→\d+ ←\d+\s+5\d% of storage IO crosses/);
  await expect(isl.getByTestId('line-bars')).toBeVisible();
  // Array ports carry line-rate bars too, and the legend says what the numbers and bars mean.
  await expect(page.getByTestId('node-fa.ct0.eth10').getByTestId('line-bars')).toBeVisible();
  await expect(page.getByTestId('speed-legend')).toContainText('Gb/s each way');
  await page.goto('./#topology=t1-ahv-flasharray');
  await page.reload();
  await expect(page.getByTestId('edge-label-l-sw-a--sw-b')).toContainText('0% of storage IO');
  // Line-rate VMs fill their node NICs: the inbound bar is full.
  await expect(
    page.getByTestId('node-node-1.eth2').locator('[data-testid="line-bars"] [data-tone="full"]'),
  ).toBeVisible();
});

test('a failed bond member: the bond bar shows 100% on the survivor', async ({ page }) => {
  await page.goto('./#topology=t1-bonded-slb');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  await page.getByTestId('device-picker').selectOption('node-1.eth2');
  await page.getByTestId('action-fail').click();
  for (let i = 0; i < 3; i++) await page.getByTestId('step').click();
  await expect(page.getByTestId('node-node-1.vs1').getByTestId('share-bars')).toHaveAttribute(
    'aria-label',
    /eth2 0% · eth3 100%/,
  );
  await expect(page.getByTestId('edge-label-l-node-1.eth3--sw-b')).toContainText(/↓21 ↑50/);
  await expect(
    page.getByTestId('node-node-1.cvm.stargate').getByTestId('share-bars'),
  ).toBeVisible();
});

test('speeds toggle, IOPS slider, and no NVMe keep-alives in the legend', async ({ page }) => {
  await page.goto('./#topology=t1-bonded-slb');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  await expect(page.getByTestId('edge-label-l-node-1.eth2--sw-a')).toContainText(/↓\d+ ↑\d+/);
  await page.getByTestId('toggle-speeds').click();
  await expect(page.getByTestId('edge-label-l-node-1.eth2--sw-a')).toHaveCount(0);
  await expect(page.getByTestId('node-node-1.eth2').getByTestId('line-bars')).toBeVisible();
  await page.getByTestId('toggle-speeds').click();
  const slider = page.getByTestId('iops-slider');
  await slider.focus();
  await slider.press('Home');
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await expect(page.getByTestId('iops-value')).toContainText('5k');
  for (let i = 0; i < 2; i++) await page.getByTestId('step').click();
  await page.getByTestId('device-picker').selectOption('node-1.vm-1');
  await expect(page.getByTestId('vm-throughput-summary')).toContainText('10.5 Gb/s');
  await expect(page.getByText('NVMe keep-alive')).toHaveCount(0);
});
test('the spare VM powers on and the inspector explains its paths', async ({ page }) => {
  await page.goto('./#topology=t1-bonded-slb');
  await expect(page.getByTestId('node-node-3.vm-1')).toBeVisible();
  await page.getByTestId('device-picker').selectOption('node-3.vm-1');
  await page.getByTestId('action-power-on').click();
  for (let i = 0; i < 4; i++) await page.getByTestId('step').click();
  await expect(page.getByTestId('vm-throughput-summary')).toContainText(
    /Gb\/s of line rate offered/,
  );
  await expect(page.getByTestId('vm-throughput-path')).toHaveCount(4);
  await expect(page.getByTestId('vm-throughput-paths')).toContainText('out Node 3');
});
