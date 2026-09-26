// The dialog behind lib/confirm.ts: mounted once in the root layout.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { settleConfirm, useConfirmRequest } from "@/lib/confirm";
import { cn } from "@/lib/utils";

export function ConfirmHost() {
  const request = useConfirmRequest();
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && settleConfirm(false)}>
      {request !== null ? (
        <AlertDialogContent key={request.id} className="max-w-sm rounded-xl border-hairline bg-popover p-5">
          <AlertDialogHeader>
            <AlertDialogTitle className="heading text-title">{request.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-ui">{request.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 rounded-lg border-hairline bg-transparent text-ui">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn("h-8 rounded-lg text-ui", request.destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => settleConfirm(true)}
            >
              {request.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
