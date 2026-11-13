import {
  CheckCheck,
  CircleCheck,
  Hourglass,
  UserX,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AppointmentStatus } from "@/lib/auth/roles";

/**
 * Status is never colour alone: every status has its own icon shape and a text label
 * (the block always prints the label; the dashed / struck styles are extra cues).
 */
export const STATUS_STYLE: Record<
  AppointmentStatus,
  { icon: LucideIcon; box: string; chip: string }
> = {
  confirmed: {
    icon: CircleCheck,
    box: "border-cobalt bg-sky text-cobalt-deep",
    chip: "border-cobalt bg-sky text-cobalt-deep",
  },
  pending_payment: {
    icon: Hourglass,
    box: "border-dashed border-[#b8741a] bg-saffron-soft text-[#6b3f00]",
    chip: "border-dashed border-[#b8741a] bg-saffron-soft text-[#6b3f00]",
  },
  completed: {
    icon: CheckCheck,
    box: "border-[#1d7a5f] bg-[#dff3ec] text-[#0f4d3b]",
    chip: "border-[#1d7a5f] bg-[#dff3ec] text-[#0f4d3b]",
  },
  no_show: {
    icon: UserX,
    box: "border-[#b3261e] bg-[#fde8e6] text-[#7a1712]",
    chip: "border-[#b3261e] bg-[#fde8e6] text-[#7a1712]",
  },
  cancelled: {
    icon: XCircle,
    box: "border-dashed border-line bg-paper text-muted-foreground line-through",
    chip: "border-dashed border-line bg-paper text-muted-foreground",
  },
};

export function StatusBadge({
  status,
  label,
  className,
}: {
  status: AppointmentStatus;
  label: string;
  className?: string;
}) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        s.chip,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
