import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
// Button composition adapted from shadcn/ui (MIT); see THIRD_PARTY_NOTICES.md.
const buttonVariants = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      outline: "button-outline",
      ghost: "button-ghost",
      danger: "button-danger",
    },
  },
  defaultVariants: { variant: "default" },
});
export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={twMerge(clsx(buttonVariants({ variant }), className))}
      {...props}
    />
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="notice" role="status">
      {children}
    </div>
  );
}
export function Status({ value }: { value: string }) {
  const names: Record<string, string> = {
    queued: "等待开始",
    running: "进行中",
    paused: "已暂停",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
    interrupted: "待继续",
    full: "证据较充分",
    partial: "部分覆盖",
    not_found: "未找到披露",
    not_disclosed: "未披露",
    success: "已初评",
    need_verify: "待全文核验",
    needs_review: "待复核",
    conflicting: "存在矛盾",
    not_applicable: "不适用待核实",
    Yes: "Yes",
    N: "N",
  };
  return (
    <span className={"status status-" + value}>{names[value] || value}</span>
  );
}
