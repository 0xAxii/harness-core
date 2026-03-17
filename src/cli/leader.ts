export interface LeaderWorkerLike {
  worker_instance_id: string;
  role_label: string;
}

export function resolveLeaderWorker<T extends LeaderWorkerLike>(workers: T[]): T | undefined {
  return workers.find((worker) => worker.worker_instance_id === 'worker-leader')
    ?? workers.find((worker) => worker.role_label === 'leader')
    ?? (workers.length === 1 ? workers[0] : undefined);
}

export function isLeaderWorker<T extends LeaderWorkerLike>(worker: T, leaderWorkerId: string | undefined): boolean {
  return leaderWorkerId !== undefined && worker.worker_instance_id === leaderWorkerId;
}
