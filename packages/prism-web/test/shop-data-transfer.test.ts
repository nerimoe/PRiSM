import { expect, test } from "bun:test";
import { readShopBackup } from "../src/shop-data-transfer";
const encoder = new TextEncoder();
function stream(value: string, size = 3) {
  const bytes = encoder.encode(value);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(index, (index += size)));
    },
  });
}
async function read(value: string, size?: number) {
  const rows: unknown[] = [],
    headers: unknown[] = [],
    tables: unknown[] = [];
  const counts = await readShopBackup(stream(value, size), {
    async header(h) {
      headers.push(h);
    },
    async row(table, row) {
      rows.push({ table, row });
    },
    async tableEnd(table, count) {
      tables.push([table, count]);
    },
  });
  return { rows, headers, tables, counts };
}
test("streaming JSON preserves UTC, cents, escaped and multibyte text across byte boundaries", async () => {
  const row = {
    id: '玩家"\\\n',
    started_at: "2026-10-02T02:08:00.000Z",
    amount: 114514,
    timeline_json: JSON.stringify({ label: "日本🎵", quote: '{["\\' }),
  };
  const value = { format: "prism-shop-data", version: 2, tables: { empty: [], players: [row], last: [] } };
  const result = await read(JSON.stringify(value));
  expect(result.headers).toEqual([{ format: "prism-shop-data", version: 2 }]);
  expect(result.rows).toEqual([{ table: "players", row }]);
  expect(result.counts).toEqual({ empty: 0, players: 1, last: 0 });
});
test("a row above the former 128 KiB ceiling parses without reading a complete table", async () => {
  const row = { timeline_json: "账单".repeat(90000) };
  const result = await read(JSON.stringify({ version: 1, tables: { checkout_timelines: [row, row] } }), 8192);
  expect(result.rows).toHaveLength(2);
  expect((result.rows[0] as any).row).toEqual(row);
});
test("truncation, duplicate tables/metadata, trailing content and trailing commas fail", async () => {
  for (const value of [
    '{"version":1,"tables":{"players":[{"id":"p"}]}',
    '{"tables":{}} garbage',
    '{"tables":{"p":[],"p":[]}}',
    '{"version":1,"version":2,"tables":{}}',
    '{"tables":{"p":[{},]}}',
    '{"tables":{"p":[],}}',
    '{"tables":{},"version":2}',
    '{"version":2}',
  ])
    await expect(read(value)).rejects.toThrow("请选择有效的 JSON 备份文件");
});
