import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../_components/ui/card";

function Page() {
  return (
    <div className="grid size-full place-items-center">
      <Card className="container mx-auto max-w-sm">
        <CardHeader>
          <CardTitle>🤔 Couldn&apos;t find that one</CardTitle>
        </CardHeader>
        <CardContent>
          <p>The page you are looking for does not exist.</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default Page;
