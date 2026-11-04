# Link congestion and storage throughput (T1)

The simulator's message layer samples a few IOs per vDisk per tick. That decides **which** paths and links carry storage traffic: MAC pinning, LACP hashing, failover, redirects. It says nothing about **how much**. The throughput model adds rates on top of the same routes, so links can fill up, queue, and slow the IO that crosses them.

Nothing in the model is a congestion rule. There is no "if a link is full, add X µs" and no "share ∝ 1/latency". Saturation, queueing latency, the throughput cap and the path shift are outputs of four mechanisms.

## Mechanisms

1. **Line rate and a FIFO queue per link direction.** Links are full duplex, so each direction has its own line rate (`speedGbps` on the cable's NICs, or on the link itself for an ISL port-channel) and its own egress queue with a finite buffer. A queue's delay is the time to drain what is ahead of a frame. A queue that would need more delay than its buffer holds drops the excess, and the flows through it are cut to what the link serves (TCP backs off to the bottleneck).
2. **Closed-loop guests.** Each running VM keeps at most `queue depth × IO size` in flight. Its rate on a path is then outstanding ÷ round-trip latency (Little's law), up to the VM's offered-load cap. With `line-rate` there is no cap, so the guest pushes as hard as its queue depth allows and the NICs and links limit it.
3. **The multipath selector, as the initiator runs it.**
   - `queue-depth` sends each new IO to the path with the fewest outstanding, which keeps outstanding equal per path. A slower path completes its share more slowly, so it carries less.
   - `round-robin` gives every path the same number of IOs, so the rate is equal per path and the slowest path holds the most outstanding IO, dragging the whole VM down.
   - `active-passive` uses one path.
4. **Round-trip latency.** Base latency is the array service time (profile `flasharray.serviceTimeMs`, illustrative) plus serializing one IO on the slowest link. Each switch crossed adds the per-hop latency both ways, and every queue the path crosses adds its delay in both directions (FIFO queues delay commands, data and acks alike).

Write data travels host → array, on the request path. Read data travels array → host, on the response path. Each VM's read share (`read-pct`, or `vm.set-load`) splits its rate between the two directions.

## Solving each tick

A storage network settles in milliseconds, far below a 1 s tick, so each tick solves for the steady state. Queue delays rise on a direction only while it is offered more than its line rate, until the closed loops slow enough to fit (dual ascent, warm-started from the previous tick). `src/engine/network/flow-solver.ts` holds the solver; `src/domain/nutanix/flows.ts` feeds it from the live simulation.

## Routes are learned, not assumed

Every delivered NVMe/TCP IO frame and every iSCSI frame of the redirector this tick names the links it crossed. Each (source, destination) pair keeps a decaying weight per distinct route. LACP's per-connection hashing therefore shows up as several weighted routes for one path, and a failover or rebalance moves the route within a few ticks. NVMe keep-alives and iSCSI NOPs cross every path every tick. They give a path its route before its first sampled IO, at a weight too small to matter once IO routes are known. A VM joins the model once every one of its live paths has a known route.

## Feedback into the simulation

The solved queue delays are handed back to the network (`setQueueDelays`). Later frames on a congested direction carry the extra latency. The NVMe initiator measures it per path, and its queue-depth selector, which already weights paths by observed latency, sends the sampled IO elsewhere. VM latency (`ioLatencyUs`) and throughput (`throughputGbps`, `readGbps`, `writeGbps`) come from the same solution. A direction that reaches line rate emits `net.link.saturated` (and `net.link.unsaturated` when it clears).

## Inputs and confidence

| Input | Value | Confidence | Where |
|---|---|---|---|
| Node NICs, array data ports, ISL | 50 Gb, 100 Gb, 2 × 100 Gb (200 Gb per direction) | illustrative sizing | `src/topologies/t1-ahv-flasharray.ts` |
| Offered load per VM, read share | topology default 10 Gb, 70 % read; UI line rate, 70 % read | illustrative workload | options `vm-load-gbps`, `read-pct`; action `vm.set-load` |
| IO size | 256 KiB | assumption | `THROUGHPUT.ioSizeKiB` |
| Guest queue depth | 32 per vDisk | assumption | `WORKLOAD.queueDepth`, option `guest-queue-depth` |
| Switch port buffer | 32 MB per direction | assumption | `THROUGHPUT.portBufferMB` |
| Per-switch latency | 1 µs one way (cut-through is about 0.5–1.5 µs) | assumption | `THROUGHPUT.switchHopUs`; `docs/research/ovs-bond-behavior.md` |
| Array service time | profile `flasharray.serviceTimeMs` | assumption (display only before this model) | profile |

The absolute latencies are therefore illustrative. What carries over is the shape: which link fills first, how the IO shifts, and which design keeps working under load.

## What it shows (3 nodes, line-rate VMs at 70 % read)

| Design | Steady state | Every interface on the far switch |
|---|---|---|
| Two vSwitches, no bond | ISL 0 % | not possible: each interface has one NIC |
| MAC pinning, 4 array IPs | ISL 0 % when each interface sits on its VLAN's switch | Each node puts about 71 Gb on each ISL direction. Two nodes: 143 of 200 Gb, no queue. Three nodes: about 214 Gb offered, so the ISL runs at line rate with a queue, and every VM slows and sees more latency. The paths have no local alternative, so the selector cannot help. |
| MAC pinning, 8 array IPs | About half the IO crosses the ISL whatever the pinning (two of each interface's four portals are on the far switch) | Same: about 107 Gb per direction with three nodes, under line rate |
| LACP | Only requests hashed onto the far member cross; replies come back through the local member (MLAG forwarding) | — |

A line-rate VM is held by its node's NICs: 70 % reads fill both 50 Gb NICs inbound, so it runs at 100 Gb read + 43 Gb write, and its latency settles where outstanding ÷ rate says.

## Not modeled

- Packet-level TCP dynamics (slow start, incast, retransmit timers). Closed-loop outstanding IO stands in for TCP's window.
- PFC and pause frames. They are required off for NVMe/TCP to FlashArray (NET), so a full queue drops rather than pauses.
- Per-flow fairness inside a FIFO queue beyond proportional sharing.
- Array-internal limits (controller CPU, media): array ports are the only array-side capacity.
