import { PageEnter } from "@/components/motion/page-enter";

// Re-mounts on navigation between dashboard pages: only the content area transitions, never the shell.
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <PageEnter>{children}</PageEnter>;
}
