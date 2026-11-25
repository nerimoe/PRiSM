import { containsBlock, MAX_PAGE_DEPTH, type PageBlock } from "@prism/page-protocol";
import { ResourcePricing, type ResourceRules } from "../ResourcePricing";
import { PlatformBinding, SessionSignIn } from "../SessionContent";
import { ButtonBlock } from "./ButtonBlock";
import { CardsBlock } from "./cards/CardsBlock";
import { ClimateBlock } from "./ClimateBlock";
import { BannerBlock, ImageBlock, KeyValueBlock, RowBlock, SectionBlock, TableBlock, TextBlock } from "./ContentBlocks";
import { ConsentBlock, InputBlock, SelectBlock, ToggleBlock } from "./FieldBlocks";
import { usePageContext } from "./page-context";

export function BlockList({ blocks, depth }: { blocks: PageBlock[]; depth: number }) {
  return <>{blocks.map((block) => <BlockView key={block.id} block={block} depth={depth} />)}</>;
}

/** Which component draws which kind. A new kind is one component and one line here. */
function BlockView({ block, depth }: { block: PageBlock; depth: number }) {
  const { page, soleBlockId } = usePageContext();
  if (depth >= MAX_PAGE_DEPTH || (soleBlockId && !containsBlock(block, soleBlockId))) return null;
  switch (block.kind) {
    case "text": return <TextBlock block={block} />;
    case "section": return <SectionBlock block={block} depth={depth} />;
    case "row": return <RowBlock block={block} depth={depth} />;
    case "kv": return <KeyValueBlock block={block} />;
    case "banner": return <BannerBlock block={block} />;
    case "divider": return <hr className="page-divider" />;
    case "image": return <ImageBlock block={block} />;
    case "input": return <InputBlock block={block} />;
    case "select": return <SelectBlock block={block} />;
    case "toggle": return <ToggleBlock block={block} />;
    case "consent": return <ConsentBlock block={block} />;
    case "button": return <ButtonBlock block={block} />;
    case "signin": return <SessionSignIn methods={block.methods} />;
    case "binding": return <PlatformBinding code={page.shopCode} labels={block} />;
    case "pricing":
      return <ResourcePricing rules={block.rules as ResourceRules} changes={(block.changes ?? undefined) as Parameters<typeof ResourcePricing>[0]["changes"]} labels={block.labels} />;
    case "climate": return <ClimateBlock block={block} />;
    case "table": return <TableBlock block={block} />;
    case "cards": return <CardsBlock block={block} />;
    // A kind this version does not know yet.
    default: return null;
  }
}
