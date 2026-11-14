import { PageEnter } from "@/components/motion/page-enter";

// Re-mounts on navigation between top-level sections (landing, demo, login, clinic, dashboard).
export default function LocaleTemplate({ children }: { children: React.ReactNode }) {
  return <PageEnter className="flex min-h-0 flex-1 flex-col">{children}</PageEnter>;
}
