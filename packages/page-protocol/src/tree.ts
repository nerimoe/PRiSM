import type { PageBlock } from "./blocks";

/** Containers nested deeper than this are neither walked nor drawn. */
export const MAX_PAGE_DEPTH = 8;

/** Flattens container blocks (`section`, `row`) up to `maxDepth` levels. */
export function walkPageBlocks(blocks: readonly PageBlock[], maxDepth = MAX_PAGE_DEPTH): PageBlock[] {
  const out: PageBlock[] = [];
  const visit = (items: readonly PageBlock[], depth: number) => {
    if (depth >= maxDepth) return;
    for (const item of items) {
      out.push(item);
      if (item.kind === "section" || item.kind === "row") {
        visit(item.blocks, depth + 1);
      }
    }
  };
  visit(blocks, 0);
  return out;
}

/** Whether `block` is, or holds, the block with this id. */
export function containsBlock(block: PageBlock, id: string): boolean {
  return walkPageBlocks([block]).some((entry) => entry.id === id);
}
