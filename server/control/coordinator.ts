import type { RemoteControlState } from "../../shared/control";
import { ComputerUseToolError } from "../computer-use-mcp/contract/errors";

export interface AgentAction { callerId: string; agentId?: string | null; toolName: string; app?: string; mutating: boolean }
export interface ControlDependencies {
  stopAgent(): Promise<unknown>;
  releaseInput(): Promise<void>;
  showNotice(state: RemoteControlState): Promise<void>;
  updateNotice(state: RemoteControlState): void;
  persist(state: { paused: boolean; humanPriority: boolean }): Promise<void>;
}

/** One authority for MCP and viewer input. Revocation is synchronous; handoff waits for I/O cleanup. */
export class ControlCoordinator {
  private state: RemoteControlState;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private persistence: Promise<void> = Promise.resolve();
  private stopped = false;
  private handoff: Promise<unknown> = Promise.resolve();
  private notice: Promise<void> | null = null;
  constructor(private readonly deps: ControlDependencies, initial = { paused: false, humanPriority: false }) {
    this.state = { ...initial, mode: initial.paused ? "paused" : initial.humanPriority ? "human" : "idle",
      callerId: null, agentId: null, label: initial.humanPriority ? "Human control" : "Ready", tool: null, app: null,
      since: Date.now(), revision: 0, noticeError: null };
  }
  snapshot(): RemoteControlState { return { ...this.state }; }
  initialize(initial: { paused: boolean; humanPriority: boolean }): void {
    if (this.state.revision !== 0) throw new Error("Control was initialized after use");
    this.change({ ...initial, mode: initial.paused ? "paused" : initial.humanPriority ? "human" : "idle", label: initial.paused ? "All control paused" : initial.humanPriority ? "Human control" : "Ready" });
  }
  private change(next: Partial<RemoteControlState>): void {
    this.state = { ...this.state, ...next, revision: this.state.revision + 1 };
    this.deps.updateNotice(this.snapshot());
  }
  private save(values = this.state): Promise<void> {
    const { paused, humanPriority } = values;
    const next = this.persistence.then(() => this.deps.persist({ paused, humanPriority }));
    this.persistence = next.catch(() => {});
    return next;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.pending >= 64) return Promise.reject(new Error("Remote control queue is full"));
    this.pending++;
    const result = this.tail.then(action).finally(() => { this.pending--; });
    this.tail = result.catch(() => {});
    return result;
  }
  assertAgentAllowed(): void {
    if (this.stopped || this.state.paused || this.state.humanPriority) {
      throw new ComputerUseToolError("aborted_by_user", "Human control has priority. Stop Computer Use; do not retry until the user explicitly allows agents again.");
    }
  }
  async beforeAgent(action: AgentAction): Promise<void> {
    this.assertAgentAllowed();
    if (!action.mutating) return;
    if (this.state.callerId && this.state.callerId !== action.callerId) {
      throw new ComputerUseToolError("computer_busy", "Another agent owns Remote Control.");
    }
    const first = this.state.mode !== "agent";
    const generation = this.generation;
    if (first) this.change({ mode: "agent", callerId: action.callerId, agentId: action.agentId ?? null,
      label: `Agent ${(action.agentId ?? action.callerId).slice(0, 8)}`, tool: action.toolName, app: action.app ?? null,
      ...(first ? { since: Date.now() } : {}) });
    if (first) this.notice = this.deps.showNotice(this.snapshot());
    if (this.notice) {
      try { await this.notice; }
      catch (error) {
        if (generation === this.generation) this.change({ mode: "idle", callerId: null, agentId: null, label: "Notice unavailable", tool: null, app: null, noticeError: String(error) });
        throw new ComputerUseToolError("helper_unavailable", `A visible control notice is required before acting: ${String(error)}`);
      }
    }
    this.assertAgentAllowed();
    if (generation !== this.generation || this.state.callerId !== action.callerId) throw new ComputerUseToolError("aborted_by_user", "Control was revoked before the action started.");
  }
  runAgent<T>(action: AgentAction, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    return this.serial(async () => {
      signal.throwIfAborted(); this.assertAgentAllowed();
      if (generation !== this.generation || (action.mutating && this.state.callerId !== action.callerId)) {
        throw new ComputerUseToolError("aborted_by_user", "This queued action belongs to a revoked control session.");
      }
      if (this.state.mode === "agent" && this.state.callerId === action.callerId) this.change({ tool: action.toolName, app: action.app ?? null });
      return run();
    });
  }
  releaseAgent(callerId?: string): void {
    if (this.state.mode !== "agent" || (callerId && callerId !== this.state.callerId)) return;
    this.generation++;
    this.change({ mode: "idle", callerId: null, agentId: null, label: "Ready", tool: null, app: null, since: Date.now() });
  }
  async takeOver(): Promise<RemoteControlState> {
    this.generation++;
    this.change({ humanPriority: true, mode: this.state.paused ? "paused" : "human", callerId: null, agentId: null,
      label: "Human control", tool: null, app: null, since: Date.now() });
    const saved = this.save();
    const handoff = (async () => {
      await this.deps.stopAgent();
      await this.serial(() => this.deps.releaseInput());
      await saved;
    })();
    this.handoff = handoff;
    await handoff;
    return this.snapshot();
  }
  async runHuman<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopped || this.state.paused) throw new Error("Remote control is paused");
    if (this.state.mode === "agent") throw new Error("An agent is controlling the computer. Use Take over first.");
    const handoff = !this.state.humanPriority ? this.takeOver() : this.handoff;
    const generation = this.generation;
    await handoff;
    return this.serial(async () => {
      if (this.stopped || this.state.paused || !this.state.humanPriority || generation !== this.generation) throw new Error("This human input belongs to a revoked control session");
      return run();
    });
  }
  async runDisplayTransition<T>(run: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    await this.takeOver();
    const generation = this.generation;
    return this.runHuman(async () => {
      const assertCurrent = () => {
        if (this.stopped || this.state.paused || !this.state.humanPriority || generation !== this.generation) throw new Error("Display transition was cancelled by a control change");
      };
      assertCurrent();
      return run(assertCurrent);
    });
  }
  async releaseHumanInput(release: () => Promise<void>): Promise<void> {
    await this.serial(async () => {
      if (this.state.mode !== "agent") await release();
    });
  }
  async allowAgents(): Promise<RemoteControlState> {
    if (this.stopped || this.state.paused) throw new Error("Resume remote control before allowing agents");
    if (this.state.mode === "agent") throw new Error("Take over before changing agent access");
    const generation = this.generation;
    await this.handoff;
    // Keep the human latch set until every earlier input has drained and all keys are up.
    await this.serial(() => this.deps.releaseInput());
    if (this.state.paused || generation !== this.generation) throw new Error("Control changed while allowing agents");
    await this.save({ ...this.state, paused: false, humanPriority: false });
    if (generation !== this.generation || this.state.paused) throw new Error("Control changed while saving agent access");
    this.generation++;
    this.change({ humanPriority: false, mode: "idle", callerId: null, agentId: null, label: "Ready", tool: null, app: null, noticeError: null, since: Date.now() });
    return this.snapshot();
  }
  async pause(paused: boolean): Promise<RemoteControlState> {
    this.generation++;
    this.change({ paused, humanPriority: true, mode: paused ? "paused" : "human", callerId: null, agentId: null,
      label: paused ? "All control paused" : "Human control", tool: null, app: null, since: Date.now() });
    const saved = this.save();
    const handoff = (async () => {
      await this.deps.stopAgent();
      await this.serial(() => this.deps.releaseInput());
      await saved;
    })();
    this.handoff = handoff;
    await handoff;
    return this.snapshot();
  }
  async stop(): Promise<void> { this.stopped = true; this.generation++; await this.deps.stopAgent(); await this.serial(() => this.deps.releaseInput()); }
}
