import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const remoteControlState = z.object({
  mode: z.enum(["idle", "agent", "human", "paused"]),
  paused: z.boolean(),
  humanPriority: z.boolean(),
  agentId: z.string().nullable(),
  callerId: z.string().nullable(),
  label: z.string(),
  tool: z.string().nullable(),
  app: z.string().nullable(),
  since: z.number(),
  revision: z.number(),
  noticeError: z.string().nullable(),
});
export type RemoteControlState = z.infer<typeof remoteControlState>;
export const ownershipRpc = defineRpc({ name: "remote-control.state", input: z.object({}), output: remoteControlState });
export const viewerIdSchema = z.string().uuid();
export const viewerOpenRpc = defineRpc({ name: "remote-control.viewer-open", input: z.object({}), output: z.object({ viewerId: viewerIdSchema }) });
export const viewerCloseRpc = defineRpc({ name: "remote-control.viewer-close", input: z.object({ viewerId: viewerIdSchema }), output: remoteControlState });
export const takeoverRpc = defineRpc({ name: "remote-control.takeover", input: z.object({ viewerId: viewerIdSchema.optional() }), output: remoteControlState });
export const allowAgentsRpc = defineRpc({ name: "remote-control.allow-agents", input: z.object({}), output: remoteControlState });
