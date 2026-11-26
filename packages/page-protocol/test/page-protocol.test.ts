import { describe, expect, test } from "bun:test";
import {
  allPageBlocks,
  buildButtonPayload,
  canSubmitButton,
  reconcileFieldValues,
  resolvePageImageUrl,
  walkPageBlocks,
  type Page,
  type PageBill,
  type PageBlock,
  type PageButton,
  type PageList,
} from "../src";

describe("page protocol rules", () => {
  const submitButton: PageButton = {
    kind: "button",
    id: "submit",
    label: "提交",
    style: "primary",
    enabled: true,
    action: "custom.submit",
    requires: "agree",
    collect: ["code", "slot", "notify", "agree"],
    payload: { expectedVersion: 9, code: "SERVER_FIXED" },
    needsLocation: false,
  };

  const blocks: PageBlock[] = [
    {
      kind: "section",
      id: "outer",
      style: "card",
      blocks: [
        { kind: "input", id: "code", name: "code", defaultValue: "0042", required: true, maxLength: 6 },
        {
          kind: "select",
          id: "slot",
          name: "slotId",
          required: true,
          defaultValue: "a",
          options: [
            { value: "a", label: "A" },
            { value: "disabled", label: "Disabled", disabled: true },
          ],
        },
        { kind: "toggle", id: "notify", name: "notifyMe", label: "Notify", defaultValue: true, required: true },
        { kind: "consent", id: "agree", text: "Agree" },
        { kind: "row", id: "actions", blocks: [submitButton] },
      ],
    },
  ];

  test("walks nested containers and caps depth at 8", () => {
    expect(walkPageBlocks(blocks).map((b) => b.id)).toEqual(["outer", "code", "slot", "notify", "agree", "actions", "submit"]);
    let node: PageBlock = { kind: "text", id: "leaf", text: "end" };
    for (let i = 9; i >= 0; i--) node = { kind: "section", id: `d${i}`, blocks: [node] };
    expect(walkPageBlocks([node]).map((b) => b.id)).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"]);
  });

  test("reconciles form defaults, preserves user edits, resets mismatched types, and prunes removed IDs", () => {
    const initial = reconcileFieldValues(blocks, { stale: "drop-me", code: false as unknown as string, slot: "a" });
    expect(initial).toEqual({ code: "0042", slot: "a", notify: true, agree: false });

    const edited = reconcileFieldValues(blocks, { ...initial, code: "0099", agree: true });
    expect(edited).toEqual({ code: "0099", slot: "a", notify: true, agree: true });
  });

  test("validates required input, select, toggle, consent, and requires before enabling submit", () => {
    expect(canSubmitButton(submitButton, blocks, { code: "0042", slot: "a", notify: true, agree: false })).toBe(false);
    expect(canSubmitButton(submitButton, blocks, { code: "   ", slot: "a", notify: true, agree: true })).toBe(false);
    expect(canSubmitButton(submitButton, blocks, { code: "0042", slot: "disabled", notify: true, agree: true })).toBe(false);
    expect(canSubmitButton(submitButton, blocks, { code: "0042", slot: "a", notify: false, agree: true })).toBe(false);
    expect(canSubmitButton(submitButton, blocks, { code: "0042", slot: "a", notify: true, agree: true })).toBe(true);
    expect(canSubmitButton({ ...submitButton, enabled: false }, blocks, { code: "0042", slot: "a", notify: true, agree: true })).toBe(false);
  });

  test("merges collected fields first, then static button.payload, then consent: true", () => {
    const payload = buildButtonPayload(submitButton, blocks, { code: "0099", slot: "a", notify: true, agree: true });
    expect(payload).toEqual({
      code: "SERVER_FIXED",
      slotId: "a",
      notifyMe: true,
      agree: true,
      expectedVersion: 9,
      consent: true,
    });
  });

  test("resolves safe image URLs and rejects unsafe schemes", () => {
    expect(resolvePageImageUrl("/assets/hero.png", "https://prism.test/t/s/m")).toBe("https://prism.test/assets/hero.png");
    expect(resolvePageImageUrl("https://cdn.example.com/a.webp", "https://prism.test")).toBe("https://cdn.example.com/a.webp");
    expect(resolvePageImageUrl("http://localhost:5173/a.png", "http://localhost:5173/t/s/m")).toBe("http://localhost:5173/a.png");
    expect(resolvePageImageUrl("//evil.com/a.png", "https://prism.test")).toBeNull();
    expect(resolvePageImageUrl("http://evil.com/a.png", "https://prism.test")).toBeNull();
    expect(resolvePageImageUrl("javascript:alert(1)", "https://prism.test")).toBeNull();
    expect(resolvePageImageUrl("data:image/svg+xml,<svg/>", "https://prism.test")).toBeNull();
  });

  test("walks body and footer blocks together for forms and sticky footer buttons", () => {
    const footerSubmit: PageButton = {
      kind: "button",
      id: "checkout",
      label: "结账",
      style: "primary",
      action: "checkout.confirm",
      enabled: true,
      collect: ["note"],
      needsLocation: false,
    };
    const billBlock: PageBill = {
      kind: "bill",
      id: "bill",
      mode: "live",
      billingInputs: { playerId: "p1", billingSnapshot: {} },
      labels: {
        totalLabel: "合计",
        legendLabel: "图例",
        billingLegend: "计费",
        cappedLegend: "封顶中",
        settledTitle: "结账成功",
        balanceAfterLabel: "结账后余额",
        headings: { current: "现在", end: "结束计费", start: "开始计费", switch: "切换计费规则", over: "封顶结束" },
        capFullSuffix: "已满",
        capUntilLabel: "封顶到",
        newDayLabel: "新的一天",
        hourUnit: "小时",
        minuteUnit: "分钟",
        billingUnitLabel: "个计费单位",
        estimateError: "账单预估失败，请刷新后重试",
        retryLabel: "重试",
      },
    };
    const listBlock: PageList = {
      kind: "list",
      id: "history",
      items: [{
        id: "c1",
        group: "10月21日",
        title: "09:00 – 10:00",
        titleMeta: "1小时",
        subtitle: "资产结算",
        trailing: "12.00",
        trailingStrikethrough: "18.00",
        open: { view: "history", item: "c1" },
      }],
      emptyText: "暂无结账记录",
      emptyIcon: "receipt",
    };
    const page: Pick<Page, "blocks" | "footer"> = {
      blocks: [
        billBlock,
        listBlock,
        { kind: "input", id: "note", name: "note", required: true },
      ],
      footer: [footerSubmit],
    };
    const combined = allPageBlocks(page);
    expect(combined.map((entry) => entry.id)).toEqual(["bill", "history", "note", "checkout"]);
    expect(reconcileFieldValues(combined, {})).toEqual({ note: "" });
    expect(canSubmitButton(footerSubmit, combined, { note: "" })).toBe(false);
    expect(canSubmitButton(footerSubmit, combined, { note: "ok" })).toBe(true);
    expect(buildButtonPayload(footerSubmit, combined, { note: "ok" })).toEqual({ note: "ok" });
    expect(allPageBlocks({ blocks: [billBlock] }).map((entry) => entry.id)).toEqual(["bill"]);
  });
});
