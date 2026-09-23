import { Toaster as Sonner } from "sonner";
import { Phantom } from "@/components/brand/Phantom";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Success / error / warning / info / loading toasts carry a tiny Phantom with the matching face.
const ghostIcons: ToasterProps["icons"] = {
  success: <Phantom expression="success" size="xs" />,
  error: <Phantom expression="error" size="xs" />,
  warning: <Phantom expression="warning" size="xs" />,
  info: <Phantom expression="idle" size="xs" />,
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
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
