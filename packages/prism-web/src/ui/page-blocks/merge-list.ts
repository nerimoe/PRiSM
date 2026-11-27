import { MAX_PAGE_DEPTH, walkPageBlocks, type PageBlock, type PageList } from "@prism/page-protocol";

function mergeListIntoBlocks(
  blocks: readonly PageBlock[],
  blockId: string,
  replacement: PageList,
  depth: number,
): PageBlock[] {
  if (depth >= MAX_PAGE_DEPTH) return [...blocks];
  return blocks.map((block) => {
    if (block.kind === "list" && block.id === blockId) {
      const seen = new Set(block.items.map((item) => item.id));
      return {
        ...replacement,
        items: [...block.items, ...replacement.items.filter((item) => !seen.has(item.id))],
      };
    }
    if (block.kind === "section" || block.kind === "row") {
      return {
        ...block,
        blocks: mergeListIntoBlocks(block.blocks, blockId, replacement, depth + 1),
      };
    }
    return block;
  });
}

/** Appends deduplicated items from a paginated page response into the matching `list` block. */
export function mergeListBlocks(
  current: readonly PageBlock[],
  incoming: readonly PageBlock[],
  blockId: string,
): PageBlock[] {
  const replacement = walkPageBlocks(incoming).find(
    (block): block is PageList => block.kind === "list" && block.id === blockId,
  );
  if (!replacement) return [...current];
  return mergeListIntoBlocks(current, blockId, replacement, 0);
}
