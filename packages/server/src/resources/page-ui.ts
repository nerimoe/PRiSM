import type {
  PageBanner, PageBlock, PageButton, PageConsent, PageDivider, PageImage, PageInputField, PageKeyValue,
  PageKeyValueItem, PageRow, PageSection, PageSelectField, PageSelectOption, PageText, PageToggleField,
} from "@prism/page-protocol";

/** Builds page blocks, leaving out what was not given. The platform's own pages are made with these too. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export const pageUi = {
  section(
    id: string,
    blocks: PageBlock[],
    opts: Omit<PageSection, "kind" | "id" | "blocks"> = {},
  ): PageSection {
    return compact({ kind: "section", id, ...opts, blocks });
  },

  row(id: string, blocks: PageBlock[]): PageRow {
    return { kind: "row", id, blocks };
  },

  text(
    id: string,
    text: string,
    opts: Omit<PageText, "kind" | "id" | "text"> = {},
  ): PageText {
    return compact({ kind: "text", id, text, ...opts });
  },

  kv(id: string, items: PageKeyValueItem[]): PageKeyValue {
    return {
      kind: "kv",
      id,
      items: items.map((item) => compact(item)),
    };
  },

  banner(
    id: string,
    body: string,
    opts: Omit<PageBanner, "kind" | "id" | "body"> = {},
  ): PageBanner {
    return compact({ kind: "banner", id, body, ...opts });
  },

  divider(id: string): PageDivider {
    return { kind: "divider", id };
  },

  image(
    id: string,
    url: string,
    opts: Omit<PageImage, "kind" | "id" | "url"> = {},
  ): PageImage {
    return compact({ kind: "image", id, url, ...opts });
  },

  input(
    id: string,
    opts: Omit<PageInputField, "kind" | "id"> = {},
  ): PageInputField {
    return compact({ kind: "input", id, ...opts });
  },

  select(
    id: string,
    options: PageSelectOption[],
    opts: Omit<PageSelectField, "kind" | "id" | "options"> = {},
  ): PageSelectField {
    return compact({
      kind: "select",
      id,
      ...opts,
      options: options.map((opt) => compact(opt)),
    });
  },

  toggle(
    id: string,
    label: string,
    opts: Omit<PageToggleField, "kind" | "id" | "label"> = {},
  ): PageToggleField {
    return compact({ kind: "toggle", id, label, ...opts });
  },

  consent(id: string, text: string): PageConsent {
    return { kind: "consent", id, text };
  },

  button(
    id: string,
    label: string,
    action: string,
    opts: Omit<PageButton, "kind" | "id" | "label" | "action" | "enabled" | "needsLocation"> & {
      enabled?: boolean;
      needsLocation?: boolean;
    } = {},
  ): PageButton {
    return compact({
      kind: "button",
      id,
      label,
      action,
      ...opts,
      enabled: opts.enabled ?? true,
      needsLocation: opts.needsLocation ?? false,
    });
  },
};
