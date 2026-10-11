import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent";
export type ButtonSize = "sm" | "md" | "lg";

interface Common {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. While `loading` it is replaced by a spinning `loader-circle`. */
  icon?: LucideIcon;
  /** Shows a spinner, disables the button. Pass `loadingLabel` ("Saving") to swap the label to the gerund. */
  loading?: boolean;
  loadingLabel?: ReactNode;
  /** Keyboard hint after the label, 11px mono at 60%: `kbd="A"`. */
  kbd?: string;
  /** Renders `.select` chevron (a Button used as a dropdown trigger, like "All strategies"). */
  select?: boolean;
}

/** Class string for anything that must look like a button (links, summary elements). */
export function buttonClasses({ variant = "secondary", size = "md", iconOnly = false, select = false }: { variant?: ButtonVariant; size?: ButtonSize; iconOnly?: boolean; select?: boolean } = {}): string {
  return cn("btn", `btn-${variant}`, size === "sm" && "btn-sm", size === "lg" && "btn-lg", iconOnly && "btn-icon", select && "select");
}

export type ButtonProps = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { children?: ReactNode };

/**
 * `<Button variant="primary" icon={Send} loading={saving} loadingLabel="Saving">Save changes</Button>`
 * Heights: sm 28, md 32, lg 40. Without children it is an icon-only square: give it `aria-label`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, loadingLabel, kbd, select, className, children, disabled, type = "button", ...rest },
  ref,
) {
  const iconOnly = children === undefined || children === null || children === false;
  const Lead = loading ? LoaderCircle : Icon;
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonClasses({ variant, size, iconOnly, select }), className)}
      disabled={disabled}
      data-loading={loading ? "true" : undefined}
      aria-busy={loading || undefined}
      {...rest}
      onClick={loading ? (e) => e.preventDefault() : rest.onClick}
      style={loading ? { pointerEvents: "none", ...rest.style } : rest.style}
    >
      {Lead && <Lead aria-hidden />}
      {!iconOnly && (loading && loadingLabel !== undefined ? loadingLabel : children)}
      {kbd && <span className="kbd-hint">{kbd}</span>}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "children" | "icon" | "kbd" | "loadingLabel" | "select"> {
  icon: LucideIcon;
  /** Required: becomes `aria-label` and the tooltip text. */
  label: string;
  tooltip?: boolean;
}

/** Icon-only button. Always has an aria-label and (by default) a tooltip, as DESIGN.md requires. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ icon, label, tooltip = true, variant = "ghost", size = "md", ...rest }, ref) {
  const btn = <Button ref={ref} variant={variant} size={size} icon={icon} aria-label={label} {...rest} />;
  return tooltip ? <Tooltip content={label}>{btn}</Tooltip> : btn;
});

export type ButtonLinkProps = Common & Omit<LinkProps, "children"> & { children?: ReactNode };

/** A router `<Link>` that looks like a button. */
export function ButtonLink({ variant = "secondary", size = "md", icon: Icon, kbd, select, className, children, ...rest }: ButtonLinkProps) {
  const iconOnly = children === undefined || children === null;
  return (
    <Link className={cn(buttonClasses({ variant, size, iconOnly, select }), className)} {...rest}>
      {Icon && <Icon aria-hidden />}
      {children}
      {kbd && <span className="kbd-hint">{kbd}</span>}
    </Link>
  );
}

export type ButtonAnchorProps = Common & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> & { children?: ReactNode };

/** A plain `<a>` styled as a button (external links). */
export function ButtonAnchor({ variant = "secondary", size = "md", icon: Icon, kbd, select, className, children, ...rest }: ButtonAnchorProps) {
  const iconOnly = children === undefined || children === null;
  return (
    <a className={cn(buttonClasses({ variant, size, iconOnly, select }), className)} {...rest}>
      {Icon && <Icon aria-hidden />}
      {children}
      {kbd && <span className="kbd-hint">{kbd}</span>}
    </a>
  );
}
