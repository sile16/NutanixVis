import { expect, type Page, test } from '@playwright/test';
import { buildTopology, topologies, topologyIds } from '../../src/topologies';

/** One press of Step; a press runs in slices across frames, so wait until it has finished. */
async function stepOnce(page: Page): Promise<void> {
  const step = page.getByTestId('step');
  await step.click();
  await expect(step).toHaveAttribute('data-busy', 'false');
}

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
  await stepOnce(page);
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
  await stepOnce(page);
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
    await stepOnce(page);
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

test('real T1: Step holds at step 4 while waiting for recovery, and a restore shows later steps', async ({
  page,
}) => {
  test.slow();
  await page.goto('./#topology=t1-ahv-flasharray');
  await expect(page.getByTestId('node-node-1.vs2')).toBeVisible();
  await stepOnce(page);
  for (const nic of ['node-1.eth2', 'node-1.eth3']) {
    await page.getByRole('tab', { name: 'Inspector' }).click();
    if ((await page.getByTestId('inspector-empty').count()) === 0) {
      await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    }
    await page.getByTestId('device-picker').selectOption(nic);
    await page.getByTestId('action-fail').click();
  }
  const clock = page.getByTestId('sim-clock');
  const step = page.getByTestId('step');
  const press = async () => {
    await step.click();
    await expect(step).toHaveAttribute('data-busy', 'false');
  };
  // Each press runs through one step. The VM is redirected in step 4; with both NICs still failed,
  // only the failback is left and it cannot happen, so the counter holds there, waiting for the
  // user's recovery, instead of climbing.
  for (let i = 0; i < 6; i++) await press();
  const atSix = Number(await clock.getAttribute('data-step'));
  expect(atSix).toBe(4);
  await expect(clock).toContainText('waiting for recovery');
  let prev = atSix;
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
    await press();
    const now = Number(await clock.getAttribute('data-step'));
    expect(now).toBeGreaterThanOrEqual(prev);
    prev = now;
  }
  expect(prev).toBeGreaterThan(atSix);
  await expect(row.locator('[data-kind="recovered"]').first()).toBeVisible();
});

test('real T1: a failed CVM carries no I/O; a remote CVM serves the VM; failback after restore', async ({
  page,
}) => {
  test.slow();
  await page.goto('./#topology=t1-ahv-flasharray');
  const hop = (a: string, b: string) => page.locator(`.react-flow__edge[data-id="io:${a}>${b}"]`);
  await stepOnce(page);
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
    await stepOnce(page);
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
  for (let i = 0; i < 80; i++) await stepOnce(page);
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
    for (let i = 0; i < 6; i++) await stepOnce(page);
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
  await stepOnce(page);
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
    await stepOnce(page);
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
  // The topology menu names the scenario's own build, not the menu entry it shares an id with.
  await expect(page.getByTestId('topology-select').locator('option:checked')).toHaveText(
    'Scenario: One storage vSwitch (vs1), MAC pinning · one storage VLAN',
  );
  await page.getByTestId('scenario-apply-0').click();
  await expect(page.getByTestId('scenario-group').first()).toHaveAttribute('data-state', 'applied');
  await expect(page.getByTestId('node-node-1.eth2')).toHaveAttribute('data-status', 'failed');
});

test('guided tour: Step in the flow ticks off each expected observation at its step', async ({
  page,
}) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  await page.getByRole('tab', { name: 'Scenario' }).click();
  await page.getByTestId('scenario-select').selectOption('t1-33-steps-one-nic-dual-fabric');
  const obs = (stage: string) =>
    page.locator(`[data-testid="scenario-observation"][data-stage="${stage}"]`);
  await page.getByTestId('scenario-apply-0').click();
  await expect(obs('stall')).toHaveAttribute('data-seen', 'no');
  // Press 1: a partial stall, shown on the VM; the IO has not resumed yet.
  await page.getByTestId('scenario-step-0').click();
  await expect(page.getByTestId('scenario-step-now')).toHaveText('now at step 1');
  await expect(obs('stall')).toHaveAttribute('data-seen', 'yes');
  await expect(obs('resumed')).toHaveAttribute('data-seen', 'no');
  await expect(page.getByTestId('vm-partial-node-1.vm-1')).toContainText('% stalled');
  // Press 2: the stuck commands ran on the other fabric.
  await page.getByTestId('scenario-step-0').click();
  await expect(page.getByTestId('scenario-step-now')).toHaveText('now at step 2');
  await expect(obs('resumed')).toHaveAttribute('data-seen', 'yes');
  await expect(page.getByTestId('vm-partial-node-1.vm-1')).toHaveCount(0);
  if (process.env.SHOT) {
    await page.screenshot({ path: process.env.SHOT });
  }
});

test('guided bond tour: the "no IO stalls" note ticks once a step runs without a stall', async ({
  page,
}) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  await page.getByRole('tab', { name: 'Scenario' }).click();
  await page.getByTestId('scenario-select').selectOption('t1-33-steps-one-nic-bond');
  const note = page.getByTestId('scenario-observation').first();
  await expect(note).toHaveAttribute('data-seen', 'no');
  await page.getByTestId('scenario-apply-0').click();
  await page.getByTestId('scenario-step-0').click();
  await expect(page.getByTestId('scenario-step-now')).toHaveText('now at step 0');
  await expect(note).toHaveAttribute('data-seen', 'yes');
});

test('a CVM in Hades maintenance shows Cassandra down on its card', async ({ page }) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  await page.getByRole('tab', { name: 'Scenario' }).click();
  await page.getByTestId('scenario-select').selectOption('t1-32-steps-both-storage-nics-down');
  await expect(page.getByTestId('node-node-1.cvm')).not.toContainText('Cassandra down');
  await page.getByTestId('scenario-apply-0').click();
  for (let i = 0; i < 4; i++) await page.getByTestId('scenario-step-0').click();
  await expect(page.getByTestId('scenario-step-now')).toHaveText('now at step 4');
  await expect(page.getByTestId('node-node-1.cvm')).toContainText('Cassandra down');
});

test('the ISL edge shows its speeds each way, line-rate bars, and the share of storage IO', async ({
  page,
}) => {
  await page.goto('./#topology=t1-bonded-slb-8ip');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  for (let i = 0; i < 2; i++) await stepOnce(page);
  const isl = page.getByTestId('edge-label-l-sw-a--sw-b-1');
  await expect(isl).toContainText(/→\d+ ←\d+\s+5\d% of storage IO crosses/);
  await expect(isl.getByTestId('line-bars')).toBeVisible();
  // Array ports carry line-rate bars too, and the legend says what the numbers and bars mean.
  await expect(page.getByTestId('node-fa.ct0.eth10').getByTestId('line-bars')).toBeVisible();
  await expect(page.getByTestId('speed-legend')).toContainText('Gb/s each way');
  await page.goto('./#topology=t1-ahv-flasharray');
  await page.reload();
  await expect(page.getByTestId('edge-label-l-sw-a--sw-b-1')).toContainText('0% of storage IO');
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
  for (let i = 0; i < 3; i++) await stepOnce(page);
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
  for (let i = 0; i < 2; i++) await stepOnce(page);
  await page.getByTestId('device-picker').selectOption('node-1.vm-1');
  await expect(page.getByTestId('vm-throughput-summary')).toContainText('10.5 Gb/s');
  await expect(page.getByText('NVMe keep-alive')).toHaveCount(0);
});
test('the spare VM powers on and the inspector explains its paths', async ({ page }) => {
  await page.goto('./#topology=t1-bonded-slb');
  await expect(page.getByTestId('node-node-3.vm-1')).toBeVisible();
  await page.getByTestId('device-picker').selectOption('node-3.vm-1');
  // Powered off: no traffic of its own (not its host's).
  await expect(page.getByTestId('path-usage-idle')).toContainText('Powered off');
  await page.getByTestId('action-power-on').click();
  for (let i = 0; i < 4; i++) await stepOnce(page);
  await expect(page.getByTestId('vm-throughput-summary')).toContainText(
    /Gb\/s of line rate offered/,
  );
  await expect(page.getByTestId('vm-throughput-path')).toHaveCount(4);
  await expect(page.getByTestId('vm-throughput-paths')).toContainText('out Node 3');
});

/** Select a device through the inspector's picker (shown when nothing is selected). */
async function pickDevice(page: import('@playwright/test').Page, id: string) {
  await page.getByRole('tab', { name: 'Inspector' }).click();
  if ((await page.getByTestId('inspector-empty').count()) === 0) {
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  }
  await page.getByTestId('device-picker').selectOption(id);
}

test('live migration: the moved-VM marker and the inspector say live-migrated, not HA', async ({
  page,
}) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  await expect(page.getByTestId('node-node-1.vm-1')).toBeVisible();
  await pickDevice(page, 'node-1');
  await page.getByTestId('action-host.enter-maintenance').click();
  for (let i = 0; i < 4; i++) await stepOnce(page);
  const marker = page.getByTestId('restart-marker-node-1.vm-1');
  await expect(marker).toHaveAttribute('data-moved-by', 'live-migration');
  await expect(marker).toHaveAttribute('title', /live-migrated here from Node 1/);
  await pickDevice(page, 'node-1.vm-1');
  const placement = page.getByTestId('vm-placement');
  await expect(placement).toContainText('live-migrated from');
  await expect(placement).not.toContainText('AHV HA');
});

test('the ISL label stays on the surviving member, with only its line rate', async ({ page }) => {
  await page.goto('./#topology=t1-bonded-slb-8ip');
  await expect(page.getByTestId('node-node-1.vs1')).toBeVisible();
  for (let i = 0; i < 2; i++) await stepOnce(page);
  await expect(page.getByTestId('edge-label-l-sw-a--sw-b-1')).toBeVisible();
  await page.locator('.react-flow__edge[data-id="l-sw-a--sw-b-1"]').click({ force: true });
  await page.getByTestId('action-link-down').click();
  for (let i = 0; i < 2; i++) await stepOnce(page);
  await expect(page.getByTestId('edge-label-l-sw-a--sw-b-1')).toHaveCount(0);
  const label = page.getByTestId('edge-label-l-sw-a--sw-b-2');
  await expect(label).toContainText('of storage IO crosses');
  await expect(label.locator('span').first()).toHaveAttribute('title', /of 100 Gb\/s/);
});

test('a VM whose CVM is down shows an honest path-usage note, not its host traffic', async ({
  page,
}) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  await expect(page.getByTestId('node-node-1.vm-1')).toBeVisible();
  await pickDevice(page, 'node-1.cvm');
  await page.getByTestId('action-fail').click();
  await stepOnce(page);
  await pickDevice(page, 'node-1.vm-1');
  const usage = page.getByTestId('path-usage');
  // Never the T1-impossible "served by the local CVM over virbr0".
  await expect(page.getByTestId('path-usage-local')).toHaveCount(0);
  await expect(usage).not.toContainText('Far-end ports');
  // Redirected to CVM 2: its own traffic (NVMe/TCP from node 2), not "0 storage messages".
  for (let i = 0; i < 2; i++) await stepOnce(page);
  await expect(page.getByTestId('path-usage-scope')).toContainText("This VM's own paths");
  await expect(usage).toContainText('Node 2 eth');
  await expect(usage).not.toContainText('No storage traffic');
});
