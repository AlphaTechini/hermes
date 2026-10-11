import { Check, Copy } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { highlightJson, prettyJson } from "../../lib/json-highlight";
import { cn } from "../../lib/cn";
import { Button, IconButton } from "./Button";
import { useCopy } from "./hooks";

export interface CodeBlockProps {
  /** Source text. JSON is highlighted: keys, strings, numbers, literals, `// comments` and `{{placeholders}}`. */
  code: string;
  /** Head left: file or section name (12/500 secondary). */
  title?: ReactNode;
  /** Head meta (11 mono muted): `mt 22`, `from TradingView`. */
  meta?: ReactNode;
  /** Replaces title and meta entirely (e.g. a SegmentedControl). */
  headerLeft?: ReactNode;
  /** The text to copy. Defaults to `code`. Use this to copy the REAL secret while the display shows it masked. */
  copyValue?: string;
  /** Labeled secondary button ("Copy message") instead of the icon button. */
  copyLabel?: string;
  /** Copy button aria-label for the icon form. */
  copyAriaLabel?: string;
  /** Hide the copy button. */
  noCopy?: boolean;
  /** Extra head actions, before the copy button. */
  actions?: ReactNode;
  /** Plain text without JSON coloring. */
  plain?: boolean;
  /** Wrap long lines (default: never wrap JSON, scroll horizontally). */
  wrap?: boolean;
  className?: string;
}

/**
 * `bg-sunken` block with a 36px head and highlighted body. Copying always copies the real value:
 *   <CodeBlock title="Message" meta="includes your secret" code={maskedJson} copyValue={realJson} copyLabel="Copy message" />
 */
export function CodeBlock({ code, title, meta, headerLeft, copyValue, copyLabel, copyAriaLabel, noCopy, actions, plain, wrap, className }: CodeBlockProps) {
  const { copied, copy } = useCopy();
  const lines = useMemo(() => (plain ? null : highlightJson(code)), [code, plain]);
  const hasHead = headerLeft || title || meta || !noCopy || actions;
  const doCopy = () => copy(copyValue ?? code);
  return (
    <div className={cn("code", className)}>
      {hasHead && (
        <div className="code-head">
          {headerLeft ?? (
            <>
              {title && <span className="n">{title}</span>}
              {meta && <span className="m">{meta}</span>}
            </>
          )}
          <div className="actions">
            {actions}
            {!noCopy &&
              (copyLabel ? (
                <Button size="sm" variant="secondary" icon={copied ? Check : Copy} onClick={doCopy}>
                  {copied ? "Copied" : copyLabel}
                </Button>
              ) : (
                <IconButton size="sm" icon={copied ? Check : Copy} label={copied ? "Copied" : (copyAriaLabel ?? "Copy")} onClick={doCopy} />
              ))}
          </div>
        </div>
      )}
      <pre className={cn("hm-code", wrap && "wrap-lines")} tabIndex={0}>
        {lines
          ? lines.map((line, i) => (
              <span key={i}>
                {line.map((t, k) => (t.cls ? <span key={k} className={t.cls}>{t.text}</span> : t.text))}
                {i < lines.length - 1 ? "\n" : ""}
              </span>
            ))
          : code}
      </pre>
    </div>
  );
}

export { prettyJson };
