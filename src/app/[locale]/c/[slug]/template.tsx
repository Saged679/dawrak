import { PageEnter } from "@/components/motion/page-enter";

// Clinic page <-> customer portal <-> payment pages.
export default function ClinicTemplate({ children }: { children: React.ReactNode }) {
  return <PageEnter className="flex min-h-0 flex-1 flex-col">{children}</PageEnter>;
}
