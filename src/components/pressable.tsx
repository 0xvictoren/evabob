"use client";

import { motion, type HTMLMotionProps } from "framer-motion";
import { settleSpring } from "@/lib/utils";
import { cn } from "@/lib/utils";

type PressableProps = HTMLMotionProps<"button"> & {
  bloom?: boolean;
};

export function Pressable({
  className,
  bloom = true,
  children,
  ...props
}: PressableProps) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      transition={settleSpring}
      className={cn(
        "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-violet/50",
        bloom && "active:shadow-bloom",
        className
      )}
      {...props}
    >
      {children}
    </motion.button>
  );
}
