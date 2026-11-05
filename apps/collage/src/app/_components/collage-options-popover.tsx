import { Button, type ButtonProps } from "@/app/_components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/_components/ui/popover";
import { Ellipsis } from "lucide-react";
import DeleteButton from "./delete-button";
import DownloadUrlButton from "./download-url-button";
import EditButton from "./edit-button";
import PublicButton from "./public-button";
type CollageOptionsPopoverProps = {
  collageId: number;
  canvasUserId: string;
  userId: string;
  imageUrl: string;
  isPublic: boolean;
  refresh?: boolean;
} & ButtonProps;

function CollageOptionsPopover({
  collageId,
  canvasUserId,
  userId,
  isPublic,
  imageUrl,
  refresh,
  ...props
}: CollageOptionsPopoverProps) {
  const isOwner = canvasUserId === userId;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size={"icon"} {...props}>
          <Ellipsis className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex flex-col gap-2">
          {isOwner && (
            <>
              <PublicButton
                isPublic={isPublic}
                canvasId={collageId}
                userId={userId}
                refresh={refresh}
                {...props}
              />
              <EditButton userId={userId} collageID={collageId} {...props} />
            </>
          )}
          <DownloadUrlButton url={imageUrl} {...props} />
          {isOwner && (
            <DeleteButton collageId={collageId} userId={userId} {...props} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default CollageOptionsPopover;
