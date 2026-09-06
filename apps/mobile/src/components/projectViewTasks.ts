export type ProjectViewTask = {
  readonly epoch: number;
  readonly projectId: string | null;
  readonly kind: 'list' | 'detail' | 'mutation' | 'push' | 'diff' | 'files';
};

/** UI ownership only: invalidating a view does not cancel native effects. */
export class ProjectViewTasks {
  private epoch = 0;
  private projectId: string | null = null;
  private active = new Set<ProjectViewTask>();
  private latest = new Map<ProjectViewTask['kind'], ProjectViewTask>();
  visible = false;

  invalidate(projectId = this.projectId) {
    this.projectId = projectId;
    this.epoch += 1;
    this.latest.clear();
  }

  begin(kind: ProjectViewTask['kind']): ProjectViewTask {
    // Any intervening refresh or mutation invalidates an unconfirmed push.
    const push = this.latest.get('push');
    if (kind !== 'push' && push !== undefined && !this.active.has(push))
      this.latest.delete('push');
    const task = { epoch: this.epoch, kind, projectId: this.projectId };
    this.active.add(task);
    this.latest.set(kind, task);
    return task;
  }

  owns(task: ProjectViewTask): boolean {
    return (
      this.visible &&
      task.epoch === this.epoch &&
      this.latest.get(task.kind) === task
    );
  }

  finish(task: ProjectViewTask) {
    this.active.delete(task);
  }

  get busy(): boolean {
    return (
      this.visible &&
      [...this.active].some(
        task =>
          this.owns(task) ||
          ((task.kind === 'mutation' || task.kind === 'push') &&
            task.projectId === this.projectId),
      )
    );
  }

  get pushing(): boolean {
    return (
      this.visible &&
      [...this.active].some(
        task => task.kind === 'push' && task.projectId === this.projectId,
      )
    );
  }
}
