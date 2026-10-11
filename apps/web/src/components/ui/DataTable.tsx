import { useMemo, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "../../lib/cn";
import { Skeleton } from "./Skeleton";

export interface Column<Row> {
  /** Stable key. */
  key: string;
  /** Header cell content (sentence case). */
  header: ReactNode;
  /** Cell renderer. */
  cell: (row: Row, index: number) => ReactNode;
  /** Numeric column: right aligned, mono 12, tabular figures. */
  numeric?: boolean;
  /** Mono text without right alignment (ids, hashes). */
  mono?: boolean;
  /** Hidden below 768px instead of scrolling (`hide-sm` in the prototype). */
  hideSm?: boolean;
  /** Fixed width in px or CSS. */
  width?: number | string;
  /** Allow wrapping (long text); otherwise cells never wrap. */
  wrap?: boolean;
  className?: string;
  /** Title (tooltip) for the header cell. */
  title?: string;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row, index: number) => string;
  /** `default` rows 40, `compact` 36, `two-line` 48 (cells with a sub-line). */
  density?: "default" | "compact" | "two-line";
  /** Click handler. Makes rows clickable (pointer, hover, Enter key). Prefer `rowHref` for navigation. */
  onRowClick?: (row: Row, index: number) => void;
  /** Navigates on click. The first cell gets a real `<a>` so keyboard and middle-click work. */
  rowHref?: (row: Row) => string | undefined;
  /** Header stays visible while the body scrolls. Combine with `maxHeight`. */
  stickyHeader?: boolean;
  /** Makes the table body scroll vertically inside the card. */
  maxHeight?: number | string;
  /** Shown instead of the table when `rows` is empty and not loading (usually an <EmptyState>). */
  empty?: ReactNode;
  /** Render `skeletonRows` placeholder rows with the same columns. */
  loading?: boolean;
  skeletonRows?: number;
  /** Extra class for a row (e.g. `hm-row-in` on a new row). */
  rowClassName?: (row: Row, index: number) => string | undefined;
  /** Accessible name for the table. */
  "aria-label"?: string;
  className?: string;
}

/**
 * Dense data table matching `table.t`: header 32, rows 40/36/48, hairline row dividers, hover `bg-hover`, first and
 * last cells padded 16. Numeric columns right aligned in mono. Secondary columns hide on mobile.
 *
 *   <DataTable aria-label="Open positions" rows={positions} rowKey={p => p.market}
 *     columns={[
 *       { key: "m", header: "Market", cell: p => <MarketChip market={p.market} /> },
 *       { key: "s", header: "Size", numeric: true, cell: p => formatSize(p.size, p.market) },
 *       { key: "n", header: "Notional", numeric: true, hideSm: true, cell: p => formatUsd(p.notionalUsd) },
 *     ]} />
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  density = "default",
  onRowClick,
  rowHref,
  stickyHeader,
  maxHeight,
  empty,
  loading,
  skeletonRows = 4,
  rowClassName,
  className,
  ...aria
}: DataTableProps<Row>) {
  const navigate = useNavigate();
  const clickable = Boolean(onRowClick || rowHref);
  const showEmpty = !loading && rows.length === 0 && empty !== undefined;

  const wrapStyle: CSSProperties | undefined = maxHeight ? { maxHeight, overflowY: "auto" } : undefined;
  const colStyle = (c: Column<Row>): CSSProperties | undefined => (c.width !== undefined ? { width: c.width } : undefined);

  const cellClass = (c: Column<Row>) => cn(c.numeric && "num", c.mono && !c.numeric && "mono", c.hideSm && "hide-sm", c.wrap && "wrap-cell", c.className);

  const handleClick = (e: MouseEvent<HTMLTableRowElement>, row: Row, i: number) => {
    if ((e.target as HTMLElement).closest("a, button, input, label, select, textarea")) return;
    if (onRowClick) onRowClick(row, i);
    else {
      const href = rowHref?.(row);
      if (href) navigate(href);
    }
  };
  const handleKey = (e: KeyboardEvent<HTMLTableRowElement>, row: Row, i: number) => {
    if (e.key !== "Enter" || e.target !== e.currentTarget) return;
    if (onRowClick) onRowClick(row, i);
    else {
      const href = rowHref?.(row);
      if (href) navigate(href);
    }
  };

  const body = useMemo(() => {
    if (loading) {
      return Array.from({ length: skeletonRows }, (_, r) => (
        <tr key={`sk-${r}`} aria-hidden>
          {columns.map((c) => (
            <td key={c.key} className={cellClass(c)}>
              <Skeleton w={c.numeric ? 56 : 72} h={12} style={c.numeric ? { marginLeft: "auto" } : undefined} />
            </td>
          ))}
        </tr>
      ));
    }
    return rows.map((row, i) => {
      const href = rowHref?.(row);
      return (
        <tr
          key={rowKey(row, i)}
          className={cn(clickable && "clickable", rowClassName?.(row, i))}
          tabIndex={onRowClick && !href ? 0 : undefined}
          onClick={clickable ? (e) => handleClick(e, row, i) : undefined}
          onKeyDown={clickable ? (e) => handleKey(e, row, i) : undefined}
        >
          {columns.map((c, ci) => {
            const content = c.cell(row, i);
            return (
              <td key={c.key} className={cellClass(c)}>
                {ci === 0 && href ? (
                  <Link to={href} className="hm-focus" style={{ display: "inline-flex", alignItems: "center", color: "inherit" }}>
                    {content}
                  </Link>
                ) : (
                  content
                )}
              </td>
            );
          })}
        </tr>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns, loading, skeletonRows, clickable, rowHref, onRowClick, rowKey, rowClassName]);

  if (showEmpty) return <>{empty}</>;

  return (
    <div className={cn("table-wrap", className)} style={wrapStyle}>
      <table className={cn("t", density === "compact" && "compact", density === "two-line" && "two-line", stickyHeader && "sticky-head")} aria-label={aria["aria-label"]}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn(c.numeric && "num", c.hideSm && "hide-sm")} style={colStyle(c)} title={c.title} scope="col">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}
