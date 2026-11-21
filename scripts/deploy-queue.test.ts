import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { enterDeployQueue, type DeployQueueDeps } from "./deploy-queue";
import { randomToken, sha256 } from "../packages/server/src/crypto";

const MIN = 60_000;
const rev = (n: number) => String(n).repeat(40).slice(0, 40);

const noticeHash = await sha256(randomToken(48));

/** One D1 for several runs, each with its own clock reading the same shared time. */
function shared() {
  const db = new Database(":memory:");
  let now = 1_000_000_000_000;
  const run = (n: number, committedMinutes: number, extra: Partial<DeployQueueDeps> = {}): DeployQueueDeps => ({
    sql: async (statement) => db.query(statement).all() as Array<Record<string, unknown>>,
    revision: rev(n),
    committedAt: 1_700_000_000_000 + committedMinutes * MIN,
    // The hash the deploy script really sends: the same `sha256` the live Worker checks notices against.
    noticeHash,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    log: () => {},
    ...extra,
  });
  const rows = () => db.query("SELECT revision, state FROM prism_deploy_queue ORDER BY committed_at").all() as Array<{ revision: string; state: string }>;
  return { db, run, rows, advance: (ms: number) => { now += ms; } };
}

test("a run alone takes the turn at once, and its finish is remembered as the newest deployed", async () => {
  const { run, rows } = shared();
  const turn = await enterDeployQueue(run(1, 0));
  expect(turn.kind).toBe("deploy");
  expect(rows()).toEqual([{ revision: rev(1), state: "deploying" }]);
  if (turn.kind === "deploy") await turn.finish(true);
  expect(rows()).toEqual([{ revision: rev(1), state: "done" }]);
});

test("a newer run waits while another deploys, then takes its turn", async () => {
  const { run, rows } = shared();
  const first = await enterDeployQueue(run(1, 0));
  let polls = 0;
  const second = enterDeployQueue(run(2, 1, {
    // The first run finishes while the second is waiting.
    sleep: async () => { polls += 1; if (polls === 2 && first.kind === "deploy") await first.finish(true); },
  }));
  const turn = await second;
  expect(turn.kind).toBe("deploy");
  expect(polls).toBe(2);
  // Only the newest deployed release is remembered.
  if (turn.kind === "deploy") await turn.finish(true);
  expect(rows()).toEqual([{ revision: rev(2), state: "done" }]);
});

test("an older run steps aside for a newer one, whether it waits, deploys or has deployed", async () => {
  for (const state of ["waiting", "deploying", "done"] as const) {
    const { db, run, rows } = shared();
    await enterDeployQueue(run(1, 0)).then((turn) => turn.kind === "deploy" && turn.finish(true));
    db.run("DELETE FROM prism_deploy_queue");
    db.run(`INSERT INTO prism_deploy_queue VALUES ('${rev(3)}', ${1_700_000_000_000 + 5 * MIN}, '${state}', NULL, ${1_000_000_000_000})`);
    expect(await enterDeployQueue(run(2, 1))).toEqual({ kind: "superseded", by: rev(3) });
    // It leaves nothing behind.
    expect(rows()).toEqual([{ revision: rev(3), state }]);
  }
});

test("a run that stopped saying anything is gone, and its turn passes on", async () => {
  const { run, advance } = shared();
  const stuck = await enterDeployQueue(run(1, 0));
  expect(stuck.kind).toBe("deploy");
  advance(4 * MIN);
  expect((await enterDeployQueue(run(2, 1))).kind).toBe("deploy");
});

test("a failed run gives the turn up without being remembered, and the same commit may try again", async () => {
  const { run, rows } = shared();
  const turn = await enterDeployQueue(run(1, 0));
  if (turn.kind === "deploy") await turn.finish(false);
  expect(rows()).toEqual([]);
  expect((await enterDeployQueue(run(1, 0))).kind).toBe("deploy");
});

test("a run that waits too long gives up having changed nothing", async () => {
  const { run, rows, advance } = shared();
  const first = await enterDeployQueue(run(1, 0));
  // The first keeps its turn fresh the whole time the second waits.
  const second = run(2, 1, {
    maxWaitMs: 5 * MIN,
    sleep: async (ms) => { advance(ms); if (first.kind === "deploy") await first.heartbeat(); },
  });
  await expect(enterDeployQueue(second)).rejects.toThrow("Gave up waiting");
  expect(rows()).toEqual([{ revision: rev(1), state: "deploying" }]);
});

test("queues with the token hash as the deploy script and the live Worker compute it", async () => {
  const { run, db } = shared();
  const turn = await enterDeployQueue(run(1, 0));
  expect(turn.kind).toBe("deploy");
  // What the live Worker looks up before it lets this run tell the shops.
  expect(db.query("SELECT 1 AS ok FROM prism_deploy_queue WHERE notice_hash = ? AND state = 'deploying'").get(noticeHash)).toEqual({ ok: 1 });
  await expect(enterDeployQueue(run(2, 1, { noticeHash: "x'; DROP TABLE prism_deploy_queue; --" }))).rejects.toThrow("Invalid token hash");
});
