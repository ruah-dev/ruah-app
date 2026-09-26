import { Toaster as Sonner } from "sonner";
import { Phantom } from "@/components/brand/Phantom";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Success / error / warning / info / loading toasts carry a tiny Phantom with the matching face,
// and (design-system alert style) a 3 px edge in the role's colour so the kind reads at a glance.
const ghostIcons: ToasterProps["icons"] = {
  success: <Phantom expression="success" size="xs" />,
  error: <Phantom expression="error" size="xs" />,
  warning: <Phantom expression="warning" size="xs" />,
  info: <Phantom expression="idle" tone="info" size="xs" />,
  loading: <Phantom expression="loading" size="xs" />,
};

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      icons={ghostIcons}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:rounded-xl group-[.toaster]:bg-popover group-[.toaster]:text-foreground group-[.toaster]:border-hairline group-[.toaster]:shadow-elevated",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          success: "group-[.toaster]:border-l-[3px] group-[.toaster]:border-l-ok",
          error: "group-[.toaster]:border-l-[3px] group-[.toaster]:border-l-bad",
          warning: "group-[.toaster]:border-l-[3px] group-[.toaster]:border-l-warn",
          info: "group-[.toaster]:border-l-[3px] group-[.toaster]:border-l-info",
          loading: "group-[.toaster]:border-l-[3px] group-[.toaster]:border-l-brand",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
