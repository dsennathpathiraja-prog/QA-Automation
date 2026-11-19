import { PlatformError, type ContainerEngine, type ContainerState } from '@qa/domain';

interface Rec {
  state: ContainerState;
  body: Record<string, unknown>;
}

/** In-memory container engine for launcher tests. `add` plants containers the platform does not manage. */
export class FakeContainerEngine implements ContainerEngine {
  readonly containers = new Map<string, Rec>();
  readonly created: { name: string; body: Record<string, unknown> }[] = [];
  readonly images = new Map<string, { id: string }>();
  readonly output = new Map<string, string>();
  private seq = 0;

  async create(name: string, body: Record<string, unknown>) {
    if ([...this.containers.values()].some((c) => c.state.name === name)) throw new PlatformError('conflict', 'name in use');
    const id = `c${(this.seq += 1).toString().padStart(4, '0')}`;
    this.created.push({ name, body });
    this.containers.set(id, { body, state: { id, name, status: 'created', labels: (body.Labels as Record<string, string>) ?? {} } });
    return { id };
  }

  async start(id: string) {
    const c = this.get(id);
    c.state.status = 'running';
    c.state.startedAt = new Date();
  }

  async inspect(idOrName: string) {
    return [...this.containers.values()].find((c) => c.state.id === idOrName || c.state.name === idOrName)?.state;
  }

  async stop(id: string) {
    const c = this.containers.get(id);
    if (c && (c.state.status === 'running' || c.state.status === 'created')) Object.assign(c.state, { status: 'exited', exitCode: 137, finishedAt: new Date() });
  }

  async list(labels: Record<string, string>) {
    return [...this.containers.values()].map((c) => c.state).filter((s) => Object.entries(labels).every(([k, v]) => s.labels[k] === v));
  }

  async inspectImage(ref: string) {
    return this.images.get(ref);
  }

  async logs(id: string) {
    return this.output.get(id) ?? '';
  }

  add(state: ContainerState) {
    this.containers.set(state.id, { state, body: {} });
  }

  private get(id: string): Rec {
    const c = this.containers.get(id);
    if (!c) throw new PlatformError('not-found', 'no such container');
    return c;
  }
}
