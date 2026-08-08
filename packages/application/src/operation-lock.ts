import { PrismDomainError, type OperationLockRepository } from "@prism/core";

export async function withOperationLease<T>(input: {
  repository?: OperationLockRepository;
  scope: string;
  resourceId: string;
  id?: () => string;
  now: () => Date;
  ttlMs?: number;
}, action: () => Promise<T>): Promise<T> {
  if (!input.repository) return action();
  const now = input.now();
  const lockId = input.id?.() ?? crypto.randomUUID();
  const acquired = await input.repository.acquire(
    input.scope,
    input.resourceId,
    lockId,
    now,
    new Date(now.getTime() + (input.ttlMs ?? 60_000)),
  );
  if (!acquired) throw new PrismDomainError("Operation is already in progress.", "OPERATION_IN_PROGRESS");
  try {
    return await action();
  } finally {
    await input.repository.release(input.scope, input.resourceId, lockId);
  }
}
