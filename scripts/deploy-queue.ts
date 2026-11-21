/**
 * Deployments take turns. Several pushes in a row start several builds at
 * once; each would install its own maintenance Worker and token over the
 * other's, and an older release could end up live, fenced, over a newer
 * schema. So each run queues in D1 (`prism_deploy_queue`, see
 * `packages/server/src/deployment-gate.ts`) before it changes anything:
 *
 * - one run deploys at a time; the others wait for it;
 * - a run that sees a newer commit waiting, deploying or deployed steps aside:
 *   that one carries everything this one would have;
 * - the run deploying keeps its row fresh; one silent for a few minutes is
 *   gone, and its turn passes on.
 *
 * Newer is by commit time, as the commits of one branch are pushed.
 */
import { DEPLOY_QUEUE_STALE_MS, deployQueueSchema } from "../packages/server/src/deployment-gate";

export type QueueRow = { revision: string; committed_at: number; state: "waiting" | "deploying" | "done"; heartbeat_at: number };

export type DeployQueueDeps = {
  /** Run one statement on the deployment's D1 and return its rows. */
  sql(statement: string): Promise<Array<Record<string, unknown>>>;
  revision: string;
  /** When the commit was made, in ms. */
  committedAt: number;
  /** The run's control token hash: the live Worker accepts notices from the run holding the turn. */
  noticeHash: string;
  now?: () => number;
  sleep(milliseconds: number): Promise<void>;
  log?: (line: string) => void;
  /** How often a waiting run looks again. */
  pollMs?: number;
  /** How long a run waits for its turn before giving up. */
  maxWaitMs?: number;
};

export type DeployTurn =
  | { kind: "deploy"; heartbeat(): Promise<void>; finish(deployed: boolean): Promise<void> }
  | { kind: "superseded"; by: string };

const hex = (value: string, name: string) => {
  if (!/^[0-9a-f]{7,64}$/.test(value)) throw new Error(`Invalid ${name} for the deploy queue`);
  return `'${value}'`;
};
/** The run's control token hash as the live Worker computes it (`sha256`: unpadded base64url), never hex. */
const tokenHash = (value: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid token hash for the deploy queue");
  return `'${value}'`;
};
const integer = (value: number) => {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid time for the deploy queue");
  return String(value);
};

/** Newer by commit time; the same second is settled by revision, so every run agrees. */
const newer = (row: QueueRow, mine: { revision: string; committedAt: number }) =>
  row.committed_at > mine.committedAt || (row.committed_at === mine.committedAt && row.revision > mine.revision);

export async function enterDeployQueue(deps: DeployQueueDeps): Promise<DeployTurn> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const me = hex(deps.revision, "revision");
  const mine = { revision: deps.revision, committedAt: deps.committedAt };
  const heartbeat = async () => { await deps.sql(`UPDATE prism_deploy_queue SET heartbeat_at = ${integer(now())} WHERE revision = ${me}`); };
  await deps.sql(deployQueueSchema);
  await deps.sql(
    `INSERT INTO prism_deploy_queue(revision, committed_at, state, notice_hash, heartbeat_at)
     VALUES (${me}, ${integer(deps.committedAt)}, 'waiting', ${tokenHash(deps.noticeHash)}, ${integer(now())})
     ON CONFLICT(revision) DO UPDATE SET state = 'waiting', notice_hash = excluded.notice_hash, heartbeat_at = excluded.heartbeat_at`,
  );
  const started = now();
  let waitingFor = "";
  for (;;) {
    const fresh = now() - DEPLOY_QUEUE_STALE_MS;
    const rows = (await deps.sql("SELECT revision, committed_at, state, heartbeat_at FROM prism_deploy_queue")) as QueueRow[];
    const others = rows.filter((row) => row.revision !== deps.revision && (row.state === "done" || row.heartbeat_at >= fresh));
    const ahead = others.find((row) => newer(row, mine));
    if (ahead) {
      await deps.sql(`DELETE FROM prism_deploy_queue WHERE revision = ${me}`);
      return { kind: "superseded", by: ahead.revision };
    }
    const deploying = others.find((row) => row.state === "deploying");
    if (!deploying) {
      // One statement: of two runs that get here together, one takes the turn.
      await deps.sql(
        `UPDATE prism_deploy_queue SET state = 'deploying', heartbeat_at = ${integer(now())}
         WHERE revision = ${me} AND NOT EXISTS (
           SELECT 1 FROM prism_deploy_queue o WHERE o.revision <> ${me} AND o.state = 'deploying' AND o.heartbeat_at >= ${integer(fresh)})`,
      );
      const [row] = (await deps.sql(`SELECT state FROM prism_deploy_queue WHERE revision = ${me}`)) as Array<Pick<QueueRow, "state">>;
      if (row?.state === "deploying") break;
    } else if (deploying.revision !== waitingFor) {
      waitingFor = deploying.revision;
      log(`Waiting for the deployment of ${deploying.revision.slice(0, 12)} to finish.`);
    }
    if (now() - started > (deps.maxWaitMs ?? 15 * 60_000)) {
      await deps.sql(`DELETE FROM prism_deploy_queue WHERE revision = ${me}`);
      throw new Error(`Gave up waiting for the deployment of ${waitingFor.slice(0, 12) || "another run"}; nothing was changed`);
    }
    await heartbeat();
    await deps.sleep(deps.pollMs ?? 15_000);
  }
  return {
    kind: "deploy",
    heartbeat,
    async finish(deployed) {
      // The newest deployed release is remembered, so an older build that starts later steps aside.
      await deps.sql(deployed
        ? `UPDATE prism_deploy_queue SET state = 'done', heartbeat_at = ${integer(now())} WHERE revision = ${me}`
        : `DELETE FROM prism_deploy_queue WHERE revision = ${me}`);
      if (deployed) await deps.sql(`DELETE FROM prism_deploy_queue WHERE state = 'done' AND revision <> ${me}`);
    },
  };
}
