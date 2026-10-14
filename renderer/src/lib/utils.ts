import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 基座的类名合并：条件类走 clsx，冲突的 utility 由 tailwind-merge 后者胜出 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
