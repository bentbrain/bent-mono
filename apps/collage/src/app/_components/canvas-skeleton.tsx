import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

export function CanvasSkeleton() {
  return (
    <Card className="w-full gap-2 bg-white p-2 sm:w-auto">
      <div className="flex w-full flex-col gap-2 sm:w-auto">
        <Skeleton className="h-12" />
        <div className="flex gap-2">
          <Skeleton className="hidden w-[200px] sm:block" />
          <Skeleton className="aspect-square w-full sm:size-[500px] 2xl:size-[800px]" />
        </div>
      </div>
    </Card>
  );
}
