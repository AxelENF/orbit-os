import { AppShell } from "@/components/layout/app-shell";

export default function ContentOsLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
