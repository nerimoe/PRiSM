import { ChevronRight, Inbox, Loader2, ReceiptText } from "lucide-react";
import type { PageList, PageListItem } from "@prism/page-protocol";
import { displayDateTime } from "../bill-time";
import { usePageContext } from "./page-context";

type ListGroup = { label: string; items: PageListItem[] };

function groupListItems(items: readonly PageListItem[]): ListGroup[] {
  const groups: ListGroup[] = [];
  for (const item of items) {
    const label = item.group ?? "";
    const prev = groups[groups.length - 1];
    if (prev && prev.label === label) {
      prev.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}

export function ListBlock({ block }: { block: PageList }) {
  const { openTarget, loadMore, loadingMoreId } = usePageContext();
  const loadingMore = loadingMoreId === block.id;
  const hasGroups = block.items.some((item) => Boolean(item.group));

  const renderRow = (item: PageListItem) => {
    const title = item.titleTimestamp ? displayDateTime(item.titleTimestamp, block.timeZone) : item.title;
    const subtitle = item.subtitleTimestamp
      ? `${item.subtitlePrefix ?? ""}${displayDateTime(item.subtitleTimestamp, block.timeZone)}`
      : item.subtitle;
    const content = (
      <>
        <span className="history-label">
          <span className="history-title-line">
            <strong>{title}</strong>
            {item.titleMeta && <span className="history-meta">{item.titleMeta}</span>}
          </span>
          {subtitle && <small>{subtitle}</small>}
        </span>
        {item.trailing !== undefined && (
          <span className="history-amount">
            <strong>{item.trailing}</strong>
            {item.trailingStrikethrough && <del>{item.trailingStrikethrough}</del>}
          </span>
        )}
        {item.open && <ChevronRight size={16} />}
      </>
    );
    return item.open ? (
      <button
        type="button"
        className="history-record focus-ring"
        key={item.id}
        onClick={() => openTarget?.(item.open!)}
      >
        {content}
      </button>
    ) : (
      <div className="history-record" key={item.id}>
        {content}
      </div>
    );
  };

  return (
    <div className="checkout-history">
      {hasGroups ? (
        <div className="history-groups">
          {groupListItems(block.items).map((group, index) => (
            <section className="history-group" key={`${index}-${group.label}`}>
              {group.label && <h3 className="history-group-label">{group.label}</h3>}
              <div className="history-group-card">{group.items.map(renderRow)}</div>
            </section>
          ))}
        </div>
      ) : (
        block.items.map(renderRow)
      )}
      {block.items.length === 0 && block.emptyText && (
        <div className="history-empty">
          {block.emptyIcon === "inbox" ? <Inbox size={36} /> : <ReceiptText size={36} />}
          <p>{block.emptyText}</p>
        </div>
      )}
      {block.moreTarget && block.moreLabel && (
        <button
          type="button"
          className="session-action"
          disabled={loadingMore}
          onClick={() => loadMore?.(block.id, block.moreTarget!)}
        >
          {loadingMore && <Loader2 className="animate-spin" size={16} />}
          {block.moreLabel}
        </button>
      )}
    </div>
  );
}
