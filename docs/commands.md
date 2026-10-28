# Commands: Nutanix (AHV / CVM) + Everpure FlashArray external storage

This is a field reference for setting up and checking an NCP compute cluster with an Everpure FlashArray over NVMe/TCP. Replace the `<placeholders>` with your own values.

**Status labels:**
- ✅ shown working in a deployment walkthrough
- ⚠️ needs care, or the exact syntax hasn't been confirmed
- 📘 from Everpure or Nutanix documentation
- 💬 community-documented only (Nutanix Community answers), not in a Nutanix guide

**Hard rule:** Nutanix creates and owns every `nx-*` host and volume on the array. **Look, don't touch.** Never modify, destroy or reconnect them by hand.

---

## 1. Everpure FlashArray (Purity CLI, `ssh <admin>@<array-mgmt>`)

**Purity versions:** the realm, pod and user steps can be done in the GUI on Purity 6.11 and 6.12. The management-access **policy** step is CLI-only.

| Step | Command | Notes |
|---|---|---|
| Create a realm | `purerealm create <realm>` 📘 | The GUI can do this too. Needs array-admin rights. |
| Create a pod **inside** the realm | GUI: **Realms → \<realm\> → Pods → +** ✅. CLI: `purepod create <realm>::<pod>` ⚠️ | The top-level Pods page can't place a pod in a realm. Leave **quota limit** off (see §4). |
| Create a realm-scoped admin policy | `purepolicy management-access create --realm <realm> --role admin <policy>` ✅ | There's no GUI for realm-scoped policies. |
| Create the integration user | GUI: **Settings → Users and Policies → Users → +**, then pick `<policy>` ✅ | A user with a realm policy sees only that realm. It can **only log in through the CLI or API**, not the GUI. LDAP/AD users can be assigned to the policy as well. |
| Check the user's scope | `ssh <user>@<array>` then `purevol list` and `purehost list` ✅ | As the realm user, only realm objects are listed. As an array admin, everything is. Logging in also confirms the password before you enter it in Prism. |
| List Nutanix-created volumes | `purevol list` ✅ | Names look like `<realm>::<pod>::nx-<cluster-id>-<n>-<suffix>`. Suffixes: `-dt` data, `-md` CBT metadata (only for SyncRep/Metro VMs or during a CCLM), `-cs` Cassandra, `-cu` Curator, `-zk` Zookeeper. There are three service volumes per CVM. |
| List Nutanix-created hosts | `purehost list` ✅ | Host objects: `cassandra`, `curator`, `zookeeper`, `stargate-1/2/3`. NQNs are filled in automatically. Volumes go to `stargate-1` until its per-host limit, then `stargate-2`, then `stargate-3`. That imbalance is by design. |
| Find leftover `-md` volumes | `purevol list --destroyed --filter "name = '*-md'"` 📘 ⚠️ | Use after upgrading to a Purity version with CBT offload; Curator purges `-md` volumes in the background. Check the filter syntax for your Purity version. |
| Read Nutanix tags on volumes | `purevol list --tags --filter="namespace='nutanix-integration.nutanix.com'" <volume>` ⚠️ | Nutanix tags its volumes in its own namespace, and the GUI doesn't show tags. In the walkthrough this query returned nothing. `--namespace` needs `--tags` (`purevol list --namespace <ns> --tags`). Treat the exact query as unconfirmed. |
| Check NVMe/TCP ports | GUI: **Settings → Network → Connectors** (filter by service `nvme-tcp`) ✅. CLI: `purenetwork eth list` 📘 | The data ports carry the `nvme-tcp` service. Typically the switch ports facing the array are **access** (untagged) ports, so there's no VLAN tagging on the array. |

**Optional protection, inside the Nutanix pod:**
- Create a protection group in the pod and set it as the pod's **default protection group**, so new volumes join it automatically ✅.
- A **ratcheted** (SafeMode) protection group protects its *snapshots* only. A user can still destroy and eradicate the volumes themselves ✅.
- Destroyed volumes and snapshots stay until the eradication timer expires.

---

## 2. Nutanix CVM (`ssh nutanix@<cvm-ip>`)

| Purpose | Command | Notes |
|---|---|---|
| Show physical NICs, link state and speed on **every** node | `allssh manage_ovs show_interfaces` ✅ 💬 | Prints `name / mode / link / speed` per node. Check that the storage ports (e.g. `eth5`, `eth7`) are up at 25 GbE or more before you build the vswitches. Not in the AHV 11.2 Admin Guide; Nutanix Community answers use it widely. |
| Show each bridge's uplinks and bond mode | `manage_ovs show_uplinks` 📘 | The command the AHV 11.2 Admin Guide documents, along with `manage_ovs --help`. |
| Network segmentation state | `network_segment_status` 📘 | Documented in the AOS Security Guide ("Disabling Network Segmentation"); prints whether segmentation is enabled. |
| Last network-segmentation task (why "Enable Service Network" failed) | `network_segment_status --last_task` ⚠️ | **The `--last_task` flag is unverified**: no public source documents it, so check with `network_segment_status --help`. The walkthrough ran it from a saved terminal button, so the exact command is inferred from its output. It shows the leader, the last operation, `service_name_str: kExternalStorage`, `sm_final_status`, the per-CVM `svm_ip_network_map`, and the VLAN. |
| Reachability to each FA data IP | `ping <fa-nvme-ip>` ✅ | Run it from a CVM after the internal interfaces exist. Each CVM gets one storage interface per segment (`ntnx0`, `ntnx1`, …). |
| **Jumbo frames end to end** (do-not-fragment) | `ping -M do -s 8972 <fa-nvme-ip>` | Standard Linux (iputils `ping(8)`), not a Nutanix-published command. `-M do` sets "don't fragment", and `-s` is the ICMP payload: 8972 = 9000 − 28 bytes of IP+ICMP headers. **Don't use `ping -s 8192 -d`.** On Linux `-d` is *socket debug*, not "don't fragment", so the packet can still be fragmented and the test passes falsely. A failure means some hop (endpoint or switch) isn't at MTU 9000. |
| CVM MTU health check | NCC check `cvm_mtu_check` 💬 ⚠️ | The Nutanix-native MTU check, as named in Nutanix Community answers. Look up its exact NCC invocation for your NCC version. |
| NVMe subsystems and paths seen by the CVM | `nvme list-subsys` 📘 | Shows the controllers/paths per subsystem. |
| NVMe log on the CVM | `/var/log/nvme.log` 📘 | Start here for path loss and reconnects. |
| Fault tolerance status | `ncli cluster get-domain-fault-tolerance-status type=node` 📘 | Shows how many node failures the cluster can currently absorb. |

**NICs added after deployment** are not picked up automatically. Nutanix provides a script to discover new NICs; see the Nutanix KB for your AOS version ⚠️.

---

## 3. AHV host (`ssh root@<host>`, or from a CVM: `hostssh "<cmd>"` / `ssh root@192.168.5.1`)

`ovs-appctl` runs **on the AHV host**, not in the CVM. From a CVM, reach the local host over the internal bridge, for example `ssh root@192.168.5.1 "ovs-appctl bond/show br0-up"` (AHV 11.2 Admin Guide). Bond names follow the bridge, such as `br0-up` for `vs0`.

| Purpose | Command | Notes |
|---|---|---|
| Bond state and active members | `ovs-appctl bond/show <bond-name>` 📘 | AHV 11.2 Admin Guide. Check that the storage vswitch's uplinks are enabled. For active-backup it names the active member; under MAC pinning (`balance-slb`) it also shows which source MAC hash is on which member. |
| LACP negotiation (only if the bond is LACP) | `ovs-appctl lacp/show <bond-name>` 📘 | AHV 11.2 Admin Guide: search the output for "negotiated". |
| Choose the active-backup member | `ovs-appctl bond/set-active-slave <bond-name> <interface>` 📘 ⚠️ | Everpure "Configure Nutanix Cluster for FlashArray". Moves the host's traffic to that uplink at once, so do it one host at a time. Spreading hosts across both switches limits what a hung switch can take down (simulator option `vs0-active-member`). |

---

## 4. Prism Element (GUI) steps

1. **Settings → Network Configuration → Virtual Switch → Create**.
   - Name it (e.g. `nvme-a`), set **MTU 9000**, and choose the bond type (see `docs/research/storage-network-configs.md`).
   - Pick the storage NIC on each node. If LLDP is enabled on the switches, Prism shows each port's switch port and VLAN, which is very useful for troubleshooting.
2. **Internal Interfaces → Create New Interface**.
   - Give it a name, the VLAN ID (or leave it untagged if the switch port is an access port), the vswitch, and an **IP pool** (one IP per node; keep n+1 or more free).
   - Feature: **External Storage**, **MTU 9000**.
   - If the array's storage subnet isn't directly reachable, set *Destination Subnets* and a *Gateway*.
   - **Expect a network validation.** The CVMs RPC each other over the new segment. A VLAN or trunk mismatch fails the task with "network validation failed". Check the result with the segmentation-status command (§2). Creating the interface takes several minutes.
3. Repeat steps 1–2 for the second fabric or VLAN.
4. **Dashboard → Set up External Storage**.
   - Vendor: Everpure FlashArray. Enter the array **management VIP** (`vir0`) or FQDN, plus the realm user's credentials.
   - Pick the realm and pod. If they're listed, the API connection works.
   - Name the storage container.
5. **Create VMs** in that container.
   - Every disk, UEFI NVRAM, TPM and CD-ROM becomes an array volume, and each counts toward the 10,000-vDisk cluster limit.
   - Prism Central (not Prism Element) shows each vDisk's backing array volume name.

**Quotas:** a pod quota counts **provisioned** size, including Nutanix's per-node cache, so VM or disk creates fail once that is exceeded. Prefer a Nutanix container quota, which counts used space. Otherwise size the pod quota generously; raising it later lets the pending task retry.
