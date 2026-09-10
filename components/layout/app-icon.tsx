import type { ReactNode, SVGProps } from "react";

type IconName = "home" | "campaigns" | "plus" | "review" | "results" | "chevron" | "spark" | "menu" | "close" | "arrow" | "check";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-6h6v6" /></>,
  campaigns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 8h10M7 12h6M7 16h3" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  review: <><path d="m5 12 4 4L19 6" /><rect x="3" y="3" width="18" height="18" rx="4" /></>,
  results: <><path d="M5 19V9M12 19V5M19 19v-7" /><path d="M3 19h18" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>,
  check: <path d="m5 12 4 4L19 6" />,
};

export function AppIcon({ name, size = 18, strokeWidth = 1.8, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number; strokeWidth?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...props}>
      {paths[name]}
    </svg>
  );
}

export type { IconName };
