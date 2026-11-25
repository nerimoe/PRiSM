import type { PageBlock, PageButton, PageConsent, PageInputField, PageSelectField, PageToggleField } from "./blocks";
import { walkPageBlocks } from "./tree";

export type PageFieldValue = string | boolean;

export type PageFieldBlock = PageInputField | PageSelectField | PageToggleField | PageConsent;

export function isFieldBlock(block: PageBlock): block is PageFieldBlock {
  return block.kind === "input" || block.kind === "select" || block.kind === "toggle" || block.kind === "consent";
}

function defaultFieldValue(field: PageFieldBlock): PageFieldValue {
  switch (field.kind) {
    case "input":
    case "select":
      return typeof field.defaultValue === "string" ? field.defaultValue : "";
    case "toggle":
      return typeof field.defaultValue === "boolean" ? field.defaultValue : false;
    case "consent":
      return false;
  }
}

/** Keeps live field edits, initializes newly visible fields from `defaultValue`, and prunes removed IDs. */
export function reconcileFieldValues(
  blocks: readonly PageBlock[],
  current: Record<string, PageFieldValue>,
): Record<string, PageFieldValue> {
  const next: Record<string, PageFieldValue> = {};
  for (const block of walkPageBlocks(blocks)) {
    if (!isFieldBlock(block)) continue;
    const expectedType = block.kind === "toggle" || block.kind === "consent" ? "boolean" : "string";
    const existing = current[block.id];
    next[block.id] = typeof existing === expectedType ? existing : defaultFieldValue(block);
  }
  return next;
}

function blockIndex(blocks: readonly PageBlock[]): Map<string, PageBlock> {
  const byId = new Map<string, PageBlock>();
  for (const block of walkPageBlocks(blocks)) {
    if (!byId.has(block.id)) byId.set(block.id, block);
  }
  return byId;
}

export function canSubmitButton(
  button: PageButton,
  blocks: readonly PageBlock[],
  values: Record<string, PageFieldValue>,
): boolean {
  if (!button.enabled) return false;
  if (button.requires && values[button.requires] !== true) return false;
  if (!button.collect?.length) return true;
  const byId = blockIndex(blocks);
  for (const id of button.collect) {
    const field = byId.get(id);
    if (!field || !isFieldBlock(field)) continue;
    const value = values[field.id] ?? defaultFieldValue(field);
    switch (field.kind) {
      case "consent":
        if (value !== true) return false;
        break;
      case "toggle":
        if (field.required && value !== true) return false;
        break;
      case "input":
        if (field.required && (typeof value !== "string" || value.trim().length === 0)) return false;
        break;
      case "select":
        if (field.required) {
          if (typeof value !== "string") return false;
          const option = field.options.find((entry) => entry.value === value);
          if (!option || option.disabled) return false;
        }
        break;
    }
  }
  return true;
}

/** Builds action payload: collected form values first, then static `button.payload`, then `consent: true` when `requires` is set. */
export function buildButtonPayload(
  button: PageButton,
  blocks: readonly PageBlock[],
  values: Record<string, PageFieldValue>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let hasAny = false;
  if (button.collect?.length) {
    const byId = blockIndex(blocks);
    for (const id of button.collect) {
      const field = byId.get(id);
      if (!field || !isFieldBlock(field)) continue;
      const key = field.kind === "consent" ? field.id : (field.name || field.id);
      out[key] = values[field.id] ?? defaultFieldValue(field);
      hasAny = true;
    }
  }
  if (button.payload) {
    Object.assign(out, button.payload);
    hasAny = true;
  }
  if (button.requires) {
    out.consent = true;
    hasAny = true;
  }
  return hasAny ? out : undefined;
}
