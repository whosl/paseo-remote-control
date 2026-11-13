import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { allowAgentsRpc, ownershipRpc, takeoverRpc, type RemoteControlState } from "../shared/control";

export function useOwnership(hostId: string) {
  const read = useRpc(ownershipRpc), take = useRpc(takeoverRpc), allow = useRpc(allowAgentsRpc);
  const queries = useQueryClient();
  const queryKey = ["remote-control", "ownership", hostId];
  const state = useQuery({ queryKey, queryFn: () => read({}), refetchInterval: 400, retry: 1 });
  const changed = (result: RemoteControlState) => queries.setQueryData(queryKey, result);
  const takeover = useMutation({ mutationFn: () => take({}), onSuccess: changed });
  const allowAgents = useMutation({ mutationFn: () => allow({}), onSuccess: changed });
  return { state: state.data, known: !!state.data && !state.isError, changing: takeover.isPending || allowAgents.isPending,
    takeOver: () => takeover.mutate(), allowAgents: () => allowAgents.mutate(),
    error: takeover.error?.message ?? allowAgents.error?.message ?? state.error?.message ?? null };
}
