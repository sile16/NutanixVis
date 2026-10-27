/**
 * Static React Flow type maps. Defined once at module level (never inside a component), as React
 * Flow re-mounts every node when these objects change identity.
 */
import type { EdgeTypes, NodeTypes } from '@xyflow/react';
import { CableEdgeView } from './edges/cable-edge';
import {
  ArrayNode,
  ControllerNode,
  CvmNode,
  DiskNode,
  GenericNode,
  HostNode,
  IfaceNode,
  NicNode,
  SwitchNode,
  VmNode,
  VswitchNode,
} from './nodes/device-nodes';

export const nodeTypes = {
  switch: SwitchNode,
  host: HostNode,
  cvm: CvmNode,
  vm: VmNode,
  array: ArrayNode,
  controller: ControllerNode,
  nic: NicNode,
  iface: IfaceNode,
  vswitch: VswitchNode,
  disk: DiskNode,
  generic: GenericNode,
} satisfies NodeTypes;

export const edgeTypes = { cable: CableEdgeView } satisfies EdgeTypes;
