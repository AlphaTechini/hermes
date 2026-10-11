import { ChevronRight } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";

export interface Crumb {
  label: ReactNode;
  to?: string;
}

/** Sets `document.title` to `<title> · Hermes`. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} · Hermes`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

interface PageHeaderProps {
  title: ReactNode;
  /** Plain string title used for document.title. Defaults to `title` when it is a string. */
  documentTitle?: string;
  subtitle?: ReactNode;
  /** Right-side actions (buttons, selects). They stack full width on mobile. */
  actions?: ReactNode;
  /** Breadcrumb trail above the title: `[{ label: "Live", to: "/live" }, { label: "A-10482" }]`. */
  crumbs?: Crumb[];
}

/** Page title 20/28 (18/24 on mobile), subtitle 13/20 secondary, actions on the right. Every page starts with this. */
export function PageHeader({ title, documentTitle, subtitle, actions, crumbs }: PageHeaderProps) {
  usePageTitle(documentTitle ?? (typeof title === "string" ? title : "Hermes"));
  return (
    <div className="page-head">
      <div className="t">
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i} className="row" style={{ gap: 6 }}>
                {i > 0 && <ChevronRight aria-hidden />}
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
