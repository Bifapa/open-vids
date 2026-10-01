/**
 * Menu and ContextMenu on Base UI. Dismissal is plain Base UI (capture-phase listeners survive the overlay's
 * `stopPropagation`); `trigger` is rendered, not wrapped; `container` exists for shadow roots.
 */

import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentPropsWithoutRef, ElementType, ReactElement, ReactNode } from "react";
import { cn } from "./cn";

/**
 * Base UI lets `className` be a function of the part's state. Studio's parts
 * merge a string with `cn`, so the string form is the one they accept.
 */
type StyledProps<T extends ElementType> = Omit<ComponentPropsWithoutRef<T>, "className"> & {
  className?: string;
};

/** Forces the settled open look for a gallery shot; CSS-only, open state stays controlled. */
export type PopupPreviewState = "open";

/** Where the portal puts the popup. `null` keeps it inline, next to its trigger. */
type PortalContainer = ComponentPropsWithoutRef<typeof BaseMenu.Portal>["container"];

/** Matches Tooltip's gap from its trigger, and its viewport margin. */
const SIDE_OFFSET = 6;
const VIEWPORT_MARGIN = 8;

/**
 * Enter and exit shared by menus, popovers, dropdowns, and tooltips.
 * The open duration class differs; the shape does not.
 * `data-starting-style`/`data-ending-style` are Base UI's transition attributes.
 */
export function floatingMotion(openDuration: "duration-open" | "duration-tooltip") {
  return cn(
    "origin-[var(--transform-origin)] outline-hidden",
    "transition-[opacity,transform] ease-out-quint",
    openDuration,
    "data-[ending-style]:duration-close data-[ending-style]:ease-in",
    "data-[starting-style]:[opacity:var(--popup-enter-opacity)]",
    "data-[starting-style]:[scale:var(--popup-enter-scale)]",
    "data-[ending-style]:opacity-0",
  );
}

/**
 * Chrome shared by every floating panel (`Popover`, `Select` too): the prototype's
 * translucent menu surface over a blur. Callers add their own shadow token.
 */
export const popupSurface = cn(
  "rounded-lg border border-border bg-menu-bg/94 backdrop-blur-xl backdrop-saturate-120",
  floatingMotion("duration-open"),
  "data-[preview-state=open]:opacity-100 data-[preview-state=open]:scale-100",
);

/** The popup's own layer: menus sit above panel chrome and below a modal. */
const POPUP_LAYER = "z-200";

const menuPopup = cn(popupSurface, "min-w-40 p-1 shadow-pop");

/**
 * One row: 24 px, filled with the accent while highlighted. `data-highlighted` is set
 * by keyboard and pointer alike, so the seen row is the Enter row. Icons, shortcuts
 * and indicators inside read `currentColor` or flip with `in-data-[highlighted]:`.
 */
export const menuItemBase = cn(
  "flex h-ctl-sm cursor-default select-none items-center justify-between gap-6 rounded-sm px-2",
  "text-sm whitespace-nowrap text-fg",
  "outline-hidden",
  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-ink",
  "data-[preview-state=hover]:bg-accent data-[preview-state=hover]:text-accent-ink",
  "data-[disabled]:pointer-events-none data-[disabled]:text-fg-disabled",
);

const itemDanger = cn(
  "text-error data-[highlighted]:bg-error data-[highlighted]:text-bg-0",
  "data-[preview-state=hover]:bg-error data-[preview-state=hover]:text-bg-0",
);

export type MenuItemTone = "default" | "danger";

interface PositionedProps {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** Portal target. Pass the shadow root when the trigger lives in one. */
  container?: PortalContainer;
  /** Names the popup for assistive tech. A menu with no name is unlabelled. */
  "aria-label"?: string;
  className?: string;
  "data-preview-state"?: PopupPreviewState;
}

interface MenuProps
  extends PositionedProps, Omit<ComponentPropsWithoutRef<typeof BaseMenu.Root>, "children"> {
  /** A single element. It becomes the trigger; no wrapper is added around it. */
  trigger: ReactElement;
  /** The items: `MenuItem`, `MenuRadioGroup`, `MenuSeparator`. */
  children: ReactNode;
}

/**
 * A menu opened by its trigger. Uncontrolled by default; pass `open` and
 * `onOpenChange` for a menu whose state lives in a store.
 */
export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  sideOffset = SIDE_OFFSET,
  container,
  className,
  "aria-label": ariaLabel,
  "data-preview-state": previewState,
  ...root
}: MenuProps) {
  return (
    <BaseMenu.Root {...root}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={VIEWPORT_MARGIN}
          className={POPUP_LAYER}
        >
          <BaseMenu.Popup
            aria-label={ariaLabel}
            data-preview-state={previewState}
            className={cn(menuPopup, className)}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

interface ContextMenuProps
  extends PositionedProps, Omit<ComponentPropsWithoutRef<typeof BaseContextMenu.Root>, "children"> {
  /**
   * The right-clickable area, as the caller's own element. Its children are
   * kept: the trigger renders that element rather than wrapping it.
   */
  trigger: ReactElement;
  children: ReactNode;
}

/** Opened by right click or long press at the pointer, so `side` and `align` are not offered. */
export function ContextMenu({
  trigger,
  children,
  container,
  className,
  "aria-label": ariaLabel,
  "data-preview-state": previewState,
  ...root
}: Omit<ContextMenuProps, "side" | "align" | "sideOffset">) {
  return (
    <BaseContextMenu.Root {...root}>
      <BaseContextMenu.Trigger render={trigger} />
      <BaseContextMenu.Portal container={container}>
        <BaseContextMenu.Positioner collisionPadding={VIEWPORT_MARGIN} className={POPUP_LAYER}>
          <BaseContextMenu.Popup
            aria-label={ariaLabel}
            data-preview-state={previewState}
            className={cn(menuPopup, className)}
          >
            {children}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}

/** Keyboard shortcut hint, dim and tabular; inks with the row while it is highlighted. */
export function MenuShortcut({ className, ...props }: StyledProps<"span">) {
  return (
    <span
      className={cn(
        "shrink-0 text-xs tracking-[0.04em] tabular-nums text-fg-3",
        "in-data-[highlighted]:text-current in-data-[preview-state=hover]:text-current",
        className,
      )}
      aria-hidden="true"
      {...props}
    />
  );
}

interface MenuItemProps extends StyledProps<typeof BaseMenu.Item> {
  /** Leading glyph, 14 px, dim until the row is highlighted. */
  icon?: ReactNode;
  /** Rendered as a dim hint on the trailing edge. Decorative. */
  shortcut?: string;
  /** `danger` for a destructive action (Delete, Remove). */
  tone?: MenuItemTone;
  "data-preview-state"?: "hover";
}

/** One action. `disabled` items are skipped by the arrow keys, not just dimmed. */
export function MenuItem({ icon, shortcut, tone, className, children, ...props }: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={cn(menuItemBase, tone === "danger" && itemDanger, className)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {icon ? (
          <span
            className="flex size-icon-md shrink-0 items-center justify-center text-fg-3 in-data-[highlighted]:text-current in-data-[disabled]:text-current"
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}
        <span className="truncate">{children}</span>
      </span>
      {shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null}
    </BaseMenu.Item>
  );
}

/** Single-choice group; selection is `aria-checked` on each item, which the dot indicator draws from. */
export function MenuRadioGroup(props: ComponentPropsWithoutRef<typeof BaseMenu.RadioGroup>) {
  return <BaseMenu.RadioGroup {...props} />;
}

interface MenuRadioItemProps extends StyledProps<typeof BaseMenu.RadioItem> {
  "data-preview-state"?: "hover";
}

/** One choice in a `MenuRadioGroup`. The dot renders only while it is checked. */
export function MenuRadioItem({ className, children, ...props }: MenuRadioItemProps) {
  return (
    <BaseMenu.RadioItem className={cn(menuItemBase, className)} {...props}>
      <span className="truncate">{children}</span>
      {/* Fixed box so a checked and an unchecked row keep the same width. */}
      <span className="flex size-3 shrink-0 items-center justify-center">
        <BaseMenu.RadioItemIndicator className="size-1.5 rounded-full bg-current" />
      </span>
    </BaseMenu.RadioItem>
  );
}

/** An on/off row; the tick renders only while `checked`. */
export function MenuCheckboxItem({
  className,
  children,
  ...props
}: StyledProps<typeof BaseMenu.CheckboxItem>) {
  return (
    <BaseMenu.CheckboxItem className={cn(menuItemBase, className)} {...props}>
      <span className="truncate">{children}</span>
      <span className="flex size-3 shrink-0 items-center justify-center">
        <BaseMenu.CheckboxItemIndicator>✓</BaseMenu.CheckboxItemIndicator>
      </span>
    </BaseMenu.CheckboxItem>
  );
}

/** A hairline between two groups of items. */
export function MenuSeparator({ className, ...props }: StyledProps<typeof BaseMenu.Separator>) {
  return <BaseMenu.Separator className={cn("mx-1.5 my-1 h-px bg-border", className)} {...props} />;
}

/** A labelled run of items; the label is `MenuGroupLabel`, which names the group for assistive tech. */
export function MenuGroup(props: ComponentPropsWithoutRef<typeof BaseMenu.Group>) {
  return <BaseMenu.Group {...props} />;
}

/** The dim heading over a `MenuGroup` ("Reveal", "Sort by"). Not an item: arrow keys skip it. */
export function MenuGroupLabel({ className, ...props }: StyledProps<typeof BaseMenu.GroupLabel>) {
  return (
    <BaseMenu.GroupLabel
      className={cn("px-2 pb-0.5 pt-1 text-xs text-fg-3", className)}
      {...props}
    />
  );
}
