"use client";

import {
  CalendarDays,
  BookOpenText,
  ConciergeBell,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export type NavLink = { key: string; href: string; label: string };

const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  calendar: CalendarDays,
  customers: Users,
  services: ConciergeBell,
  providers: UserRound,
  knowledge: BookOpenText,
  conversations: MessagesSquare,
  revenue: Wallet,
  settings: Settings,
};

function isActive(pathname: string, href: string): boolean {
  return href === "/dashboard"
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

/** `variant="rail"` is the vertical desktop sidebar; `variant="tabs"` the scrollable mobile row. */
export function NavLinks({
  items,
  label,
  variant,
}: {
  items: NavLink[];
  label: string;
  variant: "rail" | "tabs";
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={variant === "tabs" ? "overflow-x-auto" : undefined}>
      <ul
        className={cn("flex gap-1", variant === "rail" ? "flex-col" : "w-max min-w-full px-4 py-2")}
      >
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = ICONS[item.key] ?? LayoutDashboard;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "m-nav-item flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/60",
                  active
                    ? "bg-sky text-cobalt-deep"
                    : "text-muted-foreground hover:bg-mist hover:text-ink",
                )}
              >
                <Icon className="m-nav-icon size-4" aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
